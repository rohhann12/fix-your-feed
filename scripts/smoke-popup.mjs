// Loads the unpacked extension into a throwaway Chrome over the DevTools pipe (Chrome 137+ ignores
// --load-extension), opens popup.html, prints what it rendered, and screenshots it.
// Usage: node scripts/smoke-popup.mjs [out.png]   (CHROME_BIN overrides the browser path)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const [, , outPng = 'popup.png', headless = '--headless=new'] = process.argv;
const extDir = path.join(here, '..', 'extension');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-fixer-smoke-'));
const chrome = spawn(process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  headless, '--disable-gpu', `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
  '--no-first-run', '--window-size=400,700', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let stderr = '';
chrome.stderr.on('data', (d) => (stderr += d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pending = new Map();
let buf = '';
chrome.stdio[4].on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\0')) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
let id = 0;
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const myId = ++id;
  pending.set(myId, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
  chrome.stdio[3].write(JSON.stringify({ id: myId, method, params, sessionId }) + '\0');
});

try {
  await sleep(1500);
  const { id: extId } = await send('Extensions.loadUnpacked', { path: extDir });
  console.log('extension id', extId);
  await sleep(1000);
  const { targetInfos } = await send('Target.getTargets');
  console.log('extension targets', targetInfos.filter((t) => t.url.includes(extId)).map((t) => `${t.type} ${t.url}`));

  const { targetId } = await send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await sleep(2500);

  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  console.log('page', await evaluate('location.href + " | " + document.title'));
  console.log('popup state', await evaluate(`JSON.stringify({
    pill: document.getElementById('provider').textContent,
    pillClass: document.getElementById('provider').className,
    keyFormHidden: document.getElementById('keyForm').hidden,
    startDisabled: document.getElementById('start').disabled,
    estimate: document.getElementById('estimate').textContent,
    width: document.body.getBoundingClientRect().width,
    height: document.documentElement.scrollHeight,
  })`));
  console.log('provider message reply', JSON.stringify(await evaluate(`chrome.runtime.sendMessage({ type: 'provider' })`)));
  await evaluate(`document.querySelector('details').open = true; 'ok'`);
  await sleep(300);
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
  fs.writeFileSync(outPng, Buffer.from(data, 'base64'));
  console.log('screenshot', outPng);
} finally {
  chrome.kill();
  await sleep(500);
  const errs = stderr.split('\n').filter((l) => /extension|Extension/i.test(l)).slice(-5).join('\n');
  if (errs) console.log('stderr:', errs);
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
