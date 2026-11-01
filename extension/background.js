import { startRun, stopRun } from './run.js';
import { resolveProvider } from './ai.js';

const recovered = recover();

// A fresh service worker holds no live run, so an active run in storage and any saved
// worker windows belong to a worker that died.
async function recover() {
  const { run, workerWindows = [] } = await chrome.storage.session.get(['run', 'workerWindows']);
  await Promise.allSettled(workerWindows.map((id) => chrome.windows.remove(id)));
  await chrome.storage.session.remove('workerWindows');
  if (run?.status !== 'running' && run?.status !== 'stopping') return;
  await chrome.storage.session.set({ run: { ...run, status: 'failed', error: 'Extension restarted mid-run', finishedAt: Date.now() } });
  await chrome.action.setBadgeText({ text: '' });
}

async function maskedProvider() {
  const provider = await resolveProvider();
  return provider.kind === 'api' ? { ...provider, key: `····${provider.key.slice(-4)}` } : provider;
}

const handlers = {
  start: ({ description, settings }) => startRun(description, settings),
  stop: () => stopRun(),
  provider: () => maskedProvider(),
};

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  const handle = handlers[message?.type];
  if (!handle) return false;
  recovered
    .then(() => handle(message))
    .then(respond, (e) => respond({ error: e.message }));
  return true;
});
