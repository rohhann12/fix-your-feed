import { searchCandidates, recentUploads, latestVideos } from './youtube.js';
import { engage, scrapeFeed, markNotInterested } from './page.js';

const BRIDGE = 'http://127.0.0.1:4777';
const DEFAULTS = {
  creators: 15, videosPerCreator: 10, watchPerCreator: 3, watchSeconds: 20, workers: 3, minutes: 20,
  like: true, subscribe: true, watch: true, notInterested: true,
};
const SECONDS_PER_VIDEO = 6;
const CANDIDATES_TO_REVIEW = 60;

const STEPS = [
  ['plan', 'Claude turns your description into search queries'],
  ['search', 'Search YouTube for creators'],
  ['pick', 'Claude picks the best-matching creators'],
  ['videos', 'Fetch each creator\'s latest videos'],
  ['engage', 'Like, subscribe and watch'],
  ['prune', 'Mark off-niche home feed videos "Not interested"'],
];

const $ = (id) => document.getElementById(id);
const form = $('form');

/** @type {{status: 'running'|'stopping'|'done'|'failed'|'stopped', steps: Record<string, {status: string, detail: string}>, channels: Array<any>, jobs: Array<any>, startedAt: number} | null} */
let run = null;

// ---------- settings ----------

function readSettings() {
  const s = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    const el = form.elements[key];
    s[key] = el.type === 'checkbox' ? el.checked : clamp(Number(el.value), Number(el.min), Number(el.max));
  }
  return s;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));

function estimateSeconds(s) {
  const videos = s.creators * s.videosPerCreator;
  const watching = s.watch ? s.creators * Math.min(s.watchPerCreator, s.videosPerCreator) * s.watchSeconds : 0;
  return (videos * SECONDS_PER_VIDEO + watching) / s.workers + overheadSeconds(s);
}

const overheadSeconds = (s) => 45 + (s.notInterested ? 45 : 0);

function renderEstimate() {
  const s = readSettings();
  const fastest = Math.ceil(estimateSeconds(s) / 60);
  $('estimate').textContent = fastest > s.minutes
    ? `${s.creators * s.videosPerCreator} videos won't fit in ${s.minutes} min (needs ~${fastest}). Add windows or watch less.`
    : `${s.creators * s.videosPerCreator} videos, spread over about ${s.minutes} min`;
  chrome.storage.local.set({ settings: s, description: $('description').value });
}

async function loadSettings() {
  const { settings = {}, description = '' } = await chrome.storage.local.get(['settings', 'description']);
  const s = { ...DEFAULTS, ...settings };
  for (const [key, value] of Object.entries(s)) {
    const el = form.elements[key];
    if (el) el[el.type === 'checkbox' ? 'checked' : 'value'] = value;
  }
  $('description').value = description;
  renderEstimate();
}

// ---------- bridge ----------

async function bridge(path, body) {
  const res = await fetch(`${BRIDGE}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-feed-fixer': '1' },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(150_000),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `bridge ${path} failed`);
  return json;
}

async function checkBridge() {
  const pill = $('bridge');
  try {
    const { model } = await bridge('health');
    pill.textContent = `Claude Code bridge connected (${model})`;
    pill.className = 'pill ok';
    return true;
  } catch (e) {
    console.error('bridge health check failed', e);
    pill.textContent = `bridge unreachable: ${e.message}`;
    pill.className = 'pill bad';
    return false;
  }
}

// ---------- browser workers ----------

function loadTab(tabId, url, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const done = (fn) => (arg) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      fn(arg);
    };
    const ok = done(resolve);
    const fail = done(reject);
    const onUpdated = (id, info, tab) => id === tabId && info.status === 'complete' && tab.url?.startsWith(url) && ok();
    const timer = setTimeout(() => fail(new Error('page load timed out')), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.update(tabId, { url }).catch(fail);
  });
}

async function inject(tabId, func, args, timeoutMs) {
  const exec = chrome.scripting.executeScript({ target: { tabId }, func, args }).then(([r]) => r?.result);
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('script timed out')), timeoutMs));
  return Promise.race([exec, timeout]);
}

// macOS treats a fully covered window as hidden, which throttles timers and can pause
// playback. So the dashboard shrinks to a left column and workers tile the rest, never overlapping.
async function openWorkers(count) {
  const { availLeft: x0, availTop: y0, availWidth: W, availHeight: H } = screen;
  const dashWidth = Math.min(420, Math.floor(W / 3));
  const me = await chrome.windows.getCurrent();
  await chrome.windows.update(me.id, { state: 'normal', left: x0, top: y0, width: dashWidth, height: H });

  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const w = Math.floor((W - dashWidth) / cols);
  const h = Math.floor(H / rows);
  const windows = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      chrome.windows.create({
        url: 'about:blank', type: 'popup', focused: false, width: w, height: h,
        left: x0 + dashWidth + (i % cols) * w, top: y0 + Math.floor(i / cols) * h,
      }),
    ),
  );
  const workers = windows.map((win) => ({ windowId: win.id, tabId: win.tabs[0].id }));
  await chrome.storage.session.set({ workerWindows: workers.map((w) => w.windowId) });
  return workers;
}

async function closeWorkers(workers) {
  await Promise.allSettled(workers.map((w) => chrome.windows.remove(w.windowId)));
  await chrome.storage.session.remove('workerWindows');
}

// ---------- the run ----------

class Stopped extends Error {}

async function step(key, fn) {
  if (run.status !== 'running') throw new Stopped('stopped');
  const s = run.steps[key];
  s.status = 'active';
  render();
  try {
    s.detail = (await fn()) ?? '';
    s.status = 'done';
  } catch (e) {
    s.status = 'failed';
    s.detail = e.message;
    throw e;
  } finally {
    render();
  }
}

function skip(key, why) {
  Object.assign(run.steps[key], { status: 'skipped', detail: why });
}

/** One job per video. Round-robin across channels so every creator gets touched early and parallel windows hit different channels. */
function buildJobs(channels, s) {
  const jobs = [];
  const longest = Math.max(0, ...channels.map((c) => c.videos.length));
  for (let i = 0; i < longest; i++) {
    for (const c of channels) {
      const v = c.videos[i];
      if (!v) continue;
      jobs.push({
        videoId: v.id, title: v.title, channelId: c.id,
        like: s.like,
        subscribe: s.subscribe && i === 0,
        watchSec: s.watch && i < s.watchPerCreator ? s.watchSeconds : 0,
        status: 'queued', result: null, error: '',
      });
    }
  }
  return jobs;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Spreads job starts across the time left before the target finish, with random gaps so it doesn't look robotic. */
function pacer(s) {
  const finishBy = run.startedAt + s.minutes * 60_000 - (s.notInterested ? 45_000 : 0);
  const interval = Math.max(0, (finishBy - Date.now()) / run.jobs.length);
  let nextStart = Date.now();
  return async () => {
    const wait = nextStart - Date.now();
    nextStart = Math.max(nextStart, Date.now()) + interval * (0.5 + Math.random());
    for (const until = Date.now() + wait; Date.now() < until && run.status === 'running';) await sleep(Math.min(500, until - Date.now()));
  };
}

async function runJobs(workers, s) {
  const queue = run.jobs.slice();
  const awaitTurn = pacer(s);
  let signedOut = false;
  await Promise.all(workers.map(async ({ tabId }) => {
    while (run.status === 'running' && !signedOut && queue.length) {
      await awaitTurn();
      const job = run.status === 'running' && queue.shift();
      if (!job) break;
      job.status = 'running';
      render();
      if (!(await chrome.tabs.get(tabId).catch(() => null))) {
        job.status = 'queued';
        queue.unshift(job);
        return;
      }
      try {
        await loadTab(tabId, `https://www.youtube.com/watch?v=${job.videoId}`);
        const r = await inject(tabId, engage, [job], (job.watchSec + 60) * 1000);
        if (r?.error === 'NOT_SIGNED_IN') signedOut = true;
        if (!r || r.error) throw new Error(r?.error ?? 'no result from page');
        job.result = r;
        job.status = 'done';
      } catch (e) {
        job.error = e.message;
        job.status = 'failed';
      }
      render();
    }
  }));
  if (signedOut) throw new Error('You are not signed in to YouTube in this Chrome profile.');
}

async function start(description, s) {
  run = {
    status: 'running', startedAt: Date.now(), channels: [], jobs: [],
    steps: Object.fromEntries(STEPS.map(([key]) => [key, { status: 'pending', detail: '' }])),
  };
  render();
  let workers = [];
  try {
    if (!(await checkBridge())) throw new Error('Claude Code bridge is offline. Run `npm run bridge` in the project folder.');

    let plan;
    await step('plan', async () => {
      plan = await bridge('plan', { description });
      return plan.niche;
    });

    let candidates;
    await step('search', async () => {
      const found = (await searchCandidates(plan.queries)).slice(0, CANDIDATES_TO_REVIEW);
      const uploads = await Promise.allSettled(found.map((c) => recentUploads(c.id)));
      candidates = found
        .map((c, i) => uploads[i].status === 'fulfilled' && { ...c, ...uploads[i].value })
        .filter((c) => c && c.titles.length);
      return `${candidates.length} candidate channels from ${plan.queries.length} searches`;
    });

    await step('pick', async () => {
      const compact = candidates.map(({ id, name, subscribers, description: d, titles, daysSinceUpload }) =>
        ({ id, name, subscribers, about: d, recent: titles, daysSinceUpload }));
      const { channels } = await bridge('pick', { description, plan, candidates: compact, count: s.creators });
      const byId = new Map(candidates.map((c) => [c.id, c]));
      const seen = new Set();
      run.channels = channels
        .filter((p) => byId.has(p.id) && !seen.has(p.id) && seen.add(p.id))
        .slice(0, s.creators)
        .map((p) => ({ ...byId.get(p.id), reason: p.reason, videos: [] }));
      if (!run.channels.length) throw new Error('Claude found no matching creators. Try a broader description.');
      return `${run.channels.length} creators`;
    });

    await step('videos', async () => {
      const lists = await Promise.allSettled(run.channels.map((c) => latestVideos(c.id, s.videosPerCreator)));
      run.channels.forEach((c, i) => (c.videos = lists[i].status === 'fulfilled' ? lists[i].value : []));
      run.jobs = buildJobs(run.channels, s);
      return `${run.jobs.length} videos queued`;
    });

    const needsBrowser = s.like || s.subscribe || s.watch;
    if (needsBrowser || s.notInterested) workers = await openWorkers(needsBrowser ? s.workers : 1);

    if (needsBrowser) {
      await step('engage', async () => {
        await runJobs(workers, s);
        const done = run.jobs.filter((j) => j.status === 'done');
        const liked = done.filter((j) => j.result.liked).length;
        const subs = done.filter((j) => j.result.subscribed).length;
        const secs = done.reduce((t, j) => t + j.result.watched, 0);
        return `${liked} liked, ${subs} subscribed, ${Math.round(secs / 60)} min watched`;
      });
    } else skip('engage', 'all actions off');

    if (s.notInterested && run.status === 'running') {
      await step('prune', async () => {
        const { tabId } = workers[0];
        await loadTab(tabId, 'https://www.youtube.com/');
        const tiles = await inject(tabId, scrapeFeed, [40], 30000);
        if (!tiles?.length) return 'no feed videos found';
        const { offNiche } = await bridge('classify', { description, plan, tiles });
        const marked = offNiche.length ? await inject(tabId, markNotInterested, [offNiche], 120000) : [];
        return `${marked.length} of ${tiles.length} feed videos marked "Not interested"`;
      });
    } else if (run.steps.prune.status === 'pending') skip('prune', s.notInterested ? 'stopped' : 'off');

    run.status = run.status === 'stopping' ? 'stopped' : 'done';
  } catch (e) {
    if (run.status === 'stopping' || e instanceof Stopped) run.status = 'stopped';
    else {
      run.status = 'failed';
      run.error = e.message;
    }
  } finally {
    for (const s of Object.values(run.steps)) {
      if (s.status === 'pending') Object.assign(s, { status: 'skipped', detail: 'not run' });
    }
    await closeWorkers(workers);
    run.finishedAt = Date.now();
    render();
  }
}

// ---------- rendering ----------

let frame = 0;
function render() {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(draw);
}

function draw() {
  if (!run) return;
  const active = run.status === 'running' || run.status === 'stopping';
  $('run').hidden = false;
  $('start').disabled = active;
  $('stop').hidden = !active;
  $('stop').disabled = run.status === 'stopping';

  $('steps').replaceChildren(...STEPS.map(([key, label]) => {
    const li = document.createElement('li');
    const { status, detail } = run.steps[key];
    li.className = status;
    li.textContent = label;
    if (detail) li.append(Object.assign(document.createElement('span'), { className: 'detail', textContent: detail }));
    return li;
  }));

  const finished = run.jobs.filter((j) => j.status === 'done' || j.status === 'failed').length;
  const failed = run.jobs.filter((j) => j.status === 'failed');
  $('bar').style.width = run.jobs.length ? `${(100 * finished) / run.jobs.length}%` : '0';
  const elapsed = Math.round(((run.finishedAt ?? Date.now()) - run.startedAt) / 1000);
  const parts = [
    `${finished}/${run.jobs.length} videos`,
    `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`,
    failed.length && `${failed.length} failed (${[...new Set(failed.map((j) => j.error))].slice(0, 2).join('; ')})`,
    run.status === 'done' && 'Done. Refresh youtube.com to see your new feed.',
    run.status === 'stopped' && 'Stopped.',
    run.error && `Error: ${run.error}`,
  ];
  $('summary').textContent = parts.filter(Boolean).join(' · ');

  $('channels').replaceChildren(...run.channels.map((c) => {
    const li = document.createElement('li');
    const jobs = run.jobs.filter((j) => j.channelId === c.id);
    const done = jobs.filter((j) => j.status === 'done').length;
    const a = Object.assign(document.createElement('a'), {
      href: `https://www.youtube.com/channel/${c.id}`, target: '_blank', textContent: `${c.name} `,
    });
    a.append(Object.assign(document.createElement('small'), { textContent: c.subscribers }));
    li.append(
      a,
      Object.assign(document.createElement('span'), { className: 'count', textContent: `${done}/${jobs.length}` }),
      Object.assign(document.createElement('span'), { className: 'reason', textContent: c.reason }),
    );
    return li;
  }));
}

setInterval(() => run?.status === 'running' && render(), 1000);

// ---------- wiring ----------

form.addEventListener('input', renderEstimate);
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const description = $('description').value.trim();
  if (description) start(description, readSettings());
});
$('stop').addEventListener('click', () => {
  if (run?.status === 'running') run.status = 'stopping';
  render();
});
window.addEventListener('beforeunload', (e) => {
  if (run?.status === 'running') e.preventDefault();
});

loadSettings();
checkBridge();
