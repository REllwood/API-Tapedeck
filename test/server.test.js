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
  return (method, path, { body, headers = {} } = {}) => new Promise((resolve, reject) => {
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
