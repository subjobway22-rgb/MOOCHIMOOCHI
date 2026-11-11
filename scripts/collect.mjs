// sources.json에서 영상(짧은 동물 영상)과 뉴스 제목을 모아 feed.json을 만든다.
// 영상: YouTube Data API(YOUTUBE_API_KEY 필요). 뉴스: 구글 뉴스 RSS(제목과 링크만 사용).
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const UA = 'Mozilla/5.0 (compatible; MoochiCollector/1.0)';
const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const decode = (s) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').trim();

const tag = (x, t) => {
  const m = x.match(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`));
  return m ? decode(m[1]) : '';
};
const blocks = (xml, t) => [...xml.matchAll(new RegExp(`<${t}(?:\\s[^>]*)?>[\\s\\S]*?</${t}>`, 'g'))].map((m) => m[0]);

export function parseNews(xml) {
  return blocks(xml, 'item').map((it) => {
    let title = tag(it, 'title');
    const source = tag(it, 'source') || '';
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));
    return { title, source, link: tag(it, 'link'), published: tag(it, 'pubDate') };
  }).filter((n) => n.title && /^https?:\/\//.test(n.link));
}

// 영문 단어는 단어 경계로, 한글은 포함 여부로 비교한다("war"가 "warm"에 걸리지 않게).
export function matchesAny(text, words) {
  return words.some((w) => /^[\x00-\x7f]+$/.test(w) ? new RegExp(`\\b${esc(w)}\\b`, 'i').test(text) : text.includes(w));
}

export function parseDuration(iso) {   // PT1M5S -> 65
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : Infinity;
}

async function get(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'ko,en;q=0.8' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${r.status} ${url.replace(/key=[^&]+/, 'key=***')}`);
  return r.text();
}
const toISO = (s) => { const d = new Date(s); return isNaN(d) ? null : d.toISOString(); };

async function main() {
  const cfg = JSON.parse(await readFile('sources.json', 'utf8'));
  const cutoff = Date.now() - cfg.maxAgeDays * 86400000;
  const KEY = process.env.YOUTUBE_API_KEY;
  const items = [], log = [];

  // ---- 영상 ----
  const api = (path) => get(`https://www.googleapis.com/youtube/v3/${path}&key=${KEY}`).then(JSON.parse);
  const candidates = new Map();   // videoId -> {title, channel, mood}

  if (!KEY) log.push('SKIP youtube: YOUTUBE_API_KEY 없음');
  else {
    for (const s of cfg.youtube) {
      try {
        const ch = (await api(`channels?part=contentDetails,snippet&forHandle=${encodeURIComponent(s.handle)}`)).items?.[0];
        if (!ch) throw new Error('channel not found');
        const pl = await api(`playlistItems?part=snippet,contentDetails&maxResults=${cfg.perSource}&playlistId=${ch.contentDetails.relatedPlaylists.uploads}`);
        for (const x of pl.items || []) candidates.set(x.contentDetails.videoId, { title: x.snippet.title, channel: ch.snippet.title, mood: s.mood });
        log.push(`channel ${s.handle}: ${pl.items?.length || 0} 후보`);
      } catch (e) { log.push(`FAIL ${s.handle}: ${e.message}`); }
    }
    // 채널 이름으로 찾은 채널. 처음 한 번만 검색하고 channels-cache.json에 저장한다.
    const cache = existsSync('channels-cache.json') ? JSON.parse(await readFile('channels-cache.json', 'utf8')) : {};
    for (const s of cfg.youtubeNames || []) {
      try {
        if (!cache[s.name]) {
          const r = await api(`search?part=snippet&type=channel&maxResults=1&regionCode=KR&q=${encodeURIComponent(s.name)}`);
          const c = r.items?.[0];
          if (!c) throw new Error('channel not found');
          cache[s.name] = { id: c.snippet.channelId, title: decode(c.snippet.channelTitle) };
        }
        const { id, title } = cache[s.name];
        const pl = await api(`playlistItems?part=snippet,contentDetails&maxResults=${cfg.perSource * 2}&playlistId=UU${id.slice(2)}`);
        for (const x of pl.items || []) candidates.set(x.contentDetails.videoId, { title: x.snippet.title, channel: title, mood: s.mood });
        log.push(`name "${s.name}" -> ${title} (${id}): ${pl.items?.length || 0} 후보`);
      } catch (e) { log.push(`FAIL name "${s.name}": ${e.message}`); }
    }
    await writeFile('channels-cache.json', JSON.stringify(cache, null, 1) + '\n');
    for (const s of cfg.youtubeSearch || []) {
      try {
        const r = await api(`search?part=snippet&type=video&videoDuration=short&videoEmbeddable=true&order=${s.order || 'date'}&maxResults=25&q=${encodeURIComponent(s.q)}&publishedAfter=${new Date(cutoff).toISOString()}`);
        for (const x of r.items || []) candidates.set(x.id.videoId, { title: decode(x.snippet.title), channel: decode(x.snippet.channelTitle), mood: s.mood });
        log.push(`search "${s.q}": ${r.items?.length || 0} 후보`);
      } catch (e) { log.push(`FAIL search "${s.q}": ${e.message}`); }
    }

    // 길이와 임베드 가능 여부는 영상 상세로 확인한다.
    const ids = [...candidates.keys()];
    let kept = 0;
    for (let i = 0; i < ids.length; i += 50) {
      try {
        const det = await api(`videos?part=contentDetails,status,snippet&id=${ids.slice(i, i + 50).join(',')}`);
        for (const v of det.items || []) {
          const c = candidates.get(v.id);
          const title = decode(v.snippet.title);
          const iso = toISO(v.snippet.publishedAt);
          if (cfg.blockChannels.some((b) => c.channel.toLowerCase().includes(b))) continue;
          if (!v.status?.embeddable || parseDuration(v.contentDetails.duration) > cfg.maxSeconds) continue;
          if (!iso || Date.parse(iso) < cutoff) continue;
          if (matchesAny(title, cfg.blockWords) || matchesAny(title, cfg.humanWords)) continue;
          if (!matchesAny(title, cfg.cuteWords)) continue;
          items.push({ id: `yt-${v.id}`, type: 'video', mood: c.mood, animal: true, title, source: `유튜브 · ${c.channel}`, time: iso, link: `https://www.youtube.com/watch?v=${v.id}`, videoId: v.id });
          kept++;
        }
      } catch (e) { log.push(`FAIL videos: ${e.message}`); }
    }
    log.push(`영상: 후보 ${ids.length} → 통과 ${kept}`);
  }

  // ---- 뉴스 ----
  const newsBlock = [...cfg.blockWords, ...cfg.celebWords, ...cfg.blockPeople];
  for (const s of cfg.news) {
    try {
      const q = `${s.query} ${cfg.newsExclude} when:7d`;
      const xml = await get(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ko&gl=KR&ceid=KR:ko`);
      let n = 0;
      for (const v of parseNews(xml).slice(0, cfg.perSource * 2)) {
        const iso = toISO(v.published);
        if (!iso || matchesAny(v.title, newsBlock)) continue;
        if (cfg.blockSources.some((b) => v.source.includes(b))) continue;
        items.push({ id: `nw-${Buffer.from(v.link).toString('base64url').slice(-24)}`, type: 'news', mood: s.mood, animal: !!s.animal, title: v.title, source: v.source || '뉴스', time: iso, link: v.link });
        if (++n >= cfg.perSource) break;
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
