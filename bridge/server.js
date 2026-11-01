import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { SYSTEM, tasks } from '../extension/tasks.js';

const PORT = Number(process.env.PORT ?? 4777);
const MODEL = process.env.FEED_MODEL ?? 'sonnet';
const TIMEOUT_MS = 120_000;
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

function runClaude(prompt, schema) {
  const args = [
    '-p',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(schema),
    '--model', MODEL,
    '--tools', '',
    '--system-prompt', SYSTEM,
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(new Error(`could not start claude: ${e.message}`)));
    const killer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(killer);
      if (signal) return reject(new Error(`claude killed (${signal}) after ${TIMEOUT_MS / 1000}s`));
      try {
        const parsed = JSON.parse(out);
        if (parsed.is_error) throw new Error(`claude error: ${parsed.result ?? parsed.subtype}`);
        resolve(parsed.structured_output ?? JSON.parse(parsed.result));
      } catch (e) {
        reject(new Error(`claude exited ${code}: ${e.message} ${(err || out).slice(0, 300)}`));
      }
    });
    child.stdin.end(prompt);
  });
}

function send(res, status, body, origin) {
  res.writeHead(status, {
    'content-type': 'application/json',
    ...(origin && { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type, x-feed-fixer' }),
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  // Chrome sends no Origin for extension requests to hosts in host_permissions, so the
  // extension proves itself with a custom header instead. A web page can only attach one
  // after a CORS preflight, which is refused below. The Host check stops DNS rebinding.
  const origin = req.headers.origin ?? '';
  const fromWebPage = origin && !origin.startsWith('chrome-extension://');
  if (!ALLOWED_HOSTS.has(req.headers.host) || fromWebPage) return send(res, 403, { error: 'forbidden' });
  if (req.method === 'OPTIONS') return send(res, 204, {}, origin);
  if (req.headers['x-feed-fixer'] !== '1') return send(res, 403, { error: 'missing x-feed-fixer header' });

  const name = req.url.slice(1);
  if (req.method === 'GET' && name === 'health') return send(res, 200, { ok: true, model: MODEL }, origin);
  const task = tasks[name];
  if (req.method !== 'POST' || !task) return send(res, 404, { error: 'not found' }, origin);

  let body = '';
  for await (const chunk of req) body += chunk;
  const started = Date.now();
  try {
    const result = await runClaude(task.prompt(JSON.parse(body)), task.schema);
    console.log(`${name} ok in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    send(res, 200, result, origin);
  } catch (e) {
    console.error(`${name} failed:`, e.message);
    send(res, 500, { error: e.message }, origin);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`feed bridge on http://127.0.0.1:${PORT} (claude --model ${MODEL})`);
});
