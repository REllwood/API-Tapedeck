import { literalSecrets } from "./secrets.js";

const LIMITS = Object.freeze({ exchanges: 100, variables: 100, headers: 80, bodyBytes: 128 * 1024, string: 2_048, path: 512, delayMs: 5_000 });
const FORBIDDEN_HEADERS = new Set([
  "authorization",
  "connection",
  "content-encoding",
  "content-length",
  "content-range",
  "content-security-policy",
  "cookie",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "referrer-policy",
  "permissions-policy",
  "set-cookie",
  "strict-transport-security",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-api-key",
  "x-content-type-options"
]);

const INVALID_HEADER_CHARACTER = /[^\t\x20-\x7e\x80-\xff]/;

export class CassetteError extends Error {
  constructor(message) {
    super(message);
    this.name = "CassetteError";
  }
}

function record(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new CassetteError(`${path} must be an object`);
  return value;
}

function string(value, path, maximum = LIMITS.string) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) throw new CassetteError(`${path} must be a non-empty string of at most ${maximum} characters`);
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function jsonValue(value, path) {
  let encoded;
  try { encoded = JSON.stringify(value); }
  catch (error) { throw new CassetteError(`${path} must be JSON-compatible: ${error.message}`); }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > LIMITS.bodyBytes) throw new CassetteError(`${path} exceeds the ${LIMITS.bodyBytes}-byte limit`);
  return deepFreeze(structuredClone(value));
}

function headers(value, path) {
  const input = record(value ?? {}, path);
  const entries = Object.entries(input);
  if (entries.length > LIMITS.headers) throw new CassetteError(`${path} exceeds ${LIMITS.headers} headers`);
  const result = {};
  for (const [rawName, rawValue] of entries) {
    const name = rawName.toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]{1,80}$/.test(name)) throw new CassetteError(`${path} contains an invalid header name`);
    if (FORBIDDEN_HEADERS.has(name)) throw new CassetteError(`${path}.${name} is excluded by the published cassette policy`);
    result[name] = string(rawValue, `${path}.${name}`, 4_096);
    if (INVALID_HEADER_CHARACTER.test(result[name])) throw new CassetteError(`${path}.${name} contains characters that cannot be sent in an HTTP header`);
  }
  return Object.freeze(result);
}

function variables(value) {
  const input = record(value ?? {}, "cassette.variables");
  const entries = Object.entries(input);
  if (entries.length > LIMITS.variables) throw new CassetteError(`cassette.variables exceeds ${LIMITS.variables} entries`);
  const result = {};
  for (const [name, definitionValue] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) throw new CassetteError(`cassette.variables contains invalid name ${name}`);
    const definition = record(definitionValue, `cassette.variables.${name}`);
    if (definition.strategy !== "fixed") throw new CassetteError(`cassette.variables.${name}.strategy must be fixed`);
    if (!["string", "number", "boolean"].includes(typeof definition.value)) throw new CassetteError(`cassette.variables.${name}.value must be a scalar`);
    if (typeof definition.value === "string" && definition.value.length > LIMITS.string) throw new CassetteError(`cassette.variables.${name}.value is too long`);
    result[name] = Object.freeze({ strategy: "fixed", value: definition.value, description: string(definition.description, `cassette.variables.${name}.description`, 240) });
  }
  return Object.freeze(result);
}

function ensureTemplatesKnown(value, variableNames, path) {
  const visit = (item, itemPath) => {
    if (typeof item === "string") {
      for (const match of item.matchAll(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g)) {
        if (!variableNames.has(match[1])) throw new CassetteError(`${itemPath} references unknown variable ${match[1]}`);
      }
    } else if (Array.isArray(item)) item.forEach((child, index) => visit(child, `${itemPath}[${index}]`));
    else if (item && typeof item === "object") Object.entries(item).forEach(([key, child]) => visit(child, `${itemPath}.${key}`));
  };
  visit(value, path);
}

function ensureRenderedHeadersValid(value, variables, path) {
  for (const [name, headerValue] of Object.entries(value)) {
    const rendered = headerValue.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (_, variable) => String(variables[variable].value));
    if (INVALID_HEADER_CHARACTER.test(rendered)) throw new CassetteError(`${path}.${name} renders characters that cannot be sent in an HTTP header`);
  }
}

function normaliseExchange(value, index, variables) {
  const path = `cassette.exchanges[${index}]`;
  const exchange = record(value, path);
  const request = record(exchange.request, `${path}.request`);
  const response = record(exchange.response, `${path}.response`);
  const method = string(request.method, `${path}.request.method`, 16).toUpperCase();
  if (!/^[A-Z]+$/.test(method)) throw new CassetteError(`${path}.request.method is invalid`);
  if (["CONNECT", "HEAD"].includes(method)) {
    throw new CassetteError(
      `${path}.request.method cannot be ${method} within the version 0.1 JSON replay route`
    );
  }
  const requestPath = string(request.path, `${path}.request.path`, LIMITS.path);
  if (!requestPath.startsWith("/") || requestPath.includes("?") || requestPath.includes("#")) throw new CassetteError(`${path}.request.path must be an absolute path without query or fragment`);
  const match = record(request.match, `${path}.request.match`);
  if (!["exact", "subset"].includes(match.query) || !["exact", "subset", "none"].includes(match.body)) throw new CassetteError(`${path}.request.match is invalid`);
  const query = jsonValue(record(request.query ?? {}, `${path}.request.query`), `${path}.request.query`);
  for (const [name, item] of Object.entries(query)) {
    if (typeof item !== "string") throw new CassetteError(`${path}.request.query.${name} must be a string, because query values always arrive as text`);
  }
  const body = match.body === "none" ? null : jsonValue(request.body, `${path}.request.body`);
  const requestHeaders = headers(request.headers, `${path}.request.headers`);
  if ("host" in requestHeaders) throw new CassetteError(`${path}.request.headers.host can never match a local replay; remove it`);
  if (
    !Number.isInteger(response.status) ||
    response.status < 200 ||
    response.status > 599 ||
    [204, 205, 206, 304].includes(response.status)
  ) {
    throw new CassetteError(
      `${path}.response.status must permit the version 0.1 JSON response body`
    );
  }
  const delay = record(response.delay, `${path}.response.delay`);
  if (!["fixed", "recorded"].includes(delay.mode) || !Number.isInteger(delay.ms) || delay.ms < 0 || delay.ms > LIMITS.delayMs) throw new CassetteError(`${path}.response.delay must use fixed or recorded mode from 0 to ${LIMITS.delayMs} milliseconds`);
  const normalised = Object.freeze({
    id: string(exchange.id, `${path}.id`, 120),
    name: string(exchange.name, `${path}.name`, 160),
    request: Object.freeze({ method, path: requestPath, query: Object.freeze(query), headers: requestHeaders, body, match: Object.freeze({ query: match.query, body: match.body }) }),
    response: Object.freeze({ status: response.status, headers: headers(response.headers, `${path}.response.headers`), body: jsonValue(response.body, `${path}.response.body`), delay: Object.freeze({ mode: delay.mode, ms: delay.ms }) })
  });
  ensureTemplatesKnown(normalised, new Set(Object.keys(variables)), path);
  ensureRenderedHeadersValid(normalised.request.headers, variables, `${path}.request.headers`);
  ensureRenderedHeadersValid(normalised.response.headers, variables, `${path}.response.headers`);
  const credentials = [...literalSecrets(normalised.request, `${path}.request`), ...literalSecrets(normalised.response, `${path}.response`)];
  if (credentials.length > 0) throw new CassetteError(`${credentials[0]} carries a literal credential; published cassettes may only carry credentials through declared variables`);
  return normalised;
}

export function parseCassette(input) {
  let raw;
  try { raw = typeof input === "string" ? JSON.parse(input) : input; }
  catch (error) { throw new CassetteError(`Cassette is not valid JSON: ${error.message}`); }
  const cassette = record(raw, "cassette");
  if (cassette.format !== "api-tapedeck.cassette.v1") throw new CassetteError("cassette.format must be api-tapedeck.cassette.v1");
  const capturePolicy = record(cassette.capturePolicy, "cassette.capturePolicy");
  if (typeof capturePolicy.reviewed !== "boolean") throw new CassetteError("cassette.capturePolicy.reviewed must be a boolean");
  const redactions = capturePolicy.redactions ?? [];
  const retainedHosts = capturePolicy.retainedHosts ?? [];
  if (!Array.isArray(redactions) || redactions.length > 500 || redactions.some((item) => typeof item !== "string" || item.length > 300)) throw new CassetteError("cassette.capturePolicy.redactions is invalid");
  if (!Array.isArray(retainedHosts) || retainedHosts.length > 20 || retainedHosts.some((item) => typeof item !== "string" || item.length > 255)) throw new CassetteError("cassette.capturePolicy.retainedHosts is invalid");
  const normalVariables = variables(cassette.variables);
  if (!Array.isArray(cassette.exchanges) || cassette.exchanges.length > LIMITS.exchanges) throw new CassetteError(`cassette.exchanges must contain at most ${LIMITS.exchanges} records`);
  const exchanges = cassette.exchanges.map((exchange, index) => normaliseExchange(exchange, index, normalVariables));
  const ids = new Set();
  for (const exchange of exchanges) {
    if (ids.has(exchange.id)) throw new CassetteError(`cassette.exchanges contains duplicate id ${exchange.id}`);
    ids.add(exchange.id);
  }
  return Object.freeze({
    format: cassette.format,
    name: string(cassette.name, "cassette.name", 160),
    description: string(cassette.description, "cassette.description", 600),
    variables: normalVariables,
    capturePolicy: Object.freeze({ reviewed: capturePolicy.reviewed, redactions: Object.freeze([...redactions]), retainedHosts: Object.freeze([...retainedHosts]) }),
    exchanges: Object.freeze(exchanges)
  });
}

export const forbiddenHeaders = FORBIDDEN_HEADERS;
