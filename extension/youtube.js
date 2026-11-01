const YT = 'https://www.youtube.com';
const CHANNELS_ONLY = 'EgIQAg%3D%3D';

async function fetchText(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

function initialData(html) {
  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
  if (!m) throw new Error('ytInitialData not found (consent page or layout change?)');
  return JSON.parse(m[1]);
}

function* find(node, key) {
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (k === key) yield v;
    yield* find(v, key);
  }
}

const text = (t) => t?.simpleText ?? t?.content ?? t?.runs?.map((r) => r.text).join('') ?? '';

/** @typedef {{id: string, name: string, handle: string, subscribers: string, description: string, titles: string[], hits: number}} Candidate */

/** Runs every query twice (videos + channels filter) and merges results into candidates keyed by channel id. */
export async function searchCandidates(queries) {
  /** @type {Map<string, Candidate>} */
  const byId = new Map();
  const upsert = (id, patch) => {
    const c = byId.get(id) ?? { id, name: '', handle: '', subscribers: '', description: '', titles: [], hits: 0 };
    c.hits++;
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'title') { if (v && c.titles.length < 5 && !c.titles.includes(v)) c.titles.push(v); }
      else if (v && !c[k]) c[k] = v;
    }
    byId.set(id, c);
  };

  const pages = queries.flatMap((q) => [
    `${YT}/results?search_query=${encodeURIComponent(q)}`,
    `${YT}/results?search_query=${encodeURIComponent(q)}&sp=${CHANNELS_ONLY}`,
  ]);
  const settled = await Promise.allSettled(pages.map(fetchText));
  for (const r of settled) {
    if (r.status !== 'fulfilled') continue;
    let data;
    try {
      data = initialData(r.value);
    } catch {
      continue;
    }
    for (const v of find(data, 'videoRenderer')) {
      const owner = v.ownerText?.runs?.[0];
      const id = owner?.navigationEndpoint?.browseEndpoint?.browseId;
      if (id) upsert(id, { name: owner.text, title: text(v.title) });
    }
    for (const c of find(data, 'channelRenderer')) {
      upsert(c.channelId, {
        name: text(c.title),
        handle: text(c.subscriberCountText).startsWith('@') ? text(c.subscriberCountText) : '',
        subscribers: /subscriber/.test(text(c.videoCountText)) ? text(c.videoCountText) : text(c.subscriberCountText),
        description: text(c.descriptionSnippet).slice(0, 200),
      });
    }
  }
  return [...byId.values()].sort((a, b) => b.hits - a.hits);
}

/** Recent uploads (any format) from the channel's RSS feed: cheap, used to judge niche fit and activity. */
export async function recentUploads(channelId) {
  const xml = await fetchText(`${YT}/feeds/videos.xml?channel_id=${channelId}`);
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
    title: e.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '',
    published: e.match(/<published>(.*?)<\/published>/)?.[1] ?? '',
  }));
  const days = entries[0] ? Math.round((Date.now() - Date.parse(entries[0].published)) / 864e5) : null;
  return { titles: entries.slice(0, 8).map((e) => decode(e.title)), daysSinceUpload: days };
}

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** Latest long-form videos from the channel's Videos tab, newest first. */
export async function latestVideos(channelId, limit) {
  const data = initialData(await fetchText(`${YT}/channel/${channelId}/videos`));
  const out = [];
  for (const l of find(data, 'lockupViewModel')) {
    if (l.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') out.push({ id: l.contentId, title: text(l.metadata?.lockupMetadataViewModel?.title) });
  }
  for (const v of find(data, 'videoRenderer')) out.push({ id: v.videoId, title: text(v.title) });
  const seen = new Set();
  return out.filter((v) => v.id && !seen.has(v.id) && seen.add(v.id)).slice(0, limit);
}
