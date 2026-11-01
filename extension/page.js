// Each export is injected with chrome.scripting.executeScript, which serializes the
// function source. They must stay self-contained: no imports, no shared helpers.

/** On a /watch page: like, subscribe, and watch muted for job.watchSec seconds. Returns {error} instead of throwing. */
export async function engage(job) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) {
      const v = fn();
      if (v) return v;
    }
    return null;
  };

  const likeBtn = await waitFor(() => document.querySelector('ytd-watch-metadata like-button-view-model button'), 15000);
  if (!document.querySelector('#avatar-btn')) return { error: 'NOT_SIGNED_IN' };
  if (!likeBtn) return { error: 'like button never appeared' };

  const video = document.querySelector('video.html5-main-video');
  if (video) video.muted = true;

  const result = { liked: false, subscribed: false, watched: 0 };

  if (job.like) {
    const isLiked = () => likeBtn.getAttribute('aria-pressed') === 'true';
    if (!isLiked()) {
      likeBtn.click();
      await waitFor(isLiked, 4000);
    }
    result.liked = isLiked();
  }

  if (job.subscribe) {
    const subBtn = () => document.querySelector('#owner #subscribe-button button');
    const isSubscribed = () => {
      const b = subBtn();
      return b && !/^subscribe\b/i.test(b.innerText.trim());
    };
    const b = await waitFor(subBtn, 5000);
    if (b && !isSubscribed()) {
      b.click();
      await waitFor(isSubscribed, 4000);
    }
    result.subscribed = !!isSubscribed();
  }

  if (job.watchSec > 0 && video) {
    const player = document.querySelector('#movie_player');
    let last = video.currentTime;
    let stalledFor = 0;
    const end = Date.now() + job.watchSec * 1000 + 30000;
    while (result.watched < job.watchSec && Date.now() < end) {
      video.muted = true;
      const ad = player?.classList.contains('ad-showing');
      if (ad) document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button')?.click();
      if (video.paused) video.play().catch(() => {});
      await sleep(1000);
      const delta = video.currentTime - last;
      last = video.currentTime;
      if (!ad && delta > 0 && delta < 5) result.watched += delta;
      stalledFor = delta > 0 || ad ? 0 : stalledFor + 1;
      if (stalledFor >= 10) break;
    }
    result.watched = Math.round(result.watched);
    video.pause();
  }

  return result;
}

/** On the home page: collect the visible video tiles (after scrolling a bit to load more). */
export async function scrapeFeed(target) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tiles = () => [...document.querySelectorAll('ytd-rich-grid-renderer ytd-rich-item-renderer')];
  for (let i = 0; i < 20 && tiles().length === 0; i++) await sleep(250);
  for (let i = 0; i < 4 && tiles().length < target; i++) {
    window.scrollTo(0, document.documentElement.scrollHeight);
    await sleep(1200);
  }
  window.scrollTo(0, 0);

  const seen = new Set();
  const out = [];
  for (const tile of tiles()) {
    if (tile.querySelector('ytd-ad-slot-renderer')) continue;
    const href = tile.querySelector('a[href*="/watch?v="]')?.getAttribute('href');
    const id = href && new URL(href, location.origin).searchParams.get('v');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const meta = tile.querySelector('yt-content-metadata-view-model, #metadata-line')?.innerText.split('\n') ?? [];
    out.push({ id, title: tile.querySelector('h3')?.innerText.trim() ?? '', channel: meta[0] ?? '' });
  }
  return out;
}

/** On the home page: open each tile's menu and choose "Not interested". */
export async function markNotInterested(ids) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) {
      const v = fn();
      if (v) return v;
    }
    return null;
  };
  const wanted = new Set(ids);
  const marked = [];
  for (const tile of document.querySelectorAll('ytd-rich-grid-renderer ytd-rich-item-renderer')) {
    const href = tile.querySelector('a[href*="/watch?v="]')?.getAttribute('href');
    const id = href && new URL(href, location.origin).searchParams.get('v');
    if (!id || !wanted.has(id)) continue;
    const menu = tile.querySelector('button[aria-label="More actions"]');
    if (!menu) continue;
    tile.scrollIntoView({ block: 'center' });
    await sleep(250);
    menu.click();
    const item = await waitFor(
      () => [...document.querySelectorAll('yt-list-item-view-model')].find((e) => e.offsetParent && e.innerText.trim() === 'Not interested'),
      3000,
    );
    if (!item) {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      continue;
    }
    (item.querySelector('[role="menuitem"], button') ?? item).click();
    marked.push(id);
    await sleep(700);
  }
  return marked;
}
