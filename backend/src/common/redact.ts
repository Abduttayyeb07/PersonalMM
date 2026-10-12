// Scrubs credential material from free-form text before it reaches logs, alerts or responses.
const KEY_VALUE = /(["']?)(apiKey|apiSecret|api_key|api_secret|secret|password|accountPassword|authorization|cookie|set-cookie|signature|listenKey|x-bapi-[\w-]+|x-mexc-apikey)\1\s*([=:])\s*("[^"]*"|'[^']*'|[^\s,;&}]+)/gi;
const LONG_HEX = /\b[a-f0-9]{64}\b/gi;

export function redact(text: string): string {
  return text.replace(KEY_VALUE, '$1$2$1$3[REDACTED]').replace(LONG_HEX, '[REDACTED]');
}

export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (value instanceof Error) return redact(`${value.name}: ${value.message}`);
  if (value && typeof value === 'object') {
    try { return redact(JSON.stringify(value)); } catch { return '[unserializable]'; }
  }
  return value;
}
