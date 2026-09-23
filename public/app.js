const ids = ["load-draft", "sanitise", "review", "run", "mismatch", "cancel", "operation-status", "cassette-summary", "exchange-list", "review-empty", "review-content", "review-state", "retained-host", "redaction-count", "variable-list", "selected-name", "selected-exchange", "journey-log", "raw-result"];
const elements = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
const state = { draft: null, cassette: null, reviewToken: null, controller: null, log: [] };
const operationButtons = ["load-draft", "sanitise", "review", "run", "mismatch"];

function setStatus(message, kind = "info") {
  elements["operation-status"].textContent = message;
  elements["operation-status"].dataset.kind = kind;
}

function beginOperation(buttonId, label) {
  state.controller = new AbortController();
  for (const id of operationButtons) elements[id].disabled = true;
  elements.cancel.hidden = false;
  elements[buttonId].textContent = label;
  document.body.setAttribute("aria-busy", "true");
  return state.controller.signal;
}

function finishOperation() {
  state.controller = null;
  elements.cancel.hidden = true;
  elements["load-draft"].textContent = "Load safe recording";
  elements.sanitise.textContent = "Sanitise and validate";
  elements.review.textContent = "Confirm review and load replay";
  elements.run.textContent = "Replay full journey";
  elements.mismatch.textContent = "Send deliberate mismatch";
  elements["load-draft"].disabled = false;
  elements.sanitise.disabled = state.draft === null;
  elements.review.disabled = state.cassette === null || state.cassette.capturePolicy.reviewed;
  elements.run.disabled = false;
  elements.mismatch.disabled = false;
  document.body.setAttribute("aria-busy", "false");
}

async function jsonRequest(path, body, signal) {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(payload.error ?? `Request failed with status ${response.status}`);
  return payload;
}

function renderCassette() {
  const cassette = state.cassette;
  elements["cassette-summary"].textContent = `${cassette.name}. ${cassette.exchanges.length} ordered exchanges; unmatched traffic never falls through.`;
  elements["exchange-list"].replaceChildren();
  cassette.exchanges.forEach((exchange, index) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    const number = document.createElement("span");
    number.className = "exchange-number";
    number.textContent = `Exchange ${index + 1} · ${exchange.name}`;
    const route = document.createElement("span");
    route.className = "exchange-route";
    route.textContent = `${exchange.request.method} ${exchange.request.path}`;
    const delay = document.createElement("span");
    delay.className = "exchange-delay";
    delay.textContent = `${exchange.response.delay.mode} delay: ${exchange.response.delay.ms} ms`;
    button.append(number, route, delay);
    button.addEventListener("click", () => selectExchange(exchange, button));
    item.append(button);
    elements["exchange-list"].append(item);
    if (index === 0) selectExchange(exchange, button);
  });
  elements["review-empty"].hidden = true;
  elements["review-content"].hidden = false;
  elements["review-state"].textContent = cassette.capturePolicy.reviewed ? "Reviewed for local replay" : "Awaiting explicit review";
  elements["retained-host"].textContent = cassette.capturePolicy.retainedHosts.join(", ") || "None";
  elements["redaction-count"].textContent = `${cassette.capturePolicy.redactions.length} removed at ingestion`;
  elements["variable-list"].replaceChildren();
  for (const [name, definition] of Object.entries(cassette.variables)) {
    const item = document.createElement("li");
    item.textContent = `${name} = ${String(definition.value)}. ${definition.description}`;
    elements["variable-list"].append(item);
  }
}

function selectExchange(exchange, button) {
  for (const candidate of elements["exchange-list"].querySelectorAll("button")) candidate.removeAttribute("aria-current");
  button.setAttribute("aria-current", "true");
  elements["selected-name"].textContent = exchange.name;
  elements["selected-exchange"].textContent = JSON.stringify(exchange, null, 2);
}

function addLog(title, detail, raw) {
  state.log.push({ title, detail });
  elements["journey-log"].replaceChildren();
  for (const entry of state.log) {
    const item = document.createElement("li");
    const heading = document.createElement("strong");
    heading.textContent = entry.title;
    const text = document.createElement("span");
    text.textContent = entry.detail;
    item.append(heading, text);
    elements["journey-log"].append(item);
  }
  elements["raw-result"].textContent = JSON.stringify(raw, null, 2);
}

async function replayFetch(path, options, label, signal) {
  const loaded = state.cassette?.capturePolicy.reviewed ? state.cassette : null;
  const exchange = loaded?.exchanges[state.log.length];
  const delay = exchange?.response.delay.ms;
  setStatus(`${label}${delay !== undefined ? `; intentionally waiting ${delay} ms before the cassette response…` : "…"}`);
  const response = await fetch(path, { ...options, signal });
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error ?? `Replay returned ${response.status}`), { body, status: response.status });
  addLog(label, `Matched ${response.headers.get("x-api-tapedeck-exchange")}; HTTP ${response.status}; deliberate delay ${response.headers.get("x-api-tapedeck-delay-ms")} ms.`, body);
  return body;
}

elements["load-draft"].addEventListener("click", async () => {
  const signal = beginOperation("load-draft", "Loading safe recording…");
  setStatus("Loading the bounded synthetic recording from this repository…");
  try {
    const response = await fetch("/fixtures/travel-search-draft.json", { signal });
    if (!response.ok) throw new Error(`Fixture request returned ${response.status}`);
    state.draft = await response.json();
    state.cassette = null;
    state.reviewToken = null;
    setStatus(`Loaded ${state.draft.exchanges.length} synthetic exchanges. Sanitisation is required before review.`);
  } catch (error) { setStatus(error.name === "AbortError" ? "Draft loading cancelled. You can retry safely." : `Draft loading failed: ${error.message}`, error.name === "AbortError" ? "info" : "error"); }
  finally { finishOperation(); }
});

elements.sanitise.addEventListener("click", async () => {
  const signal = beginOperation("sanitise", "Scanning and sanitising…");
  setStatus("Scanning selected headers and body fields, removing secrets and validating cassette bounds…");
  try {
    const result = await jsonRequest("/api/sanitise", { draft: state.draft }, signal);
    state.cassette = result.cassette;
    state.reviewToken = result.reviewToken;
    renderCassette();
    setStatus(`Sanitisation complete: ${state.cassette.capturePolicy.redactions.length} fields removed. Review is still required.`);
  } catch (error) { setStatus(error.name === "AbortError" ? "Sanitisation cancelled. No cassette was presented as reviewed." : `Sanitisation failed: ${error.message}`, error.name === "AbortError" ? "info" : "error"); }
  finally { finishOperation(); }
});

elements.review.addEventListener("click", async () => {
  const signal = beginOperation("review", "Loading reviewed replay…");
  setStatus("Applying explicit review acknowledgement and resetting the local replay sequence…");
  try {
    const result = await jsonRequest("/api/replay/review", { cassette: state.cassette, reviewToken: state.reviewToken }, signal);
    state.cassette = result.cassette;
    state.reviewToken = null;
    renderCassette();
    setStatus(`Reviewed cassette loaded. Local replay is at exchange 1 of ${state.cassette.exchanges.length}; no upstream was contacted.`);
  } catch (error) { setStatus(error.name === "AbortError" ? "Replay loading cancelled. The previous replay cassette remains available." : `Replay loading failed: ${error.message}`, error.name === "AbortError" ? "info" : "error"); }
  finally { finishOperation(); }
});

elements.run.addEventListener("click", async () => {
  const signal = beginOperation("run", "Replaying journey…");
  state.log = [];
  elements["journey-log"].replaceChildren();
  setStatus("Resetting the local cassette before replay…");
  try {
    await jsonRequest("/api/replay/reset", {}, signal);
    const created = await replayFetch("/replay/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ origin: "MEL", destination: "HBA", token: "synthetic-client-value" }) }, "Create travel search", signal);
    await replayFetch(`/replay/sessions/${encodeURIComponent(created.sessionId)}?attempt=1`, {}, "Poll search once", signal);
    await replayFetch(`/replay/sessions/${encodeURIComponent(created.sessionId)}?attempt=2`, {}, "Poll search twice", signal);
    setStatus("Replay complete: three deterministic responses matched in order, including recorded delays.");
  } catch (error) {
    if (error.body) addLog("Replay failed", error.message, error.body);
    setStatus(error.name === "AbortError" ? "Replay cancelled. The cassette remains available and can be reset." : `Replay failed: ${error.message}`, error.name === "AbortError" ? "info" : "error");
  } finally { finishOperation(); }
});

elements.mismatch.addEventListener("click", async () => {
  const signal = beginOperation("mismatch", "Comparing mismatch…");
  state.log = [];
  elements["journey-log"].replaceChildren();
  setStatus("Resetting the cassette, then comparing a deliberately out-of-order request…");
  try {
    await jsonRequest("/api/replay/reset", {}, signal);
    const response = await fetch("/replay/sessions/wrong-session?attempt=9", { signal });
    const body = await response.json();
    if (response.status !== 409) throw new Error(`Expected an unmatched 409 response, received ${response.status}`);
    addLog("Deliberate mismatch", `${body.diagnostic.reason}. Expected ${body.diagnostic.expectedExchange.name}; upstream contacted: ${body.upstreamContacted}.`, body);
    setStatus("Mismatch handled safely: field-level diagnostics returned with no upstream fall-through.");
  } catch (error) { setStatus(error.name === "AbortError" ? "Mismatch comparison cancelled. You can retry." : `Mismatch exercise failed: ${error.message}`, error.name === "AbortError" ? "info" : "error"); }
  finally { finishOperation(); }
});

elements.cancel.addEventListener("click", () => {
  if (!state.controller) return;
  setStatus("Cancelling the current local operation and any deliberate replay delay…");
  elements.cancel.disabled = true;
  state.controller.abort();
  setTimeout(() => { elements.cancel.disabled = false; }, 0);
});
