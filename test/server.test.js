import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { createTapedeckServer } from "../src/server.js";

const fixture = async (name) => JSON.parse(await readFile(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));

async function start(t) {
  const server = await createTapedeckServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const send = (method, path, { body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined || typeof body === "string" ? body : JSON.stringify(body);
    const contentType = body === undefined || typeof body === "string" ? {} : { "content-type": "application/json" };
    const outgoing = httpRequest({ host: "127.0.0.1", port, method, path, agent: false, headers: { ...contentType, ...headers } }, (incoming) => {
      let text = "";
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk) => { text += chunk; });
      incoming.on("end", () => resolve({ status: incoming.statusCode, headers: incoming.headers, body: (incoming.headers["content-type"] ?? "").startsWith("application/json") ? JSON.parse(text) : text }));
    });
    outgoing.on("error", reject);
    outgoing.end(payload);
  });
  return Object.assign(send, { port });
}

test("review marks only the unchanged cassette this server sanitised", async (t) => {
  const send = await start(t);
  const sanitised = await send("POST", "/api/sanitise", { body: { draft: await fixture("travel-search-draft") } });
  assert.equal(sanitised.status, 200);
  const { cassette, reviewToken } = sanitised.body;
  assert.equal(cassette.capturePolicy.reviewed, false);

  const tampered = structuredClone(cassette);
  tampered.exchanges[0].response.body.status = "tampered";
  const refused = await send("POST", "/api/replay/review", { body: { cassette: tampered, reviewToken } });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /differs from the one this server sanitised/);

  const selfApproved = structuredClone(cassette);
  selfApproved.capturePolicy.reviewed = true;
  assert.equal((await send("POST", "/api/replay/review", { body: { cassette: selfApproved, reviewToken } })).status, 400);
  assert.equal((await send("POST", "/api/replay/review", { body: { cassette } })).status, 400);

  const reviewed = await send("POST", "/api/replay/review", { body: { cassette, reviewToken } });
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.body.cassette.capturePolicy.reviewed, true);
  assert.equal(reviewed.body.state.cursor, 0);
});

test("direct loads refuse cassettes that carry literal credentials", async (t) => {
  const send = await start(t);
  const raw = await fixture("published-cassette");
  raw.name = "Carries a secret";
  raw.exchanges[0].response.body.accessToken = "direct-load-secret";
  const result = await send("POST", "/api/replay/load", { body: { cassette: raw } });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /literal credential/);
  assert.equal((await send("GET", "/api/replay/state")).body.state.cassette, "Travel search with polling");
});

test("replays the published journey over HTTP with recorded delays", async (t) => {
  const send = await start(t);
  assert.equal((await send("POST", "/api/replay/reset")).status, 200);
  const created = await send("POST", "/replay/sessions", { body: { origin: "MEL", destination: "HBA", token: "synthetic-client-value" } });
  assert.equal(created.status, 202);
  assert.equal(created.headers["x-api-tapedeck-exchange"], "create-search");
  assert.equal(created.headers["x-api-tapedeck-delay-ms"], "140");
  assert.deepEqual(created.body, { sessionId: "session-demo-001", status: "searching", generatedAt: "2026-07-24T00:00:00.000Z" });
  assert.equal((await send("GET", "/replay/sessions/session-demo-001?attempt=1")).status, 200);
  const final = await send("GET", "/replay/sessions/session-demo-001?attempt=2");
  assert.equal(final.body.itinerary.priceAud, 189);
  const finished = await send("GET", "/replay/sessions/session-demo-001?attempt=3");
  assert.equal(finished.status, 409);
  assert.equal(finished.body.upstreamContacted, false);
});

test("refuses requests addressed to a foreign host name", async (t) => {
  const send = await start(t);
  for (const path of ["/", "/api/replay/state", "/replay/sessions"]) {
    const result = await send("GET", path, { headers: { host: "attacker.example:4193" } });
    assert.equal(result.status, 403, path);
  }
});

test("refuses cross-site calls that could change replay state", async (t) => {
  const send = await start(t);
  const raw = await fixture("published-cassette");
  raw.name = "Swapped by another site";
  const crossOrigin = await send("POST", "/api/replay/load", { body: JSON.stringify({ cassette: raw }), headers: { "content-type": "text/plain", origin: "https://attacker.example" } });
  assert.equal(crossOrigin.status, 403);
  const plainText = await send("POST", "/api/replay/load", { body: JSON.stringify({ cassette: raw }), headers: { "content-type": "text/plain" } });
  assert.equal(plainText.status, 415);
  const embedded = await send("GET", "/replay/sessions/session-demo-001?attempt=1", { headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(embedded.status, 403);
  const foreignReplay = await send("POST", "/replay/sessions", { body: { origin: "MEL", destination: "HBA" }, headers: { origin: "https://attacker.example" } });
  assert.equal(foreignReplay.status, 403);
  const state = (await send("GET", "/api/replay/state")).body.state;
  assert.equal(state.cassette, "Travel search with polling");
  assert.equal(state.history.length, 0);
});

test("accepts same-origin API calls and loopback replay origins", async (t) => {
  const send = await start(t);
  assert.equal((await send("GET", "/")).status, 200);
  const sameOrigin = await send("POST", "/api/replay/reset", { body: {}, headers: { origin: `http://127.0.0.1:${send.port}` } });
  assert.equal(sameOrigin.status, 200);
  const otherLocalPort = await send("POST", "/api/replay/reset", { body: {}, headers: { origin: "http://127.0.0.1:5173" } });
  assert.equal(otherLocalPort.status, 403);
  const replay = await send("POST", "/replay/sessions", { body: { origin: "MEL", destination: "HBA" }, headers: { origin: "http://localhost:5173" } });
  assert.equal(replay.status, 202);
});
