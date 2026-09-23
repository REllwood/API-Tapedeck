import { CassetteError, forbiddenHeaders, parseCassette } from "./cassette.js";
import { isPlaceholder, isSecretName, scrubText } from "./secrets.js";

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

function redactHeaders(value, path, redactions) {
  const result = {};
  for (const [rawName, headerValue] of Object.entries(value ?? {})) {
    const name = rawName.toLowerCase();
    if (forbiddenHeaders.has(name) || (isSecretName(name) && !isPlaceholder(headerValue))) redactions.push(`${path}.${name}`);
    else result[name] = redactText(headerValue, `${path}.${name}`, redactions);
  }
  return result;
}

function replaceObserved(value, definitions) {
  if (typeof value === "string") {
    let result = value;
    for (const definition of definitions) result = result.replaceAll(definition.observed, `{{${definition.name}}}`);
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => replaceObserved(item, definitions));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceObserved(item, definitions)]));
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
        path: redactText(replaceObserved(request.path, definitions), `exchange.${exchange.id}.request.path`, redactions),
        query: redactBody(replaceObserved(request.query ?? {}, definitions), `exchange.${exchange.id}.request.query`, redactions),
        headers: redactHeaders(replaceObserved(request.headers, definitions), `exchange.${exchange.id}.request.headers`, redactions),
        body: redactBody(replaceObserved(request.body, definitions), `exchange.${exchange.id}.request.body`, redactions),
        match: exchange.match
      },
      response: {
        status: response.status,
        headers: redactHeaders(replaceObserved(response.headers, definitions), `exchange.${exchange.id}.response.headers`, redactions),
        body: redactBody(replaceObserved(response.body, definitions), `exchange.${exchange.id}.response.body`, redactions),
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
