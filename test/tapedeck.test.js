import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CassetteError, parseCassette } from "../src/cassette.js";
import { sanitiseDraft } from "../src/ingest.js";
import { isSecretName, scrubText } from "../src/secrets.js";
import { compareExchange, ReplayEngine, waitForDelay } from "../src/replay.js";

const fixture = async (name) => JSON.parse(await readFile(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));
const request = (method, path, query = {}, body = null, headers = {}) => ({ method, path, query, body, headers });

test("draft ingestion removes secret fields and replaces unstable values", async () => {
  const cassette = sanitiseDraft(await fixture("travel-search-draft"));
  const serialised = JSON.stringify(cassette);
  assert.equal(cassette.capturePolicy.reviewed, false);
  assert.equal(cassette.capturePolicy.redactions.length, 5);
  assert.doesNotMatch(serialised, /synthetic-recording-secret|synthetic-body-secret|synthetic-response-secret|synthetic-api-key|remove-me/);
  assert.doesNotMatch(serialised, /observed-session-94271|2026-07-24T04:16:09.813Z/);
  assert.match(serialised, /\{\{sessionId\}\}/);
  assert.equal(cassette.variables.sessionId.value, "session-demo-001");
});

test("draft ingestion removes secret headers and credentials embedded in values", async () => {
  const draft = await fixture("travel-search-draft");
  Object.assign(draft.exchanges[0].request.headers, { "x-auth-token": "leak-header-1", "api-key": "leak-header-2", "x-amz-security-token": "leak-header-3", "x-debug-context": "Bearer leak-bearer-value-000000" });
  Object.assign(draft.exchanges[0].request.body, {
    privateKey: "leak-body-1",
    callback: "https://example.test/cb?state=keep&access_token=leak-query-1#id_token=leak-fragment-1",
    note: "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl and key AKIAABCDEFGHIJKLMNOP"
  });
  draft.exchanges[1].response.body.deploy = "-----BEGIN RSA PRIVATE KEY-----\nleak-pem\n-----END RSA PRIVATE KEY-----";
  const cassette = sanitiseDraft(draft);
  const serialised = JSON.stringify(cassette);
  assert.doesNotMatch(serialised, /leak-|eyJhbGciOiJIUzI1NiJ9|AKIAABCDEFGHIJKLMNOP/);
  const body = cassette.exchanges[0].request.body;
  assert.equal(body.callback, "https://example.test/cb?state=keep&access_token=REDACTED#id_token=REDACTED");
  assert.equal(body.note, "jwt REDACTED and key REDACTED");
  assert.equal(cassette.exchanges[0].request.headers["x-debug-context"], "Bearer REDACTED");
  for (const expected of [
    "exchange.create-search.request.headers.x-auth-token",
    "exchange.create-search.request.headers.api-key",
    "exchange.create-search.request.headers.x-amz-security-token",
    "exchange.create-search.request.headers.x-debug-context (bearer token)",
    "exchange.create-search.request.body.privateKey",
    "exchange.create-search.request.body.callback (query parameter access_token)",
    "exchange.create-search.request.body.note (JSON Web Token)",
    "exchange.create-search.request.body.note (AWS access key)",
    "exchange.poll-search-one.response.body.deploy (private key)"
  ]) assert.ok(cassette.capturePolicy.redactions.includes(expected), expected);
});

test("reviewed cassette replays a stable sequence with subset body matching", async () => {
  const cassette = parseCassette(await fixture("published-cassette"));
  const engine = new ReplayEngine(cassette);
  const firstInput = request("POST", "/sessions", {}, { origin: "MEL", destination: "HBA", ignoredClientField: true }, { "content-type": "application/json" });
  const first = engine.prepare(firstInput);
  assert.equal(first.ok, true);
  assert.equal(first.response.delay.ms, 140);
  assert.deepEqual(engine.commit(first.token, firstInput).body, { sessionId: "session-demo-001", status: "searching", generatedAt: "2026-07-24T00:00:00.000Z" });
  const secondInput = request("GET", "/sessions/session-demo-001", { attempt: "1" });
  const second = engine.prepare(secondInput);
  assert.equal(second.ok, true);
  engine.commit(second.token, secondInput);
  const thirdInput = request("GET", "/sessions/session-demo-001", { attempt: "2" });
  const third = engine.prepare(thirdInput);
  assert.equal(third.ok, true);
  const final = engine.commit(third.token, thirdInput);
  assert.equal(final.body.itinerary.priceAud, 189);
  assert.equal(engine.snapshot().cursor, 3);
});

test("unmatched and out-of-order requests return field-level nearest diagnostics", async () => {
  const engine = new ReplayEngine(parseCassette(await fixture("published-cassette")));
  const result = engine.prepare(request("GET", "/sessions/session-demo-001", { attempt: "1" }));
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.diagnostic.reason, "Request matches a later exchange and arrived out of order");
  assert.equal(result.diagnostic.expectedExchange.id, "create-search");
  assert.equal(result.diagnostic.nearest.id, "poll-search-one");
  assert.ok(result.diagnostic.differences.some((difference) => difference.field === "method"));
});

test("retried exchanges are reported as repeats, not as out-of-order requests", async () => {
  const engine = new ReplayEngine(parseCassette(await fixture("published-cassette")));
  const inputs = [
    request("POST", "/sessions", {}, { origin: "MEL", destination: "HBA" }, { "content-type": "application/json" }),
    request("GET", "/sessions/session-demo-001", { attempt: "1" }),
    request("GET", "/sessions/session-demo-001", { attempt: "2" })
  ];
  const first = engine.prepare(inputs[0]);
  engine.commit(first.token, inputs[0]);
  const retry = engine.prepare(inputs[0]);
  assert.equal(retry.ok, false);
  assert.match(retry.diagnostic.reason, /repeats an exchange that has already been replayed/);
  assert.equal(retry.diagnostic.expectedExchange.id, "poll-search-one");
  assert.equal(retry.diagnostic.nearest.position, 1);

  for (const input of inputs.slice(1)) {
    const prepared = engine.prepare(input);
    engine.commit(prepared.token, input);
  }
  const afterEnd = engine.prepare(inputs[2]);
  assert.match(afterEnd.diagnostic.reason, /already complete and this request repeats/);
  assert.equal(afterEnd.diagnostic.expectedExchange, null);
  assert.equal(afterEnd.diagnostic.nearest.position, 3);
  assert.deepEqual(afterEnd.diagnostic.differences, []);
});

test("history records each request at the sequence position it was judged against", async () => {
  const engine = new ReplayEngine(parseCassette(await fixture("published-cassette")));
  const input = request("POST", "/sessions", {}, { origin: "MEL", destination: "HBA" }, { "content-type": "application/json" });
  const prepared = engine.prepare(input);
  engine.commit(prepared.token, input);
  engine.prepare(request("GET", "/sessions/wrong", { attempt: "1" }));
  const history = engine.snapshot().history;
  assert.deepEqual(history.map((entry) => [entry.outcome, entry.sequencePosition]), [["matched", 1], ["unmatched", 2]]);
  assert.equal(history[0].detail.exchangeId, "create-search");
});

test("malformed percent-encoding in a path variable is a diagnosed mismatch", async () => {
  const engine = new ReplayEngine(parseCassette(await fixture("published-cassette")));
  const result = engine.prepare(request("GET", "/sessions/%E0%A4%A", { attempt: "1" }));
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.ok(result.diagnostic.nearest.differences.some((difference) => difference.reason === "path segment is not valid percent-encoding"));
});

test("exact and subset comparisons remain deterministic", async () => {
  const cassette = parseCassette(await fixture("published-cassette"));
  const exchange = cassette.exchanges[0];
  const baseVariables = Object.fromEntries(Object.entries(cassette.variables).map(([name, definition]) => [name, definition.value]));
  assert.equal(compareExchange(exchange, request("POST", "/sessions", {}, { origin: "MEL", destination: "HBA", extra: 1 }, { "content-type": "application/json" }), baseVariables).matched, true);
  assert.equal(compareExchange(exchange, request("POST", "/sessions", { extra: "1" }, { origin: "MEL", destination: "HBA" }, { "content-type": "application/json" }), baseVariables).matched, false);
});

test("published cassettes reject retained secret headers and delays are cancellable", async () => {
  const raw = await fixture("published-cassette");
  raw.exchanges[0].request.headers.authorization = "should never publish";
  assert.throws(() => parseCassette(raw), CassetteError);
  const controller = new AbortController();
  const waiting = waitForDelay(1_000, controller.signal);
  controller.abort();
  await assert.rejects(waiting, /cancelled during deliberate delay/);
});

test("published cassettes reject response framing and server-policy headers", async () => {
  for (const name of [
    "content-length",
    "content-encoding",
    "content-range",
    "transfer-encoding",
    "connection",
    "content-security-policy"
  ]) {
    const raw = await fixture("published-cassette");
    raw.exchanges[0].response.headers[name] = "fixture-value";
    assert.throws(() => parseCassette(raw), new RegExp(name, "i"));
  }
});

test("published cassettes reject bodyless or unsupported framed statuses and methods", async () => {
  for (const status of [100, 101, 199, 204, 205, 206, 304]) {
    const raw = await fixture("published-cassette");
    raw.exchanges[0].response.status = status;
    assert.throws(() => parseCassette(raw), /status must permit.*JSON response body/i);
  }

  for (const method of ["HEAD", "CONNECT"]) {
    const raw = await fixture("published-cassette");
    raw.exchanges[0].request.method = method;
    assert.throws(() => parseCassette(raw), new RegExp(`cannot be ${method}`, "i"));
  }
});

test("draft body overflow is rejected instead of silently omitted", async () => {
  const raw = await fixture("travel-search-draft");
  raw.exchanges[0].request.body.items = Array.from({ length: 1_001 }, (_, index) => index);
  assert.throws(() => sanitiseDraft(raw), /exceeds 1,000 array entries/);
});

test("published cassettes refuse literal credentials but accept declared variables", async () => {
  const literalField = await fixture("published-cassette");
  literalField.exchanges[0].response.body.accessToken = "direct-load-secret";
  assert.throws(() => parseCassette(literalField), /response\.body\.accessToken carries a literal credential/);

  const embedded = await fixture("published-cassette");
  embedded.exchanges[1].response.body.note = "Bearer abcdefghijklmnopqrstuvwxyz";
  assert.throws(() => parseCassette(embedded), /response\.body\.note carries a literal credential/);

  const secretHeader = await fixture("published-cassette");
  secretHeader.exchanges[0].request.headers["x-auth-token"] = "literal-header-secret";
  assert.throws(() => parseCassette(secretHeader), /request\.headers\.x-auth-token carries a literal credential/);

  const declared = await fixture("published-cassette");
  declared.variables.accessToken = { strategy: "fixed", value: "synthetic-replay-token", description: "Deliberate synthetic credential for the client under test." };
  declared.exchanges[0].response.body.accessToken = "{{accessToken}}";
  declared.exchanges[0].request.headers["x-auth-token"] = "Bearer {{accessToken}}";
  assert.equal(parseCassette(declared).exchanges[0].response.body.accessToken, "{{accessToken}}");
});

test("draft ingestion keeps a secret field only when it is mapped to a declared variable", async () => {
  const draft = await fixture("travel-search-draft");
  draft.variableReplacements.push({ name: "accessToken", observed: "synthetic-response-secret", replayValue: "synthetic-replay-token", description: "Deliberate synthetic credential for the client under test." });
  const cassette = sanitiseDraft(draft);
  assert.equal(cassette.exchanges[0].response.body.accessToken, "{{accessToken}}");
  assert.equal(cassette.variables.accessToken.value, "synthetic-replay-token");
  assert.equal(cassette.capturePolicy.redactions.includes("exchange.create-search.response.body.accessToken"), false);
  assert.equal(cassette.capturePolicy.redactions.length, 4);
});

test("published cassettes refuse header values that cannot be sent", async () => {
  const literal = await fixture("published-cassette");
  literal.exchanges[0].response.headers["x-note"] = "a\r\nx-injected: 1";
  assert.throws(() => parseCassette(literal), /response\.headers\.x-note contains characters that cannot be sent/);

  const rendered = await fixture("published-cassette");
  rendered.variables.note = { strategy: "fixed", value: "a\r\nx-injected: 1", description: "Multi-line note." };
  rendered.exchanges[0].response.headers["x-note"] = "{{note}}";
  assert.throws(() => parseCassette(rendered), /response\.headers\.x-note renders characters that cannot be sent/);

  rendered.exchanges[0].response.headers = { "content-type": "application/json" };
  rendered.exchanges[0].response.body.note = "{{note}}";
  assert.equal(parseCassette(rendered).exchanges[0].response.body.note, "{{note}}");
});

test("numeric variables keep their type in bodies and match as text elsewhere", async () => {
  const raw = await fixture("published-cassette");
  raw.variables.itemId = { strategy: "fixed", value: 42, description: "Numeric item identifier." };
  raw.variables.page = { strategy: "fixed", value: 1, description: "Numeric page number." };
  Object.assign(raw.exchanges[0].request, { path: "/items/{{itemId}}", query: { page: "{{page}}" } });
  raw.exchanges[0].request.headers["x-page"] = "{{page}}";
  raw.exchanges[0].response.headers["x-item"] = "{{itemId}}";
  raw.exchanges[0].response.body.itemId = "{{itemId}}";
  const engine = new ReplayEngine(parseCassette(raw));
  const input = request("POST", "/items/42", { page: "1" }, { origin: "MEL", destination: "HBA" }, { "content-type": "application/json", "x-page": "1" });
  const prepared = engine.prepare(input);
  assert.equal(prepared.ok, true, JSON.stringify(prepared.diagnostic));
  const response = engine.commit(prepared.token, input);
  assert.equal(response.body.itemId, 42);
  assert.equal(response.headers["x-item"], "42");
  assert.equal(engine.variables.itemId, 42);

  const numericQuery = await fixture("published-cassette");
  numericQuery.exchanges[1].request.query = { attempt: 1 };
  assert.throws(() => parseCassette(numericQuery), /request\.query\.attempt must be a string/);
});

test("content-type matches by media type and the parameters the cassette names", async () => {
  const cassette = parseCassette(await fixture("published-cassette"));
  const baseVariables = Object.fromEntries(Object.entries(cassette.variables).map(([name, definition]) => [name, definition.value]));
  const send = (contentType, exchange = cassette.exchanges[0]) => compareExchange(exchange, request("POST", "/sessions", {}, { origin: "MEL", destination: "HBA" }, { "content-type": contentType }), baseVariables).matched;
  assert.equal(send("application/json; charset=utf-8"), true);
  assert.equal(send("Application/JSON"), true);
  assert.equal(send("text/plain"), false);

  const raw = await fixture("published-cassette");
  raw.exchanges[0].request.headers["content-type"] = "application/json; charset=utf-8";
  const withCharset = parseCassette(raw).exchanges[0];
  assert.equal(send("application/json; charset=UTF-8", withCharset), true);
  assert.equal(send("application/json", withCharset), false);
});

test("ingestion keeps meaningful request headers and drops transport noise", async () => {
  const draft = await fixture("travel-search-draft");
  Object.assign(draft.exchanges[0].request.headers, { host: "travel-api.example.test", "user-agent": "recorder/1.0", traceparent: "00-abc-def-01", "sec-fetch-mode": "cors", "x-forwarded-proto": "https", accept: "application/json", "x-tenant-id": "demo" });
  const headers = sanitiseDraft(draft).exchanges[0].request.headers;
  assert.deepEqual(headers, { "content-type": "application/json", accept: "application/json", "x-tenant-id": "demo" });

  const raw = await fixture("published-cassette");
  raw.exchanges[0].request.headers.host = "travel-api.example.test";
  assert.throws(() => parseCassette(raw), /request\.headers\.host can never match/);
});

test("secret field detection works on whole words rather than substrings", async () => {
  for (const name of ["token", "accessToken", "access_token", "x-auth-token", "x-csrf-token", "csrftoken", "client_secret", "AWS_SECRET_ACCESS_KEY", "password", "newPassword", "passwordHash", "api_key", "apiKey", "APIKey", "x-api-key", "privateKey", "set-cookie", "authorization", "credentials", "X-Amz-Credential", "X-Amz-Security-Token"]) {
    assert.equal(isSecretName(name), true, name);
  }
  for (const name of ["tokensUsed", "max_tokens", "passwordlessEligible", "tokenizer", "secretary", "tokenType", "token_type", "tokenExpiresAt", "client_secret_expires_at", "passwordPolicy", "nextPageToken", "page_token", "nextToken", "continuationToken", "idempotencyKey", "key", "sessionId", "author"]) {
    assert.equal(isSecretName(name), false, name);
  }

  const draft = await fixture("travel-search-draft");
  Object.assign(draft.exchanges[2].response.body.itinerary, { tokensUsed: 12, passwordlessEligible: true, nextPageToken: "page-2" });
  draft.exchanges[2].response.body.next = "https://travel-api.example.test/sessions?page_token=page-2&access_token=leak";
  const itinerary = sanitiseDraft(draft).exchanges[2].response.body;
  assert.deepEqual(itinerary.itinerary, { origin: "MEL", destination: "HBA", priceAud: 189, tokensUsed: 12, passwordlessEligible: true, nextPageToken: "page-2" });
  assert.equal(itinerary.next, "https://travel-api.example.test/sessions?page_token=page-2&access_token=REDACTED");
});

test("parsed cassettes are frozen all the way down", async () => {
  const cassette = parseCassette(await fixture("published-cassette"));
  const final = cassette.exchanges[2];
  assert.ok(Object.isFrozen(final.response.body.itinerary));
  assert.ok(Object.isFrozen(final.request.query));
  assert.throws(() => { final.response.body.itinerary.priceAud = 1; }, TypeError);
});

test("credential scanning handles nested URLs and unterminated keys", () => {
  assert.equal(scrubText("https://a.test/cb?next=https://b.test/?access_token=leak").text, "https://a.test/cb?next=https://b.test/?access_token=REDACTED");
  assert.equal(scrubText("key: -----BEGIN PRIVATE KEY-----\nMIIE-truncated").text, "key: REDACTED");
  assert.equal(scrubText("?token_type=Bearer&access_token=abc==&state=keep").text, "?token_type=Bearer&access_token=REDACTED&state=keep");
});

test("credential scanning stays fast on hostile input at the body size limit", () => {
  const size = 128 * 1024;
  for (const text of ["?a".repeat(size / 2), "-eyJ".repeat(size / 4), "-----BEGIN RSA PRIVATE KEY-----".repeat(size / 31), "xoxb-".repeat(size / 5)]) {
    const started = performance.now();
    scrubText(text);
    assert.ok(performance.now() - started < 2_000, `${text.slice(0, 12)}… took ${Math.round(performance.now() - started)} ms`);
  }
});
