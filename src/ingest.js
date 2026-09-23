import { CassetteError, forbiddenHeaders, parseCassette } from "./cassette.js";
import { isPlaceholder, isSecretName, scrubText } from "./secrets.js";

const VOLATILE_REQUEST_HEADERS = new Set(["host", "user-agent", "accept-encoding", "accept-language", "origin", "referer", "cache-control", "pragma", "if-none-match", "if-modified-since", "priority", "dnt", "upgrade-insecure-requests", "expect", "forwarded", "via", "traceparent", "tracestate", "baggage", "x-request-id", "x-correlation-id", "x-amzn-trace-id", "x-cloud-trace-context"]);
const VOLATILE_REQUEST_HEADER_PREFIXES = ["sec-", "x-forwarded-", "x-b3-"];

function isVolatileRequestHeader(name) {
  return VOLATILE_REQUEST_HEADERS.has(name) || VOLATILE_REQUEST_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function cloneJson(value) {
  try { return structuredClone(value); }
  catch (error) { throw new CassetteError(`Draft must be cloneable JSON: ${error.message}`); }
}

function redactText(value, path, redactions) {
  if (typeof value !== "string") return value;
  const { text, found } = scrubText(value);
  for (const label of found) redactions.push(`${path} (${label})`);
  return text;
}

function redactBody(value, path, redactions) {
  if (typeof value === "string") return redactText(value, path, redactions);
  if (Array.isArray(value)) {
    if (value.length > 1_000) {
      throw new CassetteError(`${path} exceeds 1,000 array entries`);
    }
    return value.map((item, index) => redactBody(item, `${path}[${index}]`, redactions));
  }
  if (value && typeof value === "object") {
    const result = {};
    const entries = Object.entries(value);
    if (entries.length > 1_000) {
      throw new CassetteError(`${path} exceeds 1,000 object fields`);
    }
    for (const [key, item] of entries) {
      if (isSecretName(key) && !isPlaceholder(item)) redactions.push(`${path}.${key}`);
      else result[key] = redactBody(item, `${path}.${key}`, redactions);
    }
    return result;
  }
  return value;
}

function redactHeaders(value, path, redactions, { dropVolatile = false } = {}) {
  const result = {};
  for (const [rawName, headerValue] of Object.entries(value ?? {})) {
    const name = rawName.toLowerCase();
    if (dropVolatile && isVolatileRequestHeader(name)) continue;
    if (forbiddenHeaders.has(name) || (isSecretName(name) && !isPlaceholder(headerValue))) redactions.push(`${path}.${name}`);
    else result[name] = redactText(headerValue, `${path}.${name}`, redactions);
  }
  return result;
}

function observedReplacement(definitions) {
  if (definitions.length === 0) return null;
  const longestFirst = [...definitions].sort((left, right) => right.observed.length - left.observed.length);
  return {
    pattern: new RegExp(longestFirst.map((definition) => definition.observed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g"),
    names: new Map(definitions.map((definition) => [definition.observed, definition.name]))
  };
}

function replaceObserved(value, replacement) {
  if (typeof value === "string") return replacement ? value.replace(replacement.pattern, (observed) => `{{${replacement.names.get(observed)}}}`) : value;
  if (Array.isArray(value)) return value.map((item) => replaceObserved(item, replacement));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceObserved(item, replacement)]));
  return value;
}

export function sanitiseDraft(input) {
  const draft = cloneJson(input);
  if (!draft || typeof draft !== "object" || Array.isArray(draft) || draft.format !== "api-tapedeck.draft.v1") throw new CassetteError("draft.format must be api-tapedeck.draft.v1");
  if (typeof draft.upstreamHost !== "string" || draft.upstreamHost.length === 0 || draft.upstreamHost.length > 255) throw new CassetteError("draft.upstreamHost is invalid");
  if (!Array.isArray(draft.exchanges) || draft.exchanges.length > 100) throw new CassetteError("draft.exchanges must contain at most 100 records");
  if (!Array.isArray(draft.variableReplacements) || draft.variableReplacements.length > 100) throw new CassetteError("draft.variableReplacements is invalid");
  const definitions = draft.variableReplacements.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new CassetteError(`draft.variableReplacements[${index}] is invalid`);
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value.name) || typeof value.observed !== "string" || value.observed.length === 0 || value.observed.length > 2_048) throw new CassetteError(`draft.variableReplacements[${index}] has invalid values`);
    if (!["string", "number", "boolean"].includes(typeof value.replayValue) || typeof value.description !== "string" || value.description.length > 240) throw new CassetteError(`draft.variableReplacements[${index}] has invalid replay metadata`);
    return value;
  });
  if (new Set(definitions.map((definition) => definition.name)).size !== definitions.length) throw new CassetteError("draft.variableReplacements names must be unique");
  if (new Set(definitions.map((definition) => definition.observed)).size !== definitions.length) throw new CassetteError("draft.variableReplacements observed values must be unique");
  const replacement = observedReplacement(definitions);
  const redactions = [];
  const exchanges = draft.exchanges.map((exchange, index) => {
    if (!exchange || typeof exchange !== "object" || Array.isArray(exchange)) throw new CassetteError(`draft.exchanges[${index}] is invalid`);
    const request = exchange.request ?? {};
    const response = exchange.response ?? {};
    const published = {
      id: exchange.id,
      name: exchange.name,
      request: {
        method: request.method,
        path: redactText(replaceObserved(request.path, replacement), `exchange.${exchange.id}.request.path`, redactions),
        query: redactBody(replaceObserved(request.query ?? {}, replacement), `exchange.${exchange.id}.request.query`, redactions),
        headers: redactHeaders(replaceObserved(request.headers, replacement), `exchange.${exchange.id}.request.headers`, redactions, { dropVolatile: true }),
        body: redactBody(replaceObserved(request.body, replacement), `exchange.${exchange.id}.request.body`, redactions),
        match: exchange.match
      },
      response: {
        status: response.status,
        headers: redactHeaders(replaceObserved(response.headers, replacement), `exchange.${exchange.id}.response.headers`, redactions),
        body: redactBody(replaceObserved(response.body, replacement), `exchange.${exchange.id}.response.body`, redactions),
        delay: { mode: "recorded", ms: Math.max(0, Math.min(5_000, Number.isInteger(exchange.durationMs) ? exchange.durationMs : 0)) }
      }
    };
    return published;
  });
  const cassette = parseCassette({
    format: "api-tapedeck.cassette.v1",
    name: draft.name,
    description: draft.description,
    variables: Object.fromEntries(definitions.map((item) => [item.name, { strategy: "fixed", value: item.replayValue, description: item.description }])),
    capturePolicy: { reviewed: false, retainedHosts: [draft.upstreamHost], redactions: [...new Set(redactions)].sort() },
    exchanges
  });
  return cassette;
}
