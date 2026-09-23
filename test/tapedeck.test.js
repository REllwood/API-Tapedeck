import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CassetteError, parseCassette } from "../src/cassette.js";
import { sanitiseDraft } from "../src/ingest.js";
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
