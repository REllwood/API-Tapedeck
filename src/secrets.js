export const REDACTED = "REDACTED";
const SECRET_NAME = /token|secret|password|passwd|credential|authorization|cookie|api[_-]?key|access[_-]?key|private[_-]?key/i;
const TEMPLATE = /^\{\{[A-Za-z][A-Za-z0-9_]*\}\}$/;
const TEMPLATES = /\{\{[A-Za-z][A-Za-z0-9_]*\}\}/g;
const QUERY_PARAMETER = /([?&#])([^=&#\s"'<>]+)=([^&#\s"'<>]+)/g;
const EMBEDDED = [
  { label: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: () => REDACTED },
  { label: "JSON Web Token", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, replace: () => REDACTED },
  { label: "bearer token", pattern: /\b(Bearer\s+)[A-Za-z0-9\-._~+/]{16,}=*/gi, replace: (_, prefix) => `${prefix}${REDACTED}` },
  { label: "AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: () => REDACTED },
  { label: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g, replace: () => REDACTED },
  { label: "Slack token", pattern: /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g, replace: () => REDACTED },
  { label: "Stripe key", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, replace: () => REDACTED },
  { label: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: () => REDACTED }
];

function decodeName(value) {
  try { return decodeURIComponent(value); }
  catch { return value; }
}

export function isSecretName(name) {
  return SECRET_NAME.test(name);
}

export function scrubText(value) {
  const found = [];
  let text = value.replace(QUERY_PARAMETER, (match, separator, name, parameter) => {
    if (!isSecretName(decodeName(name)) || parameter === REDACTED || TEMPLATE.test(parameter)) return match;
    found.push(`query parameter ${decodeName(name)}`);
    return `${separator}${name}=${REDACTED}`;
  });
  for (const { label, pattern, replace } of EMBEDDED) {
    text = text.replace(pattern, (...match) => {
      found.push(label);
      return replace(...match);
    });
  }
  return { text, found };
}

export function isPlaceholder(value) {
  if (value === null || typeof value === "boolean" || value === "") return true;
  if (typeof value !== "string" || !(value.includes("{{") || value.includes(REDACTED))) return false;
  return /^\s*(?:(?:bearer|basic|token)\s*)?$/i.test(value.replaceAll(TEMPLATES, "").replaceAll(REDACTED, ""));
}

export function literalSecrets(value, path, found = []) {
  if (typeof value === "string") {
    if (scrubText(value).found.length > 0) found.push(path);
  } else if (Array.isArray(value)) value.forEach((item, index) => literalSecrets(item, `${path}[${index}]`, found));
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (isSecretName(key) && !isPlaceholder(item)) found.push(`${path}.${key}`);
      else literalSecrets(item, `${path}.${key}`, found);
    }
  }
  return found;
}
