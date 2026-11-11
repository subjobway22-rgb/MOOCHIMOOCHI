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


// ---- 같은 동물이 피드에 몰리지 않게 종류별 상한 ----
const SPECIES = JSON.parse(await readFile('species.json', 'utf8'));
export const speciesOf = (title, map = SPECIES) => {
  const e = Object.entries(map).find(([, ws]) => ws.some((w) => /^[\x00-\x7f]+$/.test(w) ? new RegExp(`\\b${esc(w)}(s|es|lings?)?\\b`, 'i').test(title) : title.includes(w)));
  return e ? e[0] : null;   // 강아지, 고양이, 알 수 없음은 null(제한 없음)
};

// ---- 반응(좋아요 비율, 댓글)으로 "정말 귀여운지" 판단 ----
const POS = /귀여|귀엽|사랑스|힐링|심쿵|천사|예쁘|예뻐|아가|꼬물|\b(cute|cutie|adorable|aww+|precious|sweet|lovely|angel)\b|[❤🥰😍🥺💕]/iu;
const NEG = /무서|무섭|징그|소름|혐오|끔찍|불쌍|슬프|가짜|조작|ai\s?영상|ai가|으악|\b(creepy|scary|disturbing|gross|disgusting|nightmare|fake|ai[- ]generated|horrifying|terrifying|yikes|eww+|weird|cursed|wtf)\b|[😱🤢🤮😨🥶]/iu;

export function judgeReaction({ views, likes }, comments) {
  const likeRatio = views > 0 ? likes / views : 0;
  if (views >= 1000 && likes > 0 && likeRatio < 0.002) return { ok: false, why: 'like-ratio', likeRatio };
  if (!comments || comments.length < 5) return { ok: likeRatio >= 0.04, why: 'few-comments', likeRatio, cute: 0 };
  const pos = comments.filter((c) => POS.test(c)).length, neg = comments.filter((c) => NEG.test(c)).length;
  const n = comments.length;
  const ok = pos / n >= 0.15 && neg / n <= 0.1;
  return { ok, why: ok ? 'ok' : 'comments', likeRatio, cute: +(pos / n).toFixed(2), neg: +(neg / n).toFixed(2) };
}

// ---- 구글 뉴스 링크 -> 실제 기사 주소 -> 대표 이미지(og:image) ----
async function realUrl(link) {
  const m = /\/articles\/([^?/]+)/.exec(link);
  if (!m) return null;
  const id = m[1];
  const raw = Buffer.from(id.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (raw[0] === 0x08 && raw[1] === 0x13 && raw[2] === 0x22) {
    let b = raw.subarray(3);
    if (b.length >= 3 && b[b.length - 3] === 0xd2 && b[b.length - 2] === 0x01 && b[b.length - 1] === 0x00) b = b.subarray(0, -3);
    const len = b[0];
    const str = (len >= 0x80 ? b.subarray(2, len + 1) : b.subarray(1, len + 1)).toString('utf8');
    if (!str.startsWith('AU_yqL')) return str;
  }
  const page = await get(`https://news.google.com/rss/articles/${id}`);
  const sg = /data-n-a-sg="([^"]+)"/.exec(page)?.[1], ts = /data-n-a-ts="([^"]+)"/.exec(page)?.[1];
  if (!sg || !ts) return null;
  const inner = JSON.stringify(['garturlreq', [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, ts, sg]);
  const r = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'user-agent': UA },
    body: 'f.req=' + encodeURIComponent(JSON.stringify([[['Fbv4je', inner, null, 'generic']]])), signal: AbortSignal.timeout(20000),
  });
  const parsed = JSON.parse((await r.text()).split('\n\n')[1]);
  return JSON.parse(parsed[0][2])[1] || null;
}

export function pickOgImage(html, base) {
  const m = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/i);
  if (!m) return null;
  try { const u = new URL(decode(m[1]), base).href; return u.startsWith('https://') ? u : null; } catch { return null; }
}

async function enrichNews(item) {
  try {
    const url = await realUrl(item.link);
    if (!url || !/^https?:\/\//.test(url)) return;
    item.link = url;
    const html = (await get(url)).slice(0, 400000);
    const img = pickOgImage(html, url);
    if (img) item.image = img;
  } catch { /* 이미지 없이 보여준다 */ }
}

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
    for (const s of process.env.NO_SEARCH ? [] : cfg.youtubeSearch || []) {
      try {
        const r = await api(`search?part=snippet&type=video&videoDuration=short&videoEmbeddable=true&order=${s.order || 'date'}&maxResults=25&q=${encodeURIComponent(s.q)}&publishedAfter=${new Date(cutoff).toISOString()}`);
        for (const x of r.items || []) candidates.set(x.id.videoId, { title: decode(x.snippet.title), channel: decode(x.snippet.channelTitle), mood: s.mood });
        log.push(`search "${s.q}": ${r.items?.length || 0} 후보`);
      } catch (e) { log.push(`FAIL search "${s.q}": ${e.message}`); }
    }

    // 길이와 임베드 가능 여부는 영상 상세로 확인한다.
    const ids = [...candidates.keys()];
    let kept = 0, rejected = 0;
    const pre = [];
    const whyCount = {};
    let sample = 0;
    for (let i = 0; i < ids.length; i += 50) {
      try {
        const det = await api(`videos?part=contentDetails,status,snippet,statistics&id=${ids.slice(i, i + 50).join(',')}`);
        for (const v of det.items || []) {
          const c = candidates.get(v.id);
          const title = decode(v.snippet.title);
          const iso = toISO(v.snippet.publishedAt);
          if (cfg.blockChannels.some((b) => c.channel.toLowerCase().includes(b))) continue;
          if (!v.status?.embeddable || parseDuration(v.contentDetails.duration) > cfg.maxSeconds) continue;
          if (!iso || Date.parse(iso) < cutoff) continue;
          if (matchesAny(title, cfg.blockWords) || matchesAny(title, cfg.humanWords)) continue;
          if (!matchesAny(title, cfg.cuteWords)) continue;
          const st = v.statistics || {};
          pre.push({ v, c, title, iso, views: +st.viewCount || 0, likes: +st.likeCount || 0 });
        }
      } catch (e) { log.push(`FAIL videos: ${e.message}`); }
    }
    // 제목 조건을 통과한 영상만 댓글을 읽어 귀여운지 판단한다.
    for (const p of pre) {
      let comments = null;
      try {
        const r = await api(`commentThreads?part=snippet&maxResults=50&order=relevance&textFormat=plainText&videoId=${p.v.id}`);
        comments = (r.items || []).map((x) => x.snippet.topLevelComment.snippet.textDisplay);
      } catch { /* 댓글 막힘 */ }
      const j = judgeReaction(p, comments);
      whyCount[j.why + (j.ok ? '+' : '-')] = (whyCount[j.why + (j.ok ? '+' : '-')] || 0) + 1;
      if (sample++ < 8) log.push(`  sample "${p.title.slice(0, 30)}" views=${p.views} likes=${p.likes} comments=${comments ? comments.length : 'none'} -> ${JSON.stringify(j)}`);
      if (!j.ok) { rejected++; continue; }
      items.push({ id: `yt-${p.v.id}`, type: 'video', mood: p.c.mood, animal: true, title: p.title, source: `유튜브 · ${p.c.channel}`, time: p.iso, link: `https://www.youtube.com/watch?v=${p.v.id}`, videoId: p.v.id, cute: j.cute });
      kept++;
    }
    log.push(`영상: 후보 ${ids.length} → 제목 통과 ${pre.length} → 반응 통과 ${kept} (탈락 ${rejected}) ${JSON.stringify(whyCount)}`);
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

  // 뉴스 대표 이미지(링크 미리보기용). 실패하면 이미지 없이 둔다.
  const newsItems = items.filter((i) => i.type === 'news');
  for (let i = 0; i < newsItems.length; i += 5) await Promise.all(newsItems.slice(i, i + 5).map(enrichNews));
  log.push(`뉴스 이미지: ${newsItems.filter((i) => i.image).length}/${newsItems.length}`);

  if (KEY && !items.some((i) => i.type === 'video')) { console.log(log.join('\n')); console.warn('영상이 0개라 feed.json을 바꾸지 않습니다.'); process.exit(0); }
  // 종류별 상한(강아지·고양이는 제한 없음). 반응이 좋은 영상을 우선 남긴다.
  const perSpecies = {};
  items.filter((i) => i.type === 'video').sort((a, b) => (b.cute || 0) - (a.cute || 0)).forEach((i) => {
    i.species = speciesOf(i.title);
    if (!i.species) return;
    perSpecies[i.species] = (perSpecies[i.species] || 0) + 1;
    if (perSpecies[i.species] > cfg.maxPerSpecies) i.drop = true;
  });
  for (let k = items.length - 1; k >= 0; k--) if (items[k].drop) items.splice(k, 1);
  log.push(`종류별 상한 ${cfg.maxPerSpecies}: ${JSON.stringify(perSpecies)}`);

  const seen = new Set();
  const unique = items.filter((i) => !seen.has(i.id) && seen.add(i.id));
  console.log(log.join('\n'));
  if (!unique.length) { console.warn('수집된 항목이 없어 feed.json을 바꾸지 않습니다.'); process.exit(0); }
  unique.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  await writeFile(process.env.NO_SEARCH ? 'feed.quick.json' : 'feed.json', JSON.stringify({ updated: new Date().toISOString(), items: unique }, null, 1) + '\n');
  console.log(`feed.json: ${unique.length} items`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
