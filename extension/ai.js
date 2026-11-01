import { SYSTEM, tasks } from './tasks.js';

const BRIDGE = 'http://127.0.0.1:4777';
const API = 'https://api.anthropic.com/v1';
const MODEL = 'claude-sonnet-5-5';

/** @typedef {{kind: 'bridge', model: string} | {kind: 'api', key: string} | {kind: 'none', reason: string}} Provider */

async function bridge(path, body, timeoutMs = 150_000) {
  const res = await fetch(`${BRIDGE}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-feed-fixer': '1' },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `bridge ${path} failed`);
  return json;
}

async function anthropic(key, path, body) {
  const res = await fetch(`${API}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json',
    },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(150_000),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error('Anthropic rejected this API key.');
  if (!res.ok) throw new Error(json.error?.message ?? `Anthropic API returned ${res.status}`);
  return json;
}

export async function resolveProvider() {
  try {
    const { model } = await bridge('health', undefined, 3000);
    return { kind: 'bridge', model };
  } catch (e) {
    const { apiKey } = await chrome.storage.local.get('apiKey');
    return apiKey ? { kind: 'api', key: apiKey } : { kind: 'none', reason: e.message };
  }
}

export async function ask(provider, name, input) {
  if (provider.kind === 'bridge') return bridge(name, input);
  const { schema, prompt } = tasks[name];
  const message = await anthropic(provider.key, 'messages', {
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt(input) }],
    output_config: { format: { type: 'json_schema', schema } },
  });
  if (message.stop_reason === 'refusal') throw new Error(`Claude declined the ${name} step.`);
  if (message.stop_reason === 'max_tokens') throw new Error(`Claude's ${name} answer hit the token limit and was cut off.`);
  return JSON.parse(message.content.find((b) => b.type === 'text').text);
}

export const verifyApiKey = (key) => anthropic(key, 'models?limit=1');
