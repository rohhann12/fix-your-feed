import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (file) => readFileSync(join(root, file), 'utf8');
let failures = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL  ${name}: ${e.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const { SYSTEM, tasks } = await import(join(root, 'extension/tasks.js'));
const ai = await import(join(root, 'extension/ai.js'));

for (const file of ['extension/run.js', 'extension/background.js', 'extension/popup.js', 'extension/ai.js', 'extension/tasks.js', 'bridge/server.js']) {
  await check(`syntax ${file}`, () => execFileSync(process.execPath, ['--check', join(root, file)], { stdio: 'pipe' }));
}

for (const file of ['extension/background.js', 'extension/run.js']) {
  await check(`${file} uses no DOM globals`, () => {
    const src = read(file);
    const found = ['document.', 'window.', 'screen.', 'requestAnimationFrame'].filter((t) => src.includes(t));
    assert(!found.length, `contains ${found.join(', ')}`);
  });
}

function looseObjects(schema, path = '$') {
  if (!schema || typeof schema !== 'object') return [];
  const here = schema.type === 'object' && schema.additionalProperties !== false ? [path] : [];
  return here.concat(Object.entries(schema).flatMap(([k, v]) => looseObjects(v, `${path}.${k}`)));
}

const sample = { description: 'calm woodworking', plan: { niche: 'n', avoid: 'a' }, candidates: [{ id: 'UC1' }], count: 5, tiles: [{ id: 'v1' }] };
for (const [name, task] of Object.entries(tasks)) {
  await check(`task ${name} renders a prompt and has a strict schema`, () => {
    const prompt = task.prompt(sample);
    assert(typeof prompt === 'string' && prompt.trim(), 'prompt is empty');
    const loose = looseObjects(task.schema);
    assert(!loose.length, `objects without additionalProperties:false at ${loose.join(', ')}`);
  });
}

await check('bridge serves health and plan, refuses requests without the header', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'feed-check-'));
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\ncat > /dev/null\necho '{"structured_output":{"niche":"x","avoid":"y","queries":["a"]}}'\n`, { mode: 0o755 });
  const port = 47771;
  const server = spawn(process.execPath, [join(root, 'bridge/server.js')], {
    env: { ...process.env, PORT: String(port), PATH: `${bin}:${process.env.PATH}` },
    stdio: 'pipe',
  });
  const base = `http://127.0.0.1:${port}`;
  const headers = { 'x-feed-fixer': '1', 'content-type': 'application/json' };
  try {
    let health;
    for (let i = 0; i < 50 && !health; i++) {
      health = await fetch(`${base}/health`, { headers }).catch(() => null);
      if (!health) await new Promise((r) => setTimeout(r, 100));
    }
    assert(health?.status === 200, `health returned ${health?.status}`);
    assert((await health.json()).ok === true, 'health body lacks ok:true');

    const plan = await fetch(`${base}/plan`, { method: 'POST', headers, body: JSON.stringify({ description: 'd' }) });
    assert(plan.status === 200, `plan returned ${plan.status}`);
    assert((await plan.json()).niche === 'x', 'plan did not relay structured_output');

    const bare = await fetch(`${base}/health`);
    assert(bare.status === 403, `headerless request returned ${bare.status}`);
  } finally {
    server.kill();
    rmSync(bin, { recursive: true, force: true });
  }
});

await check('popup.html wires popup.js, popup.css and the ids popup.js reads', () => {
  const html = read('extension/popup.html');
  const ids = [...read('extension/popup.js').matchAll(/\$\('(\w+)'\)/g)].map((m) => m[1]);
  for (const ref of ['popup.js', 'popup.css']) assert(html.includes(ref), `missing ${ref}`);
  const missing = [...new Set([...ids, 'description', 'start', 'stop', 'provider', 'apiKey', 'saveKey'])].filter((id) => !html.includes(`id="${id}"`));
  assert(!missing.length, `missing ids ${missing.join(', ')}`);
});

await check('manifest points at files that exist', () => {
  const manifest = JSON.parse(read('extension/manifest.json'));
  for (const file of [manifest.action.default_popup, manifest.background.service_worker]) read(`extension/${file}`);
  assert(manifest.background.type === 'module', 'service worker is not a module');
});

function stubChrome(local = {}) {
  globalThis.chrome = { storage: { local: { get: async (k) => ({ [k]: local[k] }) } } };
}

function stubFetch(respond) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, ...init, body: init.body && JSON.parse(init.body) });
    const { status = 200, body } = await respond(url, init);
    return new Response(JSON.stringify(body), { status });
  };
  return calls;
}

const realFetch = globalThis.fetch;
await check('resolveProvider prefers bridge, then stored key, then none', async () => {
  stubChrome({ apiKey: 'sk-ant-test-1234' });
  stubFetch(() => ({ body: { ok: true, model: 'sonnet' } }));
  assert((await ai.resolveProvider()).kind === 'bridge', 'bridge up should win');

  stubFetch(() => { throw new TypeError('Failed to fetch'); });
  const api = await ai.resolveProvider();
  assert(api.kind === 'api' && api.key === 'sk-ant-test-1234', `expected api, got ${JSON.stringify(api)}`);

  stubChrome({});
  const none = await ai.resolveProvider();
  assert(none.kind === 'none' && none.reason === 'Failed to fetch', `expected none, got ${JSON.stringify(none)}`);
});

await check('ask(api) sends a structured-output Messages request and parses the text block', async () => {
  const calls = stubFetch(() => ({
    body: { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"niche":"x","avoid":"y","queries":["q"]}' }] },
  }));
  const out = await ai.ask({ kind: 'api', key: 'k' }, 'plan', { description: 'd' });
  assert(out.niche === 'x', `parsed ${JSON.stringify(out)}`);
  const [{ url, headers, body }] = calls;
  assert(url === 'https://api.anthropic.com/v1/messages', `url ${url}`);
  assert(headers['x-api-key'] === 'k' && headers['anthropic-version'] && headers['anthropic-dangerous-direct-browser-access'] === 'true', 'missing auth headers');
  assert(body.model === 'claude-sonnet-5-5' && body.system === SYSTEM, 'wrong model or system');
  const { format } = body.output_config;
  assert(format.type === 'json_schema' && JSON.stringify(format.schema) === JSON.stringify(tasks.plan.schema), 'schema not sent');
  assert(body.messages[0].content === tasks.plan.prompt({ description: 'd' }), 'prompt not sent');
});

await check('ask(api) and verifyApiKey surface refusals, truncation and bad keys', async () => {
  const rejects = async (fn, pattern) => {
    const err = await fn().then(() => null, (e) => e);
    assert(err && pattern.test(err.message), `expected ${pattern}, got ${err?.message ?? 'success'}`);
  };
  stubFetch(() => ({ body: { stop_reason: 'refusal', content: [] } }));
  await rejects(() => ai.ask({ kind: 'api', key: 'k' }, 'plan', { description: 'd' }), /declined/);
  stubFetch(() => ({ body: { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"ni' }] } }));
  await rejects(() => ai.ask({ kind: 'api', key: 'k' }, 'plan', { description: 'd' }), /token limit/);
  const calls = stubFetch(() => ({ status: 401, body: { error: { message: 'invalid x-api-key' } } }));
  await rejects(() => ai.verifyApiKey('bad'), /rejected/);
  assert(calls[0].url === 'https://api.anthropic.com/v1/models?limit=1' && calls[0].method === 'GET', `verify hit ${calls[0].url}`);
  stubFetch(() => ({ status: 529, body: { error: { message: 'Overloaded' } } }));
  await rejects(() => ai.ask({ kind: 'api', key: 'k' }, 'plan', { description: 'd' }), /^Overloaded$/);
});
globalThis.fetch = realFetch;

if (failures) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
