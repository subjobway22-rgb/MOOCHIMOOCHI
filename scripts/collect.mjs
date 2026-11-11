// 소스 목록(sources.json)에서 영상과 뉴스 제목을 모아 feed.json을 만든다.
// 영상: 유튜브 채널 공개 RSS. 뉴스: 구글 뉴스 RSS(제목과 링크만 사용).
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const UA = 'Mozilla/5.0 (compatible; MoochiCollector/1.0)';

export const decode = (s) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').trim();

const tag = (x, t) => {
  const m = x.match(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`));
  return m ? decode(m[1]) : '';
};
const blocks = (xml, t) => [...xml.matchAll(new RegExp(`<${t}(?:\\s[^>]*)?>[\\s\\S]*?</${t}>`, 'g'))].map((m) => m[0]);

export function parseYouTube(xml, channelName) {
  return blocks(xml, 'entry').map((e) => ({
    videoId: tag(e, 'yt:videoId'),
    title: tag(e, 'title'),
    published: tag(e, 'published'),
    channel: tag(e, 'name') || channelName,
  })).filter((v) => v.videoId && v.title);
}

export function parseNews(xml) {
  return blocks(xml, 'item').map((it) => {
    let title = tag(it, 'title');
    const source = tag(it, 'source') || '';
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));
    return { title, source, link: tag(it, 'link'), published: tag(it, 'pubDate') };
  }).filter((n) => n.title && /^https?:\/\//.test(n.link));
}

export const isBlocked = (title, words) => {
  const t = title.toLowerCase();
  return words.some((w) => t.includes(w.toLowerCase()));
};

async function get(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'ko,en;q=0.8' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}

async function channelId(handle) {
  const html = await get(`https://www.youtube.com/${handle}`);
  const m = html.match(/"externalId":"(UC[\w-]{22})"/) || html.match(/channel_id=(UC[\w-]{22})/) || html.match(/"channelId":"(UC[\w-]{22})"/);
  if (!m) throw new Error(`channel id not found: ${handle}`);
  return m[1];
}

const toISO = (s) => { const d = new Date(s); return isNaN(d) ? null : d.toISOString(); };

async function main() {
  const cfg = JSON.parse(await readFile('sources.json', 'utf8'));
  const cutoff = Date.now() - cfg.maxAgeDays * 86400000;
  const items = [];
  const log = [];

  const KEY = process.env.YOUTUBE_API_KEY;
  for (const s of cfg.youtube) {
    try {
      let vids;
      if (KEY) {
        // 공식 API(무료 할당량). 업로드 목록을 읽는다.
        const api = (path) => get(`https://www.googleapis.com/youtube/v3/${path}&key=${KEY}`).then(JSON.parse);
        const ch = await api(`channels?part=contentDetails,snippet&forHandle=${encodeURIComponent(s.handle)}`);
        const c = ch.items?.[0];
        if (!c) throw new Error('channel not found');
        const pl = await api(`playlistItems?part=snippet,contentDetails&maxResults=${cfg.perSource}&playlistId=${c.contentDetails.relatedPlaylists.uploads}`);
        vids = (pl.items || []).map((x) => ({ videoId: x.contentDetails.videoId, title: x.snippet.title, published: x.contentDetails.videoPublishedAt || x.snippet.publishedAt, channel: c.snippet.title }))
          .filter((v) => v.title !== 'Private video' && v.title !== 'Deleted video');
      } else {
        // API 키가 없으면 공개 RSS를 시도한다(깃허브 서버 IP에서는 막힐 수 있음).
        const id = await channelId(s.handle);
        vids = parseYouTube(await get(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`), s.handle);
      }
      let n = 0;
      for (const v of vids.slice(0, cfg.perSource)) {
        const iso = toISO(v.published);
        if (!iso || Date.parse(iso) < cutoff || isBlocked(v.title, cfg.blockWords)) continue;
        items.push({ id: `yt-${v.videoId}`, type: 'video', mood: s.mood, animal: true, title: v.title, source: `유튜브 · ${v.channel}`, time: iso, link: `https://www.youtube.com/watch?v=${v.videoId}`, videoId: v.videoId });
        n++;
      }
      log.push(`ok ${s.handle}: ${n} (${KEY ? 'api' : 'rss'})`);
    } catch (e) { log.push(`FAIL ${s.handle}: ${e.message.replace(KEY || '\u0000', '***')}`); }
  }

  for (const s of cfg.news) {
    try {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(s.query + ' when:7d')}&hl=ko&gl=KR&ceid=KR:ko`;
      const xml = await get(url);
      let n = 0;
      for (const v of parseNews(xml).slice(0, cfg.perSource)) {
        const iso = toISO(v.published);
        if (!iso || isBlocked(v.title, cfg.blockWords)) continue;
        items.push({ id: `nw-${Buffer.from(v.link).toString('base64url').slice(-24)}`, type: 'news', mood: s.mood, animal: !!s.animal, title: v.title, source: v.source || '뉴스', time: iso, link: v.link });
        n++;
      }
      log.push(`ok news "${s.query}": ${n}`);
    } catch (e) { log.push(`FAIL news "${s.query}": ${e.message}`); }
  }

  const seen = new Set();
  const unique = items.filter((i) => !seen.has(i.id) && seen.add(i.id));
  console.log(log.join('\n'));
  if (!unique.length) { console.error('수집된 항목이 없어 feed.json을 바꾸지 않습니다.'); process.exit(1); }
  unique.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  await writeFile('feed.json', JSON.stringify({ updated: new Date().toISOString(), items: unique }, null, 1) + '\n');
  console.log(`feed.json: ${unique.length} items`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
