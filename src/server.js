#!/usr/bin/env node
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { CassetteError, forbiddenHeaders, parseCassette } from "./cassette.js";
import { sanitiseDraft } from "./ingest.js";
import { ReplayEngine, stable, waitForDelay } from "./replay.js";

const PUBLIC = new Map([
  ["/", new URL("../public/index.html", import.meta.url)],
  ["/app.js", new URL("../public/app.js", import.meta.url)],
  ["/styles.css", new URL("../public/styles.css", import.meta.url)]
]);
const DRAFT_URL = new URL("../fixtures/travel-search-draft.json", import.meta.url);
const CASSETTE_URL = new URL("../fixtures/published-cassette.json", import.meta.url);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8" };
const LOOPBACK_AUTHORITY = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

function send(response, status, type, body, extraHeaders = {}) {
  const content = Buffer.isBuffer(body) ? body : Buffer.from(body);
  response.writeHead(status, {
    ...extraHeaders,
    "content-type": type,
    "content-length": content.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(content);
}

function json(response, status, value, extraHeaders = {}) {
  send(response, status, TYPES[".json"], JSON.stringify(value), extraHeaders);
}

function readBounded(request, maximum) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size <= maximum) {
        chunks.push(chunk);
        return;
      }
      request.removeAllListeners("data");
      request.pause();
      reject(new HttpError(413, `Request body exceeds ${maximum} bytes`));
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function isJsonRequest(request) {
  return (request.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase() === "application/json";
}

function isLoopbackAuthority(value, port) {
  const match = LOOPBACK_AUTHORITY.exec(value);
  return match !== null && (port === undefined || Number(match[1] ?? 80) === port);
}

function refusedSource(request, pathname) {
  const host = (request.headers.host ?? "").toLowerCase();
  if (!isLoopbackAuthority(host, request.socket.localPort)) return "Requests must address this server as 127.0.0.1, localhost or [::1]";
  if (!pathname.startsWith("/api/") && !pathname.startsWith("/replay/")) return null;
  const origin = request.headers.origin?.toLowerCase();
  if (origin === undefined) return request.headers["sec-fetch-site"] === "cross-site" ? "Cross-site requests are refused" : null;
  if (pathname.startsWith("/api/")) return origin === `http://${host}` ? null : "Cross-origin API requests are refused";
  return origin.startsWith("http://") && isLoopbackAuthority(origin.slice("http://".length)) ? null : "Replay requests from non-loopback origins are refused";
}

async function readJson(request, maximum = 1024 * 1024) {
  const body = await readBounded(request, maximum);
  if (body.length > 0 && !isJsonRequest(request)) throw new HttpError(415, "API request bodies must be sent as application/json");
  try {
    const value = JSON.parse(body || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("body must be an object");
    return value;
  } catch (error) {
    throw new CassetteError(`Request is not valid JSON: ${error.message}`);
  }
}

async function fixture(url) {
  return JSON.parse(await readFile(url, "utf8"));
}

function safeIncomingHeaders(input) {
  const output = {};
  for (const [rawName, rawValue] of Object.entries(input)) {
    const name = rawName.toLowerCase();
    if (forbiddenHeaders.has(name) || typeof rawValue !== "string" || rawValue.length > 4_096) continue;
    output[name] = rawValue;
  }
  return output;
}

async function replayRequest(request, response, url, engine) {
  let body = null;
  if (!["GET", "HEAD"].includes(request.method ?? "GET")) {
    const raw = await readBounded(request, 128 * 1024);
    if (raw.length > 0) {
      if (!isJsonRequest(request)) throw new CassetteError("Version 0.1 replay accepts JSON request bodies only");
      try { body = JSON.parse(raw); }
      catch (error) { throw new CassetteError(`Replay body is not valid JSON: ${error.message}`); }
    }
  }
  const query = {};
  for (const [name, value] of url.searchParams) {
    if (name.length > 160 || value.length > 2_048) throw new CassetteError("Replay query exceeds configured bounds");
    if (name in query) throw new CassetteError(`Replay query contains duplicate field ${name}`);
    query[name] = value;
  }
  const replayInput = {
    method: request.method ?? "GET",
    path: url.pathname.slice("/replay".length) || "/",
    query,
    headers: safeIncomingHeaders(request.headers),
    body
  };
  const prepared = engine.prepare(replayInput);
  if (!prepared.ok) {
    json(response, prepared.status, { ok: false, error: "unmatched replay request", diagnostic: prepared.diagnostic, upstreamContacted: false });
    return;
  }
  const controller = new AbortController();
  response.once("close", () => { if (!response.writableEnded) controller.abort(); });
  try {
    await waitForDelay(prepared.response.delay.ms, controller.signal);
  } catch {
    engine.cancel(prepared.token);
    return;
  }
  if (!engine.isCurrent(prepared.token)) {
    json(response, 409, { ok: false, error: "The replay was reset or reloaded during the deliberate delay", upstreamContacted: false });
    return;
  }
  const result = prepared.response;
  try {
    json(response, result.status, result.body, {
      ...result.headers,
      "x-api-tapedeck-exchange": prepared.exchange.id,
      "x-api-tapedeck-delay-ms": String(result.delay.ms),
      "x-api-tapedeck-mode": "local-replay"
    });
  } catch (error) {
    engine.cancel(prepared.token);
    throw new Error(`Recorded response could not be sent: ${error.message}`);
  }
  engine.commit(prepared.token, replayInput);
}

export async function createTapedeckServer() {
  const published = parseCassette(await fixture(CASSETTE_URL));
  const engine = new ReplayEngine(published);
  const reviewKey = randomBytes(32);
  const reviewToken = (cassette) => createHmac("sha256", reviewKey).update(stable(cassette)).digest("base64url");
  const server = createServer(async (request, response) => {
    response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const refusal = refusedSource(request, url.pathname);
    if (refusal) {
      json(response, 403, { ok: false, error: refusal, upstreamContacted: false });
      return;
    }
    try {
      if (request.method === "GET" && PUBLIC.has(url.pathname)) {
        const file = PUBLIC.get(url.pathname);
        const content = await readFile(file);
        send(response, 200, TYPES[extname(fileURLToPath(file))], content);
        return;
      }
      if (request.method === "GET" && url.pathname === "/fixtures/travel-search-draft.json") {
        send(response, 200, TYPES[".json"], await readFile(DRAFT_URL));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/replay/state") {
        json(response, 200, { ok: true, state: engine.snapshot() });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/sanitise") {
        const body = await readJson(request);
        const cassette = sanitiseDraft(body.draft ?? body);
        json(response, 200, { ok: true, cassette, reviewToken: reviewToken(cassette) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/replay/review") {
        const body = await readJson(request);
        const cassette = parseCassette(body.cassette);
        if (cassette.capturePolicy.reviewed) throw new CassetteError("Cassette is already marked reviewed; load it through /api/replay/load");
        const expected = Buffer.from(reviewToken(cassette));
        const supplied = Buffer.from(typeof body.reviewToken === "string" ? body.reviewToken : "");
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new CassetteError("Cassette differs from the one this server sanitised; sanitise it again before review");
        const reviewed = parseCassette({ ...cassette, capturePolicy: { ...cassette.capturePolicy, reviewed: true } });
        engine.load(reviewed);
        json(response, 200, { ok: true, cassette: reviewed, state: engine.snapshot() });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/replay/load") {
        const body = await readJson(request);
        const cassette = parseCassette(body.cassette ?? body);
        if (!cassette.capturePolicy.reviewed) throw new CassetteError("Cassette must be explicitly marked reviewed before replay");
        engine.load(cassette);
        json(response, 200, { ok: true, state: engine.snapshot() });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/replay/reset") {
        await readBounded(request, 1_024);
        engine.reset();
        json(response, 200, { ok: true, state: engine.snapshot() });
        return;
      }
      if (url.pathname.startsWith("/replay/")) {
        await replayRequest(request, response, url, engine);
        return;
      }
      json(response, 404, { ok: false, error: "Route not found" });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error instanceof CassetteError ? 400 : 500;
      if (!response.writableEnded) json(response, status, { ok: false, error: error.message, upstreamContacted: false }, status === 413 ? { connection: "close" } : {});
    }
  });
  return server;
}

function parsePort(values) {
  if (values.includes("--help") || values.includes("-h")) return null;
  if (values.length === 0) return 4193;
  if (values[0] !== "--port" || values.length !== 2 || !/^\d+$/.test(values[1])) throw new Error("Usage: npm start -- [--port 1-65535]");
  const port = Number(values[1]);
  if (port < 1 || port > 65535) throw new Error("Port must be from 1 to 65535");
  return port;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const port = parsePort(process.argv.slice(2));
    if (port === null) process.stdout.write("API Tapedeck v0.1\nUsage: npm start -- [--port 1-65535]\nRuns a loopback-only reviewed-cassette replay workbench.\n");
    else {
      const server = await createTapedeckServer();
      server.listen(port, "127.0.0.1", () => process.stdout.write(`API Tapedeck listening at http://127.0.0.1:${port}\n`));
      server.on("error", (error) => {
        process.stderr.write(`API Tapedeck: ${error.message}\n`);
        process.exitCode = 2;
      });
    }
  } catch (error) {
    process.stderr.write(`API Tapedeck: ${error.message}\n`);
    process.exitCode = 2;
  }
}
