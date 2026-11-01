import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT ?? 4777);
const MODEL = process.env.FEED_MODEL ?? 'sonnet';
const TIMEOUT_MS = 120_000;
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

const SYSTEM = 'You help a user reshape their YouTube recommendations. Answer only with the requested structured output. Be concrete and decisive.';

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

const strings = { type: 'array', items: { type: 'string' } };

const tasks = {
  plan: {
    schema: {
      type: 'object',
      properties: { niche: { type: 'string' }, avoid: { type: 'string' }, queries: strings },
      required: ['niche', 'avoid', 'queries'],
    },
    prompt: ({ description }) => `The user wants their YouTube home feed to look like this:

"""${description}"""

1. niche: restate what they want in one precise sentence.
2. avoid: one sentence on what clearly does NOT belong (infer from their wording; e.g. "calm" implies no clickbait/drama).
3. queries: 10 diverse YouTube search queries that surface creators who consistently make this content. Cover different sub-topics and formats, use the words creators put in titles, and include a couple of queries naming well-known creators in the space if you know any. No duplicates.`,
  },

  pick: {
    schema: {
      type: 'object',
      properties: {
        channels: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, reason: { type: 'string' } },
            required: ['id', 'reason'],
          },
        },
      },
      required: ['channels'],
    },
    prompt: ({ description, plan, candidates, count }) => `The user wants this YouTube feed:
"""${description}"""
Niche: ${plan.niche}
Avoid: ${plan.avoid}

Below are real channels found by searching YouTube, with their recent upload titles and how many days ago they last uploaded. Pick the ${count} channels that best match, ranked best first.

Prefer channels whose recent uploads are consistently on-niche, that uploaded within the last ~6 months, and a mix of big and mid-size creators. Skip channels under ~5k subscribers unless nothing better exists: the recommender learns little from tiny channels. Reject reupload/compilation farms, kids content, AI slop, and channels that only touch the topic occasionally. If fewer than ${count} are genuinely good, return fewer. Use the exact "id" values from the list. reason: under 12 words.

Candidates:
${JSON.stringify(candidates)}`,
  },

  classify: {
    schema: {
      type: 'object',
      properties: { offNiche: strings },
      required: ['offNiche'],
    },
    prompt: ({ description, plan, tiles }) => `The user wants this YouTube feed:
"""${description}"""
Niche: ${plan.niche}
Avoid: ${plan.avoid}

These videos are on their home feed right now. Return the "id" of every video that clearly does not belong in the feed they described, so we can mark it "Not interested". Keep anything on-niche or closely adjacent. When unsure, keep it.

${JSON.stringify(tiles)}`,
  },
};

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
