import { searchCandidates, recentUploads, latestVideos } from './youtube.js';
import { engage, scrapeFeed, markNotInterested } from './page.js';
import { resolveProvider, ask } from './ai.js';

const CANDIDATES_TO_REVIEW = 60;
const PERSIST_EVERY_MS = 300;

const STEPS = [
  ['plan', 'Claude turns your description into search queries'],
  ['search', 'Search YouTube for creators'],
  ['pick', 'Claude picks the best-matching creators'],
  ['videos', 'Fetch each creator\'s latest videos'],
  ['engage', 'Like, subscribe and watch'],
  ['prune', 'Mark off-niche home feed videos "Not interested"'],
];

const BADGE_COLORS = { running: '#666', stopping: '#666', stopped: '#666', done: '#2a8', failed: '#e5322d' };

/** @type {{status: 'running'|'stopping'|'done'|'failed'|'stopped', startedAt: number, finishedAt?: number, error?: string, steps: Record<string, {label: string, status: 'pending'|'active'|'done'|'failed'|'skipped', detail: string}>, channels: Array<any>, jobs: Array<any>} | null} */
let run = null;
let lastWrite = 0;
let lastStatus = null;

const isActive = () => run?.status === 'running' || run?.status === 'stopping';

export function startRun(description, settings) {
  if (isActive()) return { error: 'already running' };
  run = {
    status: 'running', startedAt: Date.now(), channels: [], jobs: [],
    steps: Object.fromEntries(STEPS.map(([key, label]) => [key, { label, status: 'pending', detail: '' }])),
  };
  execute(description, settings).catch((e) => console.error('run crashed', e));
  return { ok: true };
}

export function stopRun() {
  if (run?.status === 'running') {
    run.status = 'stopping';
    persist();
  }
  return { ok: true };
}

function badgeText() {
  if (run.status === 'done') return '✓';
  if (run.status === 'failed') return '!';
  if (!isActive()) return '';
  if (!run.jobs.length) return '…';
  const finished = run.jobs.filter((j) => j.status === 'done' || j.status === 'failed').length;
  return `${Math.floor((100 * finished) / run.jobs.length)}%`;
}

function persist() {
  if (run.status === lastStatus && Date.now() - lastWrite < PERSIST_EVERY_MS) return;
  lastStatus = run.status;
  lastWrite = Date.now();
  chrome.storage.session.set({ run });
  chrome.action.setBadgeText({ text: badgeText() });
  chrome.action.setBadgeBackgroundColor({ color: BADGE_COLORS[run.status] });
}

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
// playback. So workers tile the primary display's work area, never overlapping.
async function openWorkers(count) {
  const displays = await chrome.system.display.getInfo();
  const { left: x0, top: y0, width: W, height: H } = (displays.find((d) => d.isPrimary) ?? displays[0]).workArea;
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const w = Math.floor(W / cols);
  const h = Math.floor(H / rows);
  const windows = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      chrome.windows.create({
        url: 'about:blank', type: 'popup', focused: false, width: w, height: h,
        left: x0 + (i % cols) * w, top: y0 + Math.floor(i / cols) * h,
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

class Stopped extends Error {}

async function step(key, fn) {
  if (run.status !== 'running') throw new Stopped('stopped');
  const s = run.steps[key];
  s.status = 'active';
  persist();
  try {
    s.detail = (await fn()) ?? '';
    s.status = 'done';
  } catch (e) {
    s.status = 'failed';
    s.detail = e.message;
    throw e;
  } finally {
    persist();
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
      persist();
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
      persist();
    }
  }));
  if (signedOut) throw new Error('You are not signed in to YouTube in this Chrome profile.');
}

async function execute(description, s) {
  const ticker = setInterval(persist, 1000);
  persist();
  let workers = [];
  try {
    const provider = await resolveProvider();
    if (provider.kind === 'none') throw new Error('No Claude Code bridge and no API key. Open the popup to add one.');

    let plan;
    await step('plan', async () => {
      plan = await ask(provider, 'plan', { description });
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
      const { channels } = await ask(provider, 'pick', { description, plan, candidates: compact, count: s.creators });
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
        const { offNiche } = await ask(provider, 'classify', { description, plan, tiles });
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
    for (const st of Object.values(run.steps)) {
      if (st.status === 'pending') Object.assign(st, { status: 'skipped', detail: 'not run' });
    }
    await closeWorkers(workers);
    run.finishedAt = Date.now();
    clearInterval(ticker);
    persist();
  }
}
