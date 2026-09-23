import { performance } from "node:perf_hooks";

function render(value, variables) {
  if (typeof value === "string") {
    const whole = value.match(/^\{\{([A-Za-z][A-Za-z0-9_]*)\}\}$/);
    if (whole) return variables[whole[1]];
    return value.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (_, name) => String(variables[name]));
  }
  if (Array.isArray(value)) return value.map((item) => render(item, variables));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, render(item, variables)]));
  return value;
}

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function compareValue(expected, actual, mode, path, differences) {
  if (mode === "subset" && expected && typeof expected === "object" && !Array.isArray(expected)) {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
      differences.push({ field: path, expected, actual, reason: "expected an object containing the cassette fields" });
      return;
    }
    for (const [key, value] of Object.entries(expected)) compareValue(value, actual[key], "subset", `${path}.${key}`, differences);
    return;
  }
  if (stable(expected) !== stable(actual)) differences.push({ field: path, expected, actual, reason: mode === "subset" ? "required subset value differs" : "exact value differs" });
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function comparePath(template, actual, variables, differences) {
  const names = [];
  let source = "^";
  let cursor = 0;
  for (const match of template.matchAll(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g)) {
    source += escapeRegex(template.slice(cursor, match.index));
    source += "([^/]+)";
    names.push(match[1]);
    cursor = match.index + match[0].length;
  }
  source += `${escapeRegex(template.slice(cursor))}$`;
  const matched = new RegExp(source).exec(actual);
  if (!matched) {
    differences.push({ field: "path", expected: template, actual, reason: "path template does not match" });
    return;
  }
  names.forEach((name, index) => {
    const observed = decodeURIComponent(matched[index + 1]);
    if (variables[name] !== undefined && String(variables[name]) !== observed) differences.push({ field: `path variable ${name}`, expected: variables[name], actual: observed, reason: "fixed replay variable differs" });
    else variables[name] = observed;
  });
}

export function compareExchange(exchange, request, baseVariables) {
  const variables = { ...baseVariables };
  const differences = [];
  if (exchange.request.method !== request.method) differences.push({ field: "method", expected: exchange.request.method, actual: request.method, reason: "method differs" });
  comparePath(exchange.request.path, request.path, variables, differences);
  const expectedQuery = render(exchange.request.query, variables);
  compareValue(expectedQuery, request.query, exchange.request.match.query, "query", differences);
  const expectedHeaders = render(exchange.request.headers, variables);
  for (const [name, value] of Object.entries(expectedHeaders)) {
    if (request.headers[name] !== value) differences.push({ field: `header.${name}`, expected: value, actual: request.headers[name] ?? null, reason: "selected header differs or is missing" });
  }
  if (exchange.request.match.body !== "none") compareValue(render(exchange.request.body, variables), request.body, exchange.request.match.body, "body", differences);
  return { matched: differences.length === 0, differences, variables };
}

export class ReplayEngine {
  constructor(cassette) {
    this.load(cassette);
  }

  load(cassette) {
    if (!cassette.capturePolicy.reviewed) throw new Error("Replay requires an explicitly reviewed cassette");
    this.cassette = cassette;
    this.cursor = 0;
    this.pending = null;
    this.history = [];
    this.variables = Object.fromEntries(Object.entries(cassette.variables).map(([name, definition]) => [name, definition.value]));
  }

  reset() {
    this.cursor = 0;
    this.pending = null;
    this.history = [];
    this.variables = Object.fromEntries(Object.entries(this.cassette.variables).map(([name, definition]) => [name, definition.value]));
  }

  prepare(request) {
    if (this.pending) return { ok: false, status: 409, diagnostic: { reason: "A deliberate replay delay is already active", cursor: this.cursor } };
    const expected = this.cassette.exchanges[this.cursor];
    if (!expected) {
      const diagnostic = { reason: "The cassette sequence is already complete", cursor: this.cursor, expectedExchange: null, nearest: null };
      this.#history("unmatched", request, diagnostic);
      return { ok: false, status: 409, diagnostic };
    }
    const comparison = compareExchange(expected, request, this.variables);
    if (!comparison.matched) {
      const candidates = this.cassette.exchanges.map((exchange, index) => ({ exchange, index, comparison: compareExchange(exchange, request, this.variables) }))
        .sort((left, right) => left.comparison.differences.length - right.comparison.differences.length || left.index - right.index);
      const nearest = candidates[0];
      const diagnostic = {
        reason: nearest.comparison.matched && nearest.index !== this.cursor ? "Request matches a later exchange and arrived out of order" : "Request does not match the expected exchange",
        cursor: this.cursor,
        expectedExchange: { id: expected.id, name: expected.name },
        differences: comparison.differences,
        nearest: { id: nearest.exchange.id, name: nearest.exchange.name, position: nearest.index + 1, differences: nearest.comparison.differences }
      };
      this.#history("unmatched", request, diagnostic);
      return { ok: false, status: 409, diagnostic };
    }
    const token = `${this.cursor}:${performance.now()}`;
    const prepared = {
      ok: true,
      token,
      cursor: this.cursor,
      exchange: expected,
      variables: comparison.variables,
      response: render(expected.response, comparison.variables)
    };
    this.pending = prepared;
    return prepared;
  }

  commit(token, request) {
    if (!this.pending || this.pending.token !== token || this.pending.cursor !== this.cursor) throw new Error("Replay preparation is no longer current");
    const completed = this.pending;
    this.variables = completed.variables;
    this.cursor += 1;
    this.pending = null;
    this.#history("matched", request, { exchangeId: completed.exchange.id, exchangeName: completed.exchange.name, delayMs: completed.response.delay.ms, status: completed.response.status });
    return completed.response;
  }

  cancel(token) {
    if (this.pending?.token === token) this.pending = null;
  }

  #history(outcome, request, detail) {
    this.history.push({ outcome, sequencePosition: this.cursor + 1, method: request.method, path: request.path, detail });
    if (this.history.length > 500) this.history.shift();
  }

  snapshot() {
    return { cassette: this.cassette.name, cursor: this.cursor, total: this.cassette.exchanges.length, activeDelay: this.pending?.response.delay.ms ?? null, history: structuredClone(this.history) };
  }
}

export function waitForDelay(milliseconds, signal) {
  if (milliseconds === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve(); }, milliseconds);
    const onAbort = () => { clearTimeout(timer); cleanup(); reject(new Error("Replay request cancelled during deliberate delay")); };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
