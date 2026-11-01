import { verifyApiKey } from './ai.js';

const DEFAULTS = {
  creators: 15, videosPerCreator: 10, watchPerCreator: 3, watchSeconds: 20, workers: 3, minutes: 20,
  like: true, subscribe: true, watch: true, notInterested: true,
};
const SECONDS_PER_VIDEO = 6;

const PILLS = {
  checking: () => ['checking…', ''],
  bridge: (p) => [`Claude Code connected (${p.model})`, 'ok'],
  api: (p) => [`API key ${p.key}`, 'ok'],
  none: () => ['no AI connected', 'bad'],
};

const $ = (id) => document.getElementById(id);
const form = $('form');

/** @type {import('./ai.js').Provider | null} null while checking; an api key arrives masked */
let provider = null;
let editingKey = false;
let run = null;

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

async function refreshProvider() {
  provider = null;
  draw();
  provider = await chrome.runtime.sendMessage({ type: 'provider' }).catch((e) => ({ kind: 'none', reason: e.message }));
  editingKey = false;
  draw();
}

function draw() {
  const kind = provider?.kind ?? 'checking';
  const [text, tone] = PILLS[kind](provider);
  Object.assign($('provider'), { textContent: text, className: `pill ${tone}`, title: provider?.reason ?? '' });
  $('changeKey').hidden = kind !== 'api' || editingKey;
  $('keyForm').hidden = kind !== 'none' && !editingKey;
  $('removeKey').hidden = !editingKey;

  const active = run?.status === 'running' || run?.status === 'stopping';
  $('start').disabled = active || kind === 'none' || kind === 'checking';
  $('stop').hidden = !active;
  $('stop').disabled = run?.status === 'stopping';
  if (run) drawRun();
}

function drawRun() {
  $('run').hidden = false;
  $('steps').replaceChildren(...Object.values(run.steps).map(({ label, status, detail }) => {
    const li = document.createElement('li');
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

form.addEventListener('input', renderEstimate);
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const description = $('description').value.trim();
  if (!description) return;
  const res = await chrome.runtime.sendMessage({ type: 'start', description, settings: readSettings() });
  if (res?.error) $('estimate').textContent = res.error;
});
$('stop').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'stop' }));

$('keyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = $('apiKey').value.trim();
  $('saveKey').disabled = true;
  $('keyError').textContent = '';
  try {
    await verifyApiKey(key);
    await chrome.storage.local.set({ apiKey: key });
    $('apiKey').value = '';
    await refreshProvider();
  } catch (err) {
    $('keyError').textContent = err.message;
  } finally {
    $('saveKey').disabled = false;
  }
});
$('changeKey').addEventListener('click', (e) => {
  e.preventDefault();
  editingKey = true;
  draw();
});
$('removeKey').addEventListener('click', async () => {
  await chrome.storage.local.remove('apiKey');
  await refreshProvider();
});

chrome.storage.session.onChanged.addListener((changes) => {
  if (!changes.run) return;
  run = changes.run.newValue ?? null;
  draw();
});
setInterval(() => run?.status === 'running' && draw(), 1000);

loadSettings();
chrome.storage.session.get('run').then(({ run: stored }) => {
  run ??= stored ?? null;
  draw();
});
refreshProvider();
