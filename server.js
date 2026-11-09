/**
 * 在线听歌 · 本地音源代理
 * ------------------------------------------------------------
 * 作用：把 QQ音乐 / 酷狗 / 酷我 / 网易云 / 汽水 / 咪咕 / JOOX 的接口统一成
 *       和 music-api.gdstudio.xyz 完全一样的返回格式，并加上 CORS，
 *       让浏览器里的静态页面也能正常搜索和播放。
 *
 * 用法：双击「启动听歌.bat」（或本目录执行 node server.js）
 *       然后打开 http://127.0.0.1:8898
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

// 端口 / 监听地址都可以用环境变量覆盖，方便部署到服务器
//   PORT=9000 node server.js
//   HOST=127.0.0.1 node server.js   ← 只允许本机访问（本地听歌用这个更安全）
const PORT = Number(process.env.PORT) || 8898;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
// 首页文件：优先 index.html（服务器部署版），否则用中文名的（本地版）
const PAGE = fs.existsSync(path.join(ROOT, 'index.html')) ? 'index.html' : '在线听歌.html';
const GD_API = 'https://music-api.gdstudio.xyz/api.php';

/* ---- 歌单云备份存储（换手机用备份码取回歌单） ---- */
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const PLIST_DIR = path.join(DATA_DIR, 'plists');
const PLIST_CODE_RE = /^[A-Za-z0-9]{6,12}$/;
const PLIST_MAX_BYTES = 3 * 1024 * 1024;

function plistPath(code) {
  return path.join(PLIST_DIR, String(code).replace(/[^A-Za-z0-9]/g, '') + '.json');
}
function readRequestBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const UA_MB = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

/* ------------------------------------------------------------------ */
/* 基础 HTTP 请求                                                      */
/* ------------------------------------------------------------------ */

function rawRequest(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const mod = u.protocol === 'https:' ? https : http;
    const headers = Object.assign({ 'Accept-Encoding': 'identity' }, opts.headers || {});
    headers['User-Agent'] = headers['User-Agent'] || UA_PC;
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers,
      timeout: opts.timeout || 15000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (enc === 'gzip') buf = zlib.gunzipSync(buf);
          else if (enc === 'deflate') buf = zlib.inflateSync(buf);
          else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
        } catch (e) { /* 保持原样 */ }
        resolve({ status: res.statusCode, headers: res.headers, body: buf, text: buf.toString('utf8') });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function getJSON(urlStr, opts) {
  const r = await rawRequest(urlStr, opts);
  const t = r.text.trim();
  // 兼容 JSONP
  const m = t.match(/^[\w$.]+\s*\(([\s\S]*)\)\s*;?$/);
  const body = m ? m[1] : t;
  try { return JSON.parse(body); }
  catch (e) { throw new Error('上游返回非 JSON: ' + t.slice(0, 120)); }
}

/* ------------------------------------------------------------------ */
/* 简易并发闸门 + 内存缓存                                             */
/* ------------------------------------------------------------------ */

const cache = new Map();
function cacheGet(k) {
  const v = cache.get(k);
  if (!v) return null;
  if (Date.now() > v.exp) { cache.delete(k); return null; }
  return v.val;
}
function cacheSet(k, val, ttlMs) {
  if (cache.size > 400) cache.clear();
  cache.set(k, { val, exp: Date.now() + ttlMs });
}

/* ------------------------------------------------------------------ */
/* 工具                                                               */
/* ------------------------------------------------------------------ */

function stripHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .trim();
}

/** 宽松解析单引号 JS 对象字面量（酷我搜索接口返回这种格式） */
function parseLooseObject(text) {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('未找到对象起始');
  let depth = 0, end = -1, quote = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) throw new Error('对象未闭合');
  let json = text.slice(start, end + 1);
  // 单引号 -> 双引号（值内部的单引号先占位保护）
  json = json.replace(/\\'/g, '\u0001')
             .replace(/'/g, '"')
             .replace(/\u0001/g, "'");
  return JSON.parse(json);
}

/* ------------------------------------------------------------------ */
/* 音源：酷我                                                          */
/* ------------------------------------------------------------------ */

const KW_BR = { '128': '128kmp3', '192': '192kmp3', '320': '320kmp3', '740': '2000kflac', '999': '4000kflac' };

async function kwSearch(keyword, count, page) {
  const url = 'https://search.kuwo.cn/r.s?all=' + encodeURIComponent(keyword) +
    '&ft=music&itemset=web_2013&client=kt&pn=' + (page - 1) + '&rn=' + count +
    '&rformat=json&encoding=utf8&vipver=1';
  const r = await rawRequest(url, { headers: { Referer: 'https://www.kuwo.cn/', 'User-Agent': UA_PC } });
  const d = parseLooseObject(r.text);
  const list = d.abslist || [];
  return list.map((it) => {
    const rid = String(it.MUSICRID || '').replace(/^MUSIC_/, '');
    const pic = it.web_albumpic_short || it.albumpic || '';
    return {
      id: rid,
      name: stripHtml(it.SONGNAME || it.NAME),
      artist: stripHtml(it.ARTIST || '').split('&').map((x) => x.trim()).filter(Boolean),
      album: stripHtml(it.ALBUM || ''),
      pic_id: pic ? String(pic).replace(/^\//, '') : '',
      url_id: rid,
      lyric_id: rid,
      source: 'kuwo',
      from: 'kw',
      duration: Number(String(it.DURATION || 0)),
    };
  }).filter((x) => x.id && x.name);
}

async function kwUrl(id, br) {
  const url = 'https://nmobi.kuwo.cn/mobi.s?f=web&user=0' +
    '&source=kwplayer_ar_8.5.5.0_jiakong.apk&type=convert_url_with_sign' +
    '&br=' + (KW_BR[br] || '320kmp3') + '&rid=' + encodeURIComponent(id);
  const d = await getJSON(url, { headers: { 'User-Agent': UA_PC } });
  const u = d && d.data && d.data.url;
  if (!u) return { url: '', br: -1, size: 0, from: 'kuwo' };
  return { url: u, br: Number(d.data.bitrate) || Number(br) || 320, size: Number(d.data.duration || 0), from: 'kuwo' };
}

/* ------------------------------------------------------------------ */
/* 音源：酷狗                                                          */
/* ------------------------------------------------------------------ */

async function kgSearch(keyword, count, page) {
  const url = 'https://mobiles.kugou.com/api/v3/search/song?format=json&keyword=' +
    encodeURIComponent(keyword) + '&page=' + page + '&pagesize=' + count + '&showtype=1';
  const d = await getJSON(url, { headers: { 'User-Agent': UA_MB, Referer: 'https://m.kugou.com/' } });
  const list = (d && d.data && d.data.info) || [];
  return list.map((it) => {
    const h = it.hash || '';
    const h320 = it['320hash'] || '';
    const hsq = it.sqhash || '';
    return {
      id: h,
      name: stripHtml(it.songname || it.filename),
      artist: stripHtml(it.singername || '').split(/[、,&]/).map((x) => x.trim()).filter(Boolean),
      album: stripHtml(it.album_name || ''),
      pic_id: h,
      // 依次尝试 320k -> 无损 -> 默认，用 | 分隔交给解析端顺序试
      url_id: [h320, hsq, h].filter(Boolean).join('|'),
      lyric_id: h,
      source: 'kugou',
      from: 'kg',
      duration: Number(it.duration || 0),
      // 会员/付费曲（privilege 10）：匿名接口拿不到直链，前端提前标出来
      vip: Number(it.privilege) >= 10 ? 1 : 0,
    };
  }).filter((x) => x.id && x.name);
}

async function kgInfoRaw(hash) {
  const url = 'http://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=' + encodeURIComponent(hash);
  const r = await rawRequest(url, { headers: { 'User-Agent': UA_MB, Referer: 'https://m.kugou.com/' } });
  try { return JSON.parse(r.text); } catch (e) { return null; }
}

async function kgResolveOne(hash) {
  const d = await kgInfoRaw(hash);
  return d && d.url ? d : null;
}

async function kgUrl(id, br) {
  const cands = String(id).split('|').filter(Boolean);
  // 音质偏好：高音质时先试 320/无损，否则先试默认
  const order = Number(br) >= 320 ? cands : cands.slice().reverse();
  for (const h of order) {
    try {
      const d = await kgResolveOne(h);
      if (d && d.url) {
        return { url: d.url, br: Number(d.bitRate) || Number(br) || 128, size: Number(d.fileSize || 0), from: 'kugou' };
      }
    } catch (e) { /* 继续试下一个 */ }
  }
  return { url: '', br: -1, size: 0, from: 'kugou' };
}

async function kgPicInfo(hash) {
  try {
    const d = await kgInfoRaw(hash);
    if (d) {
      const img = d.album_img || d.imgUrl || '';
      if (img) return img.replace('{size}', '400').replace(/^http:\/\//, 'https://');
    }
  } catch (e) { /* ignore */ }
  return '';
}

/* ------------------------------------------------------------------ */
/* 音源：QQ音乐                                                        */
/* ------------------------------------------------------------------ */

const TX_QUALITY = {
  '128': { pre: 'M500', ext: '.mp3' },
  '192': { pre: 'M500', ext: '.mp3' },
  '320': { pre: 'M800', ext: '.mp3' },
  '740': { pre: 'F000', ext: '.flac' },
  '999': { pre: 'F000', ext: '.flac' },
};

async function txSearch(keyword, count, page) {
  const url = 'https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?w=' + encodeURIComponent(keyword) +
    '&format=json&n=' + count + '&p=' + page + '&aggr=1&cr=1&lossless=0&flag_qc=0';
  const d = await getJSON(url, {
    headers: { 'User-Agent': UA_PC, Referer: 'https://y.qq.com/' },
  });
  const list = (d && d.data && d.data.song && d.data.song.list) || [];
  return list.map((it) => ({
    id: it.songmid,
    name: stripHtml(it.songname),
    artist: (it.singer || []).map((s) => stripHtml(s.name)).filter(Boolean),
    album: stripHtml(it.albumname || ''),
    pic_id: it.albummid || '',
    url_id: it.songmid,
    lyric_id: it.songmid,
    source: 'tencent',
    from: 'tx',
    duration: Number(it.interval || 0),
    pay: it.pay && it.pay.payplay ? 1 : 0,
  })).filter((x) => x.id && x.name);
}

/** 真正探一下这个地址能不能播（只取 2 字节，代价很小） */
const playableCache = new Map();
function isPlayable(url) {
  if (playableCache.has(url)) return Promise.resolve(playableCache.get(url));
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve(false); }
    const mod = u.protocol === 'https:' ? https : http;
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      if (playableCache.size > 300) playableCache.clear();
      playableCache.set(url, v);
      resolve(v);
    };
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': UA_PC, Range: 'bytes=0-1' },
      timeout: 6000,
    }, (res) => {
      const okType = /audio|octet-stream|mpegurl/i.test(res.headers['content-type'] || '');
      const okCode = res.statusCode === 200 || res.statusCode === 206;
      res.destroy();
      finish(okCode && okType);
    });
    req.on('error', () => finish(false));
    req.on('timeout', () => { req.destroy(); finish(false); });
    req.end();
  });
}

async function txUrl(id, br) {
  const q = TX_QUALITY[br] || TX_QUALITY['320'];
  // 依次尝试：目标音质 -> 128k mp3 -> 128k m4a -> 不指定文件名（由服务端给默认可用版本）
  const tries = [
    { pre: q.pre, ext: q.ext },
    { pre: 'M500', ext: '.mp3' },
    { pre: 'C400', ext: '.m4a' },
    { pre: '', ext: '' },
  ];
  const seen = new Set();
  for (const t of tries) {
    const sig = t.pre + t.ext;
    if (seen.has(sig)) continue;
    seen.add(sig);
    const filename = t.pre ? t.pre + id + t.ext : '';
    const param = {
      guid: '10000', songmid: [id], songtype: [0],
      uin: '0', loginflag: 1, platform: '20',
    };
    if (filename) param.filename = [filename];
    const payload = JSON.stringify({
      req_0: { module: 'vkey.GetVkeyServer', method: 'CgiGetVkey', param },
      comm: { uin: 0, format: 'json', ct: 24, cv: 0 },
    });
    try {
      const d = await getJSON('https://u.y.qq.com/cgi-bin/musicu.fcg', {
        method: 'POST',
        headers: {
          'User-Agent': UA_PC,
          Referer: 'https://y.qq.com/',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        body: payload,
      });
      const data = d && d.req_0 && d.req_0.data;
      const info = data && data.midurlinfo && data.midurlinfo[0];
      if (info && info.purl) {
        const sip = (data.sip && data.sip[0]) || 'http://ws.stream.qqmusic.qq.com/';
        const full = sip + info.purl;
        if (await isPlayable(full)) {
          const realBr = /^M800/.test(info.purl) ? 320
            : /^F000/.test(info.purl) ? 740
            : /^C400/.test(info.purl) ? 96 : 128;
          return { url: full, br: realBr, size: 0, from: 'tencent' };
        }
      }
    } catch (e) { /* 试下一个格式 */ }
  }
  return { url: '', br: -1, size: 0, from: 'tencent' };
}

/* ------------------------------------------------------------------ */
/* 歌词                                                               */
/* ------------------------------------------------------------------ */

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\-_·•,，.。()（）\[\]【】<>《》'"!！?？~～]/g, '')
    .replace(/&nbsp;/g, '');
}

/** 修正 UTF-8 被按 Latin-1 解码导致的乱码 */
function fixMojibake(s) {
  const t = String(s || '');
  if (!/[\u00C0-\u00FF]/.test(t)) return t;
  let alt = '';
  try { alt = Buffer.from(t, 'latin1').toString('utf8'); } catch (e) { return t; }
  if (!alt || alt.includes('\uFFFD')) return t;
  const cjk = (x) => (x.match(/[\u4e00-\u9fa5]/g) || []).length;
  return cjk(alt) > cjk(t) ? alt : t;
}

function scoreCandidate(cand, name, artist, duration) {
  const cn = normName(cand.song || '');
  const ca = normName(cand.singer || '');
  const na = normName(name);
  const ar = normName(artist);
  let score = 0;
  if (cn && na) {
    if (cn === na) score += 100;
    else if (cn.includes(na) || na.includes(cn)) score += 55;
  }
  if (ca && ar) {
    const ars = String(artist || '').split(/[\/、,&]/).map(normName).filter(Boolean);
    if (ars.some((a) => a && (ca.includes(a) || a.includes(ca)))) score += 80;
  }
  // 时长越接近越优先（单位毫秒）
  if (duration && cand.duration) {
    const diff = Math.abs(Number(cand.duration) - Number(duration) * 1000);
    if (diff < 3000) score += 40;
    else if (diff < 12000) score += 15;
  }
  return score;
}

async function kgLyricDownload(cand) {
  const d = await getJSON('https://krcs.kugou.com/download?ver=1&client=mobi&id=' + cand.id +
    '&accesskey=' + encodeURIComponent(cand.accesskey) + '&fmt=lrc&charset=utf8',
    { headers: { 'User-Agent': UA_MB, Referer: 'https://m.kugou.com/' } });
  if (!d || !d.content) return '';
  return fixMojibake(Buffer.from(d.content, 'base64').toString('utf8').replace(/^\uFEFF/, ''));
}

async function kgLyricBest(hash, name, artist, duration) {
  // 1) 有 hash 时用 hash 精确查（最准）
  if (hash) {
    try {
      const s = await getJSON('https://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=&duration=&hash=' +
        encodeURIComponent(hash), { headers: { 'User-Agent': UA_MB, Referer: 'https://m.kugou.com/' } });
      const cands = (s && s.candidates) || [];
      if (cands.length) {
        const scored = cands.map((c) => ({ c, sc: scoreCandidate(c, name, artist, duration) }))
          .sort((a, b) => b.sc - a.sc);
        if (!name || scored[0].sc >= 100) {
          const lrc = await kgLyricDownload(scored[0].c);
          if (lrc) return lrc;
        }
      }
    } catch (e) { /* 走关键词 */ }
  }

  // 2) 按歌名 + 歌手 + 时长检索
  const kw = `${name || ''} ${artist || ''}`.trim();
  if (kw) {
    try {
      const s = await getJSON('https://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=' +
        encodeURIComponent(kw) + '&duration=' + (duration || ''),
        { headers: { 'User-Agent': UA_MB, Referer: 'https://m.kugou.com/' } });
      const cands = (s && s.candidates) || [];
      const scored = cands.map((c) => ({ c, sc: scoreCandidate(c, name, artist, duration) }))
        .sort((a, b) => b.sc - a.sc);
      if (scored.length && scored[0].sc >= 55) {
        return await kgLyricDownload(scored[0].c);
      }
    } catch (e) { /* ignore */ }
  }
  return '';
}

/** 酷狗关键词歌词接口现在返回空，改成：先搜到 hash，再用 hash 精确取词 */
async function kgLyricBySearch(name, artist, duration) {
  const kw = `${name || ''} ${artist || ''}`.trim();
  if (!kw) return '';
  try {
    const list = await kgSearch(kw, 10, 1);
    for (const it of list.slice(0, 3)) {
      if (!it || !it.id) continue;
      try {
        const lrc = await kgLyricBest(it.id, name, artist, duration);
        if (lrc) return lrc;
      } catch (e) { /* 换下一个 */ }
    }
  } catch (e) { /* ignore */ }
  return '';
}

/** 终极兜底：去网易云曲库找同名同歌手的歌词 */
async function neLyricBest(name, artist, duration) {
  const kw = `${name || ''} ${artist || ''}`.trim();
  if (!kw) return '';
  try {
    const list = await neSearch(kw, 10, 1);
    if (!Array.isArray(list) || !list.length) return '';
    let best = null;
    let bestSc = -1;
    for (const it of list) {
      const sc = scoreCandidate({
        song: it.name,
        singer: (it.artist || []).join(' '),
        duration: (it.duration || 0) * 1000,
      }, name, artist, duration);
      if (sc > bestSc) { bestSc = sc; best = it; }
    }
    if (!best || bestSc < 55) return '';
    const d = await proxyGd({ types: 'lyric', source: 'netease', id: String(best.id) });
    return fixMojibake((d && d.lyric) || '');
  } catch (e) { return ''; }
}

async function kwLyricBest(id, name, artist, duration) {
  // 酷我官方歌词接口已加密：先借酷狗曲库，取不到再去网易云
  return (await kgLyricBySearch(name, artist, duration)) || (await neLyricBest(name, artist, duration));
}

async function txLyric(mid) {
  const url = 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=' +
    encodeURIComponent(mid) + '&format=json&nobase64=1&g_tk=5381';
  const d = await getJSON(url, {
    headers: { 'User-Agent': UA_PC, Referer: 'https://y.qq.com/portal/player.html' },
  });
  return (d && d.lyric) || '';
}

/* ------------------------------------------------------------------ */
/* 音源：汽水音乐（字节跳动 / 抖音）                                    */
/* 官方 web 接口，无需登录：搜索走 /luna/search/track，取链走            */
/* /luna/h5/seo_track，返回 m4a(AAC) 最高约 256K，另有歌词和封面。       */
/* ------------------------------------------------------------------ */

const QS_API = 'https://api.qishui.com';
const QS_UA = 'Mozilla/5.0 (Linux; Android 10; TVBox) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const QS_PAGE = 20; // 汽水固定每页 20 条，cursor 就是偏移量

function qsHeaders(json) {
  const h = {
    'User-Agent': QS_UA,
    Accept: 'application/json, text/plain, */*',
    Referer: 'https://music.douyin.com/',
  };
  if (json) h['Content-Type'] = 'application/json; charset=utf-8';
  return h;
}

/** 汽水封面字段是 {uri, urls[], template_prefix}，拼成可直接访问的图床地址。
 *  原图是 3.6MB 的 PNG，列表里用 -resize:300:300.webp 缩略图（约 18KB）。 */
function qsImage(img, size) {
  if (!img || typeof img !== 'object') return '';
  const uri = String(img.uri || '');
  let base = '';
  if (Array.isArray(img.urls) && img.urls.length) base = String(img.urls[0] || '');
  else if (typeof img.urls === 'string') base = img.urls;
  if (!base) return uri;
  if (/\/img\/?$/.test(base)) {
    if (!uri) return '';
    const tpl = String(img.template_prefix || '');
    const s = Math.min(Math.max(parseInt(size, 10) || 300, 80), 1080);
    return base.replace(/\/+$/, '') + '/' + uri.replace(/^\/+/, '') +
      (tpl ? ('~' + tpl + '-resize:' + s + ':' + s + '.webp') : '');
  }
  return base;
}

/** 从各种嵌套结构里挖出真正的 track 对象 */
function qsTrack(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.id && (obj.name || obj.title)) return obj;
  const paths = [['track'], ['entity', 'track_wrapper', 'track'], ['track_wrapper', 'track'], ['entity', 'track']];
  for (const p of paths) {
    let v = obj;
    for (const k of p) v = (v && typeof v === 'object') ? v[k] : null;
    if (v && typeof v === 'object' && v.id) return v;
  }
  return null;
}

/** 汽水歌词是逐字 KTV 格式：[起始ms,时长]<偏移,时长,0>字... → 转成标准 LRC */
function qsLrc(content) {
  const text = String(content || '');
  if (!text) return '';
  if (/^\[\d{1,2}:\d{2}/m.test(text) && !text.includes(']<')) return text; // 本身就是 LRC
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*\[(\d+),(\d+)\]/);
    if (!m) continue;
    const ms = Number(m[1]);
    let body = line.slice(m[0].length).replace(/<[^>]*>/g, '').trim();
    if (!body) continue;
    const mm = Math.floor(ms / 60000);
    const ss = Math.floor((ms % 60000) / 1000);
    const cs = Math.floor((ms % 1000) / 10);
    out.push('[' + String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0') + '.' + String(cs).padStart(2, '0') + ']' + body);
  }
  return out.join('\n');
}

async function qsSearch(keyword, count, page) {
  const pg = Math.max(parseInt(page, 10) || 1, 1);
  const cursor = pg > 1 ? String((pg - 1) * QS_PAGE) : null;
  const body = {
    search_type: 'track',
    q: keyword,
    cursor,
    search_id: crypto.createHash('md5').update(String(keyword)).digest('hex'),
    search_method: 'input',
    search_scene: 'search_result',
  };
  const r = await rawRequest(QS_API + '/luna/search/track?device_platform=web', {
    method: 'POST',
    headers: qsHeaders(true),
    body: JSON.stringify(body),
  });
  let d = null;
  try { d = JSON.parse(r.text); } catch (e) { return []; }
  const groups = (d && d.result_groups) || [];
  const g = groups.find((x) => x && x.id === 'tracks') || {};
  const items = g.data || [];
  return items.map((it) => {
    const t = qsTrack(it);
    if (!t || !t.id) return null;
    const album = t.album || {};
    const cover = qsImage(album.url_cover || t.url_cover || {});
    return {
      id: String(t.id),
      name: String(t.name || t.title || '未知歌曲'),
      artist: (t.artists || []).map((a) => String(a.name || a.simple_display_name || '')).filter(Boolean),
      album: String(album.name || ''),
      // 汽水的封面是完整 URL，前端 quickCover 会直接用
      pic_id: cover,
      url_id: String(t.id),
      lyric_id: String(t.id),
      source: 'qishui',
      from: 'qs',
      duration: Math.round(Number(t.duration || 0) / 1000),
    };
  }).filter(Boolean);
}

async function qsDetail(id) {
  const key = 'qs|' + id;
  const hit = cacheGet(key);
  if (hit) return hit;
  const r = await rawRequest(
    QS_API + '/luna/h5/seo_track?track_id=' + encodeURIComponent(id) + '&device_platform=web',
    { headers: qsHeaders(false) }
  );
  let d = null;
  try { d = JSON.parse(r.text); } catch (e) { return null; }
  cacheSet(key, d, 10 * 60 * 1000);
  return d;
}

/** 把 track_player.video_model 里的音质列表整理出来，按码率从高到低 */
function qsStreams(d) {
  const player = (d && d.track_player) || {};
  let model = player.video_model;
  if (typeof model === 'string' && model) {
    try { model = JSON.parse(model); } catch (e) { model = null; }
  }
  const list = [];
  for (const v of (model && model.video_list) || []) {
    if (!v || v.encrypt_info) continue;
    const meta = v.video_meta || {};
    const url = v.main_url || v.backup_url || '';
    if (!url) continue;
    list.push({
      url: String(url),
      br: Math.round(Number(meta.real_bitrate || meta.bitrate || 0) / 1000),
      size: Number(meta.size || 0),
      codec: String(meta.codec_type || 'aac'),
    });
  }
  return list.sort((a, b) => b.br - a.br);
}

async function qsUrl(id, br) {
  const want = Number(br) || 320;
  const d = await qsDetail(id);
  const streams = qsStreams(d);
  if (!streams.length) return { url: '', br: -1, size: 0, from: 'qishui' };
  // 汽水最高只有 256K 左右：要 320 就给最高的，要 128 就给最接近 128 的
  let pick = streams[0];
  if (want <= 128) {
    const low = streams.filter((s) => s.br <= 140);
    pick = low.length ? low[0] : streams[streams.length - 1];
  }
  return { url: pick.url, br: pick.br, size: pick.size, from: 'qishui', codec: pick.codec };
}

async function qsLyric(id) {
  const d = await qsDetail(id);
  const raw = (d && d.lyric && d.lyric.content) || '';
  return qsLrc(raw);
}

async function qsPic(id, size) {
  const d = await qsDetail(id);
  const t = qsTrack((d && d.seo_track) || {}) || {};
  const album = t.album || {};
  return qsImage(album.url_cover || t.url_cover || {}, size);
}

/* ------------------------------------------------------------------ */
/* 音源：咪咕音乐                                                       */
/* 搜索走官方 search_all.do（一次带回音质档位、歌词地址、封面）；        */
/* 取链走星海后端：非 VIP 曲能给 320K / 无损，VIP 曲只给 128K。          */
/* ------------------------------------------------------------------ */

const MG_SEARCH = 'https://c.musicapp.migu.cn/MIGUM2.0/v1.0/content/search_all.do';
const mgLyricMap = new Map(); // contentId → 歌词地址（搜索结果里带的，取链时复用）

function mgFirst(list) {
  return Array.isArray(list) && list.length ? list[0] : null;
}

async function mgSearch(keyword, count, page) {
  const size = Math.min(Math.max(parseInt(count, 10) || 30, 1), 50);
  const pg = Math.max(parseInt(page, 10) || 1, 1);
  const url = MG_SEARCH + '?text=' + encodeURIComponent(keyword) +
    '&pageNo=' + pg + '&pageSize=' + size + '&isCopyright=1&sort=1' +
    '&searchSwitch=' + encodeURIComponent('{"song":1}');
  const d = await getJSON(url, {
    headers: { 'User-Agent': UA_MB, Referer: 'https://m.music.migu.cn/' },
  });
  const list = (d && d.songResultData && d.songResultData.result) || [];
  return list.map((it) => {
    const cid = String(it.contentId || '');
    if (!cid) return null;
    const formats = it.rateFormats || it.newRateFormats || [];
    const pq = formats.find((x) => x.formatType === 'PQ') || formats.find((x) => x.formatType === 'LQ') || {};
    const hq = formats.find((x) => x.formatType === 'HQ' || x.formatType === 'SQ');
    // 咪咕没有时长字段，用 128K 文件大小反推（字节 × 8 ÷ 128000）
    const duration = pq.size ? Math.round(Number(pq.size) * 8 / 128000) : 0;
    const img = mgFirst(it.imgItems) || {};
    const lyric = String(it.lyricUrl || '');
    if (lyric) mgLyricMap.set(cid, lyric);
    if (mgLyricMap.size > 800) mgLyricMap.clear();
    return {
      id: cid,
      name: stripHtml(it.name || ''),
      artist: (it.singers || []).map((s) => stripHtml(s.name || '')).filter(Boolean),
      album: stripHtml((mgFirst(it.albums) || {}).name || ''),
      pic_id: String(img.img || ''),
      url_id: cid,
      lyric_id: cid,
      source: 'migu',
      from: 'mg',
      duration,
      // 高音质档位带 vip 标记 → 匿名只能拿 128K，列表里先标出来
      vip: !!(hq && Array.isArray(hq.showTag) && hq.showTag.includes('vip')) ? 1 : 0,
    };
  }).filter((x) => x && x.id && x.name);
}

async function mgUrl(contentId, br, song) {
  const s = song || {};
  const singer = Array.isArray(s.artist) ? s.artist.join('/') : (s.artist || '');
  const hq = await xhUrl('migu', {
    songmid: contentId,
    name: s.name || '',
    singer,
    interval: s.duration ? String(s.duration) : '',
    albumName: s.album || '',
  }, br);
  if (!hq || !hq.url) return { url: '', br: -1, size: 0, from: 'migu' };
  return { url: hq.url, br: hq.br || 128, size: 0, from: 'migu', quality: hq.quality };
}

async function mgLyric(contentId) {
  const url = mgLyricMap.get(contentId);
  if (!url) return '';
  try {
    const r = await rawRequest(url, { headers: { 'User-Agent': UA_MB } });
    return fixMojibake(r.text || '');
  } catch (e) {
    return '';
  }
}

/* ------------------------------------------------------------------ */
/* 高音质增强：星海后端（酷狗 / QQ / 咪咕的 320K、无损）                  */
/* 官方匿名接口只给 128K，这里借第三方聚合服务拿高码率，拿不到就回退原生。 */
/* ------------------------------------------------------------------ */

const XH_BASE = 'https://yy.zddyr.top/lx/api/';
const XH_CLIENT = 'XingHaiMusicSource/v3.2.18 (Windows)';
let xhToken = '';
let xhTokenAt = 0;
let xhDeviceId = 'lx-online-' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
let xhBlocked = false;

function xhQuality(br) {
  const n = Number(br) || 320;
  if (n >= 999) return 'hires';
  if (n >= 740) return 'flac';
  if (n >= 320) return '320k';
  return '128k';
}

async function xhEnsureToken() {
  if (xhToken && Date.now() - xhTokenAt < 4 * 60 * 1000) return xhToken;
  const r = await rawRequest(XH_BASE + 'token.php?device_id=' + encodeURIComponent(xhDeviceId), {
    headers: { 'User-Agent': 'lx-music', 'X-Client': XH_CLIENT },
  });
  let d = null;
  try { d = JSON.parse(r.text); } catch (e) { return ''; }
  const tk = d && d.data && d.data.token;
  if (typeof tk === 'string' && tk) {
    xhToken = tk;
    xhTokenAt = Date.now();
  }
  return xhToken;
}

/**
 * 向星海后端取链接。source 用 kg / qq，params 里带它认识的字段。
 * 失败一律返回空对象，调用方回退到原生链路。
 */
async function xhUrl(source, params, br) {
  if (xhBlocked) return null;
  try {
    const token = await xhEnsureToken();
    if (!token) return null;
    const qs = new URLSearchParams(Object.assign({ source, quality: xhQuality(br) }, params)).toString();
    const r = await rawRequest(XH_BASE + '?' + qs, {
      headers: { 'User-Agent': 'lx-music', 'X-Client': XH_CLIENT, 'X-Token': token },
    });
    let d = null;
    try { d = JSON.parse(r.text); } catch (e) { return null; }
    if (!d) return null;
    if (d.code === 403) { xhBlocked = true; return null; }
    if (d.code !== 200 || !d.url) return null;
    const q = String(d.quality || '');
    const brGuess = q === 'hires' ? 999 : q === 'flac' ? 740 : q === '320k' ? 320 : q === '128k' ? 128 : 0;
    return { url: String(d.url), br: brGuess, quality: q, format: d.format || '' };
  } catch (e) {
    return null;
  }
}

/** 酷狗：主 hash 就够，后端会自己找对应的 320/无损文件 */
async function xhKugou(hash, br) {
  return xhUrl('kg', { mainHash: hash }, br);
}

/** QQ：后端按 songmid + 歌名歌手匹配 */
async function xhQQ(songmid, name, singer, interval, albumName, br) {
  const p = { songmid };
  if (name) p.name = name;
  if (singer) p.singer = singer;
  if (interval) p.interval = String(interval);
  if (albumName) p.albumName = albumName;
  return xhUrl('qq', p, br);
}

/* ------------------------------------------------------------------ */
/* 统一的 API 处理                                                     */
/* ------------------------------------------------------------------ */

const SRC_ALIAS = {
  netease: 'netease', wy: 'netease', netease_cloud: 'netease',
  joox: 'joox',
  kuwo: 'kuwo', kw: 'kuwo',
  kugou: 'kugou', kg: 'kugou',
  tencent: 'tencent', tx: 'tencent', qq: 'tencent',
  qishui: 'qishui', qs: 'qishui', 汽水: 'qishui', soda: 'qishui',
  migu: 'migu', mg: 'migu', 咪咕: 'migu', migu_music: 'migu',
};

async function apiSearch(source, keyword, count, page) {
  // 全部音源：并发搜索后交错合并
  if (source === 'all') {
    const key = `sa|${keyword}|${count}|${page}`;
    const hit = cacheGet(key);
    if (hit) return hit;
    const targets = ['netease', 'kuwo', 'kugou', 'tencent', 'qishui', 'migu'];
    const buckets = await Promise.all(targets.map(async (s) => {
      try {
        return await apiSearch(s, keyword, Math.min(count, 15), page);
      } catch (e) { return []; }
    }));
    const merged = [];
    const seen = new Set();
    const maxLen = buckets.reduce((m, b) => Math.max(m, b.length), 0);
    for (let i = 0; i < maxLen; i++) {
      for (const arr of buckets) {
        const it = arr[i];
        if (!it) continue;
        const k = `${it.source}_${it.id}`;
        if (seen.has(k)) continue;
        seen.add(k);
        merged.push(it);
      }
    }
    cacheSet(key, merged, 5 * 60 * 1000);
    return merged;
  }

  const key = `s|${source}|${keyword}|${count}|${page}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  let list = [];
  if (source === 'kuwo') list = await kwSearch(keyword, count, page);
  else if (source === 'kugou') list = await kgSearch(keyword, count, page);
  else if (source === 'tencent') list = await txSearch(keyword, count, page);
  else if (source === 'netease') list = await neSearch(keyword, count, page);
  else if (source === 'qishui') list = await qsSearch(keyword, count, page);
  else if (source === 'migu') list = await mgSearch(keyword, count, page);
  else if (source === 'joox') list = await gdSearch('joox', keyword, count);
  cacheSet(key, list, 5 * 60 * 1000);
  return list;
}

/**
 * 取播放地址。
 * extra 是可选的歌曲信息（name / artist / album / duration），
 * 星海后端按「歌名 + 歌手」匹配 QQ 高音质时要用到。
 */
async function apiUrl(source, id, br, extra) {
  const key = `u|${source}|${id}|${br}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const want = Number(br) || 320;
  let r;

  if (source === 'qishui') {
    r = await qsUrl(id, br);
  } else if (source === 'migu') {
    // 咪咕官方接口要签名，匿名拿不到直链，统一走星海后端
    r = await mgUrl(id, br, extra);
  } else {
    if (source === 'kuwo') r = await kwUrl(id, br);
    else if (source === 'kugou') r = await kgUrl(id, br);
    else if (source === 'tencent') r = await txUrl(id, br);
    else r = { url: '', br: -1, size: 0 };

    // 原生拿不到、或码率明显不够（酷狗 / QQ 匿名只给 128K）→ 找星海后端要 320K / 无损
    const tooLow = !r.url || (want >= 192 && Number(r.br || 0) < Math.min(want, 320) * 0.9);
    if (tooLow && (source === 'kugou' || source === 'tencent')) {
      const song = extra || {};
      let hq = null;
      try {
        if (source === 'kugou') {
          // url_id 是 "320hash|sqhash|hash"，最后一个才是主 hash
          const parts = String(id).split('|').filter(Boolean);
          hq = await xhKugou(parts[parts.length - 1], br);
        } else {
          const singer = Array.isArray(song.artist) ? song.artist.join(' / ') : (song.artist || '');
          hq = await xhQQ(id, song.name, singer, song.duration, song.album, br);
        }
      } catch (e) { hq = null; }
      if (hq && hq.url && (!r.url || (hq.br || 0) > (r.br || 0))) {
        r = { url: hq.url, br: hq.br || want, size: 0, from: source, quality: hq.quality };
      }
    }
  }
  if (r.url) cacheSet(key, r, 25 * 60 * 1000);
  // 要无损 / Hi-Res 但拿不到时，退一步用 320K，别让这首歌直接放不出来
  if (!r.url && want > 320) {
    try {
      const retry = await apiUrl(source, id, '320', extra);
      if (retry && retry.url) return retry;
    } catch (e) { /* ignore */ }
  }
  return r;
}

async function apiLyric(source, id, name, artist, duration) {
  const key = `l|${source}|${id}|${name}|${artist}|${duration}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  let lyric = '';
  try {
    if (source === 'kugou') lyric = await kgLyricBest(id, name, artist, duration);
    else if (source === 'tencent') lyric = await txLyric(id);
    else if (source === 'kuwo') lyric = await kwLyricBest(id, name, artist, duration);
    else if (source === 'qishui') lyric = await qsLyric(id);
    else if (source === 'migu') lyric = await mgLyric(id);
  } catch (e) { lyric = ''; }
  // 本音源没词时依次兜底：酷狗曲库 → 网易云曲库
  if (!lyric) {
    try { lyric = await kgLyricBySearch(name, artist, duration); } catch (e) { /* ignore */ }
  }
  if (!lyric) {
    try { lyric = await neLyricBest(name, artist, duration); } catch (e) { /* ignore */ }
  }
  const out = { lyric: lyric || '', tlyric: '', from: source };
  if (lyric) cacheSet(key, out, 6 * 60 * 60 * 1000);
  return out;
}

async function apiPic(source, id, size) {
  let url = '';
  if (source === 'tencent') {
    if (id && /^[0-9A-Za-z]+$/.test(id)) {
      url = `https://y.gtimg.cn/music/photo_new/T002R${size}x${size}M000${id}.jpg`;
    }
  } else if (source === 'kuwo') {
    if (id) url = `https://img1.kuwo.cn/star/albumcover/${id}`;
  } else if (source === 'kugou') {
    url = await kgPicInfo(id);
  } else if (source === 'qishui') {
    url = await qsPic(id, size);
  }
  return { url: url || '', from: source };
}

/** 网易云 / JOOX 直接转发原接口，保持原样不动 */
async function proxyGd(params) {
  const qs = new URLSearchParams(params).toString();
  const key = 'gd|' + qs;
  const hit = cacheGet(key);
  if (hit !== null) return hit;
  const d = await getJSON(GD_API + '?' + qs, { headers: { 'User-Agent': UA_PC } });
  cacheSet(key, d, 3 * 60 * 1000);
  return d;
}

/** 转发到原公网接口做搜索（网易云 / JOOX） */
async function gdSearch(source, keyword, count) {
  const d = await proxyGd({ types: 'search', source, name: keyword, count: String(count || 30) });
  return Array.isArray(d) ? d : [];
}

/**
 * 网易云官方搜索：支持 offset 真翻页，能一路翻到几百条。
 * 原 gdstudio 接口的 page 参数其实是无效的（每次都返回同一批），所以这里走官方接口。
 * 拿不到时回退到 gdstudio，保证至少能搜出来。
 */
async function neSearch(keyword, count, page) {
  const limit = Math.min(Math.max(parseInt(count, 10) || 30, 1), 50);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;
  try {
    const d = await getJSON(
      'https://music.163.com/api/cloudsearch/pc?s=' + encodeURIComponent(keyword) +
      '&type=1&limit=' + limit + '&offset=' + offset,
      {
        headers: {
          'User-Agent': UA_PC,
          Referer: 'https://music.163.com/',
          Cookie: 'appver=2.0.2',
        },
      }
    );
    const songs = (d && d.result && d.result.songs) || [];
    // 超出总数就直接返回空，让前端能干净地判断「到底了」
    const total = (d && d.result && d.result.songCount) || 0;
    if (total && offset >= total) return [];
    if (!songs.length) return [];
    return songs.map((s) => {
      const al = s.al || {};
      return {
        id: String(s.id),
        name: s.name || '',
        artist: (s.ar || []).map((a) => a && a.name).filter(Boolean),
        album: al.name || '',
        // 直接给完整封面地址，前端会认 http(s) 开头的 pic_id
        pic_id: al.picUrl || (al.pic_str ? String(al.pic_str) : ''),
        url_id: String(s.id),
        lyric_id: String(s.id),
        source: 'netease',
        duration: s.dt ? Math.round(s.dt / 1000) : 0,
        from: 'music.163.com',
      };
    });
  } catch (e) {
    // 官方接口偶发抽风，退回 gdstudio（只有前 50 条，但至少能用）
    return await gdSearch('netease', keyword, limit);
  }
}

/* ------------------------------------------------------------------ */
/* 排行榜                                                              */
/* ------------------------------------------------------------------ */

/**
 * 网易云歌单/榜单取全量曲目。
 * 匿名调 playlist/detail 只给前 10 首，所以先拿 v6 的 trackIds（完整），
 * 缺失的按每批 100 个去 v3/song/detail 补齐。
 */
async function nePlaylistAll(id) {
  const key = `ne_all_${id}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const headers = { 'User-Agent': UA_PC, Referer: 'https://music.163.com/', Cookie: 'appver=2.0.2' };
  const d = await getJSON(
    'https://music.163.com/api/v6/playlist/detail?id=' + encodeURIComponent(id) + '&n=1000&s=0',
    { headers }
  );
  const p = (d && (d.playlist || d.result)) || {};
  const ids = (p.trackIds || []).map((x) => String(x.id));
  const got = new Map();
  (p.tracks || []).forEach((t) => got.set(String(t.id), t));
  const miss = ids.filter((i) => !got.has(i));
  for (let i = 0; i < miss.length; i += 100) {
    const chunk = miss.slice(i, i + 100);
    try {
      const q = encodeURIComponent(JSON.stringify(chunk.map((x) => ({ id: Number(x) }))));
      const r = await getJSON('https://music.163.com/api/v3/song/detail?c=' + q, { headers });
      ((r && r.songs) || []).forEach((s) => got.set(String(s.id), s));
    } catch (e) { /* 补不全就先用已有的，不影响播放 */ }
  }
  let tracks = ids.length
    ? ids.map((i) => got.get(i)).filter(Boolean)
    : (p.tracks || []);
  if (!tracks.length) tracks = p.tracks || [];
  if (tracks.length) cacheSet(key, tracks, 5 * 60 * 1000);
  return tracks;
}

/** 网易云榜单：官方歌单 id，一次取全量再本地切页 */
async function neRank(id, page, count) {
  const tracks = await nePlaylistAll(id);
  const start = (page - 1) * count;
  const songs = tracks.slice(start, start + count).map((t) => {
    // 这个老接口是 artists / album / duration(毫秒) 格式，新接口是 ar / al / dt，两种都兜住
    const ar = t.ar || t.artists || [];
    const al = t.al || t.album || {};
    const ms = t.dt || t.duration || 0;
    return {
      id: String(t.id),
      name: t.name || '',
      artist: ar.map((a) => a && a.name).filter(Boolean),
      album: al.name || '',
      pic_id: al.picUrl || (al.pic_str ? String(al.pic_str) : ''),
      url_id: String(t.id),
      lyric_id: String(t.id),
      source: 'netease',
      from: 'music.163.com',
      duration: Math.round(ms / 1000),
    };
  });
  return { songs, total: tracks.length, hasMore: start + count < tracks.length };
}

/** QQ 音乐榜单：topid + song_begin 分页，单页最多 50 */
async function txRank(topid, page, count) {
  const c = Math.min(count, 50);
  const begin = (page - 1) * c;
  const key = `rank_tx_${topid}_${page}_${c}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const d = await getJSON(
    'https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?topid=' + encodeURIComponent(topid) +
    '&format=json&page=detail&type=top&song_begin=' + begin + '&song_num=' + c,
    { headers: { 'User-Agent': UA_MB, Referer: 'https://y.qq.com/' } }
  );
  const list = (d && d.songlist) || [];
  const songs = list.map((it) => {
    const s = it.data || {};
    return {
      id: s.songmid,
      name: stripHtml(s.songname),
      artist: (s.singer || []).map((x) => stripHtml(x.name)).filter(Boolean),
      album: stripHtml(s.albumname || ''),
      pic_id: s.albummid || '',
      url_id: s.songmid,
      lyric_id: s.songmid,
      source: 'tencent',
      from: 'tx',
      duration: Number(s.interval || 0),
      pay: s.pay && s.pay.payplay ? 1 : 0,
    };
  }).filter((x) => x.id && x.name);
  const out = { songs, total: 0, hasMore: list.length >= c };
  cacheSet(key, out, 3 * 60 * 1000);
  return out;
}

/** 酷狗榜单：rankid 分页，字段结构和搜索接口一致 */
async function kgRank(rankid, page, count) {
  const c = Math.min(count, 100);
  const key = `rank_kg_${rankid}_${page}_${c}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const d = await getJSON(
    'http://mobilecdn.kugou.com/api/v3/rank/song?rankid=' + encodeURIComponent(rankid) +
    '&page=' + page + '&pagesize=' + c + '&format=json',
    { headers: { 'User-Agent': UA_MB, Referer: 'https://m.kugou.com/' } }
  );
  const info = (d && d.data && d.data.info) || [];
  const total = (d && d.data && d.data.total) || 0;
  const songs = info.map((it) => {
    const h = it.hash || '';
    const h320 = it['320hash'] || '';
    const hsq = it.sqhash || '';
    const authors = (it.authors || []).map((a) => stripHtml(a.author_name)).filter(Boolean);
    return {
      id: h,
      name: stripHtml(it.songname || it.filename),
      artist: authors.length ? authors : stripHtml(it.singername || '').split(/[、,&]/).filter(Boolean),
      album: '',
      pic_id: h,
      url_id: [h320, hsq, h].filter(Boolean).join('|'),
      lyric_id: h,
      source: 'kugou',
      from: 'kg',
      duration: Number(it.duration || 0),
      vip: Number(it.privilege) >= 10 ? 1 : 0,
    };
  }).filter((x) => x.id && x.name);
  const start = (page - 1) * c;
  const out = { songs, total, hasMore: total ? start + info.length < total : info.length >= c };
  cacheSet(key, out, 3 * 60 * 1000);
  return out;
}

/* ------------------------------------------------------------------ */
/* 歌单                                                                */
/* ------------------------------------------------------------------ */

/** 网易云推荐歌单（分页靠 offset） */
async function nePlist(page, count) {
  const offset = (page - 1) * count;
  const key = `pl_ne_${page}_${count}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const d = await getJSON(
    'https://music.163.com/api/personalized/playlist?limit=' + count + '&offset=' + offset + '&total=true',
    { headers: { 'User-Agent': UA_PC, Referer: 'https://music.163.com/', Cookie: 'appver=2.0.2' } }
  );
  const list = (d && d.result) || [];
  const out = {
    lists: list.map((x) => ({
      id: String(x.id),
      name: x.name || '',
      pic: x.picUrl || '',
      count: Number(x.playCount || 0),
      desc: x.copywriter || '',
      source: 'netease',
    })),
    hasMore: list.length >= count,
  };
  if (out.lists.length) cacheSet(key, out, 5 * 60 * 1000);
  return out;
}

/** QQ 音乐分类歌单（sin/ein 分页） */
async function txPlist(page, count) {
  const sin = (page - 1) * count;
  const ein = sin + count - 1;
  const key = `pl_tx_${page}_${count}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const d = await getJSON(
    'https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg?picmid=1&rnd=' + Math.random() +
    '&g_tk=5381&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0' +
    '&platform=yqq.json&needNewCode=0&categoryId=10000000&sortId=5&sin=' + sin + '&ein=' + ein,
    { headers: { 'User-Agent': UA_PC, Referer: 'https://y.qq.com/' } }
  );
  const list = (d && d.data && d.data.list) || [];
  const out = {
    lists: list.map((x) => ({
      id: String(x.dissid),
      name: x.dissname || '',
      pic: x.imgurl || '',
      count: Number(x.listennum || 0),
      desc: (x.creator && x.creator.name) ? ('by ' + x.creator.name) : '',
      source: 'tencent',
    })).filter((x) => x.id && x.name && x.id !== 'undefined'),
    hasMore: list.length >= count,
  };
  if (out.lists.length) cacheSet(key, out, 5 * 60 * 1000);
  return out;
}

/** QQ 歌单里的歌（musicu POST，只有这个接口匿名能拿到完整列表） */
async function txPlistSongs(id, page, count) {
  const begin = (page - 1) * count;
  const key = `pls_tx_${id}_${page}_${count}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const body = JSON.stringify({
    req_1: {
      module: 'music.srfDissInfo.aiDissInfo',
      method: 'uniform_get_Dissinfo',
      param: {
        disstid: Number(id), enc_host_uin: '', tag: 1, userinfo: 1,
        song_begin: begin, song_num: count,
      },
    },
  });
  const r = await rawRequest('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    headers: { 'User-Agent': UA_PC, Referer: 'https://y.qq.com/', 'Content-Type': 'application/json' },
    body,
    timeout: 20000,
  });
  let d = {};
  try { d = JSON.parse(r.text); } catch (e) { d = {}; }
  const data = (d && d.req_1 && d.req_1.data) || {};
  const list = data.songlist || [];
  const songs = list.map((s) => ({
    id: s.mid,
    name: stripHtml(s.name || s.title),
    artist: (s.singer || []).map((x) => stripHtml(x.name)).filter(Boolean),
    album: (s.album && stripHtml(s.album.name)) || '',
    pic_id: (s.album && s.album.mid) || '',
    url_id: s.mid,
    lyric_id: s.mid,
    source: 'tencent',
    from: 'tx',
    duration: Number(s.interval || 0),
    pay: s.pay && s.pay.payplay ? 1 : 0,
  })).filter((x) => x.id && x.name);
  const out = {
    songs,
    title: (data.dirinfo && data.dirinfo.title) || '',
    total: data.total_song_num || 0,
    hasMore: !!data.hasmore,
  };
  cacheSet(key, out, 3 * 60 * 1000);
  return out;
}

async function handleApi(q, ctx) {
  const types = (q.get('types') || '').toLowerCase();
  const srcRaw = (q.get('source') || '').toLowerCase();
  const source = SRC_ALIAS[srcRaw] || srcRaw;

  if (types === 'ping') {
    return { ok: true, sources: ['netease', 'joox', 'kuwo', 'kugou', 'tencent', 'qishui', 'migu'], version: 5, via: 'local-proxy', hq: !xhBlocked };
  }

  /* ---- 歌单云备份 ---- */
  if (types === 'saveplist') {
    const code = String(q.get('code') || '').trim();
    if (!PLIST_CODE_RE.test(code)) return { ok: false, detail: '备份码要是 6~12 位字母或数字' };
    const body = (ctx && ctx.body) || '';
    if (!body) return { ok: false, detail: '没有收到歌单数据' };
    if (Buffer.byteLength(body) > PLIST_MAX_BYTES) return { ok: false, detail: '歌单太大了（超过 3MB）' };
    let data;
    try { data = JSON.parse(body); } catch (e) { return { ok: false, detail: '歌单数据不是合法 JSON' }; }
    const lists = Array.isArray(data && data.myPlaylists) ? data.myPlaylists : [];
    const play = Array.isArray(data && data.playList) ? data.playList : [];
    const clean = lists
      .filter((p) => p && typeof p === 'object' && p.name)
      .slice(0, 200)
      .map((p) => ({
        id: String(p.id || ''),
        name: String(p.name).slice(0, 60),
        createdAt: Number(p.createdAt) || 0,
        updatedAt: Number(p.updatedAt) || 0,
        songs: (Array.isArray(p.songs) ? p.songs : []).slice(0, 3000),
      }));
    const payload = {
      v: 1,
      code,
      updatedAt: Date.now(),
      playlistCount: clean.length,
      songCount: clean.reduce((n, p) => n + p.songs.length, 0),
      myPlaylists: clean,
      playList: play.slice(0, 3000),
    };
    try {
      fs.mkdirSync(PLIST_DIR, { recursive: true });
      const file = plistPath(code);
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload));
      fs.renameSync(tmp, file);
    } catch (e) {
      return { ok: false, detail: '写入失败：' + (e && e.message) };
    }
    return { ok: true, code, updatedAt: payload.updatedAt, playlists: payload.playlistCount, songs: payload.songCount };
  }

  if (types === 'loadplist') {
    const code = String(q.get('code') || '').trim();
    if (!PLIST_CODE_RE.test(code)) return { ok: false, detail: '备份码要是 6~12 位字母或数字' };
    let raw = '';
    try { raw = fs.readFileSync(plistPath(code), 'utf8'); } catch (e) {
      return { ok: false, detail: '这个备份码还没有备份过歌单（码打错了？）' };
    }
    let d;
    try { d = JSON.parse(raw); } catch (e) { return { ok: false, detail: '备份文件损坏了' }; }
    return {
      ok: true,
      code,
      updatedAt: d.updatedAt || 0,
      playlistCount: d.playlistCount || (d.myPlaylists || []).length,
      songCount: d.songCount || 0,
      myPlaylists: Array.isArray(d.myPlaylists) ? d.myPlaylists : [],
      playList: Array.isArray(d.playList) ? d.playList : [],
    };
  }

  // 排行榜：types=rank&source=&id=&page=&count=
  // 注意要放在下面「网易云非搜索转发」之前，否则会被转发到公网接口
  if (types === 'rank' || types === 'toplist') {
    const id = q.get('id') || q.get('rankid') || q.get('topid') || '';
    const page = Math.max(parseInt(q.get('page') || '1', 10) || 1, 1);
    const count = Math.min(Math.max(parseInt(q.get('count') || '50', 10) || 50, 1), 100);
    if (!id) return { detail: '缺少榜单 id' };
    try {
      if (source === 'netease') return await neRank(id, page, count);
      if (source === 'tencent') return await txRank(id, page, count);
      if (source === 'kugou') return await kgRank(id, page, count);
      return { detail: '这个音源暂时还没有排行榜' };
    } catch (e) {
      return { detail: '榜单加载失败：' + (e && e.message) };
    }
  }

  // 歌单列表：types=plist&source=&page=&count=
  if (types === 'plist') {
    const page = Math.max(parseInt(q.get('page') || '1', 10) || 1, 1);
    const count = Math.min(Math.max(parseInt(q.get('count') || '24', 10) || 24, 1), 50);
    try {
      if (source === 'netease') return await nePlist(page, count);
      if (source === 'tencent') return await txPlist(page, count);
      return { detail: '这个音源暂时还没有歌单' };
    } catch (e) {
      return { detail: '歌单加载失败：' + (e && e.message) };
    }
  }

  // 歌单歌曲：types=plist_songs&source=&id=&page=&count=
  if (types === 'plist_songs' || types === 'diss') {
    const id = q.get('id') || '';
    const page = Math.max(parseInt(q.get('page') || '1', 10) || 1, 1);
    const count = Math.min(Math.max(parseInt(q.get('count') || '50', 10) || 50, 1), 100);
    if (!id) return { detail: '缺少歌单 id' };
    try {
      // 网易云歌单和榜单一样走 playlist/detail，直接复用
      if (source === 'netease') return await neRank(id, page, count);
      if (source === 'tencent') return await txPlistSongs(id, page, count);
      return { detail: '这个音源暂时还没有歌单' };
    } catch (e) {
      return { detail: '歌单加载失败：' + (e && e.message) };
    }
  }

  // 网易云 / JOOX —— 非搜索请求原样转发；搜索走 apiSearch（网易云要真翻页）
  if ((source === 'netease' || source === 'joox') && types !== 'search') {
    const params = {};
    for (const [k, v] of q.entries()) if (k !== 'source') params[k] = v;
    params.source = source;
    const d = await proxyGd(params);
    if (d && d.detail) return { detail: d.detail };
    return d;
  }

  if (types === 'search') {
    const kw = q.get('name') || q.get('keyword') || '';
    const count = Math.min(parseInt(q.get('count') || '30', 10) || 30, 50);
    const page = Math.max(parseInt(q.get('page') || '1', 10) || 1, 1);
    if (!kw.trim()) return [];
    try {
      return await apiSearch(source, kw.trim(), count, page);
    } catch (e) {
      return { detail: (source + ' 搜索失败：' + e.message) };
    }
  }

  if (types === 'url') {
    const id = q.get('id') || q.get('url_id') || '';
    const br = q.get('br') || '320';
    if (!id) return { url: '', br: -1, size: 0 };
    const extra = {
      name: q.get('name') || '',
      artist: q.get('artist') || '',
      album: q.get('album') || '',
      duration: parseInt(q.get('dur') || '0', 10) || 0,
    };
    return apiUrl(source, id, br, extra);
  }

  if (types === 'lyric') {
    const id = q.get('id') || q.get('lyric_id') || '';
    const name = q.get('name') || '';
    const artist = q.get('artist') || '';
    const duration = parseInt(q.get('dur') || '0', 10) || 0;
    return apiLyric(source, id, name, artist, duration);
  }

  if (types === 'pic') {
    const id = q.get('id') || q.get('pic_id') || '';
    const size = parseInt(q.get('size') || '300', 10) || 300;
    return apiPic(source, id, size);
  }

  return { detail: '未知的 types 参数: ' + types };
}

/* ------------------------------------------------------------------ */
/* HTTP 服务                                                          */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

/**
 * 音频流代理。
 * 汽水（抖音）的 CDN 有防盗链：Referer 是本地地址会直接 403，
 * 所以浏览器不能直接放，得由服务端带上合适的 Referer 转发一遍。
 * Range 头原样透传，拖动进度条照常工作。
 */
function pipeStream(targetUrl, req, res, depth) {
  depth = depth || 0;
  let u;
  try { u = new URL(targetUrl); } catch (e) { res.writeHead(400); return res.end('bad url'); }
  const mod = u.protocol === 'https:' ? https : http;
  const headers = { Accept: '*/*', 'Accept-Encoding': 'identity' };
  const host = u.hostname;
  if (/douyin|douyinvod|bytedance|pstatp/.test(host)) {
    headers['User-Agent'] = QS_UA;
    headers.Referer = 'https://music.douyin.com/';
  } else {
    headers['User-Agent'] = UA_PC;
  }
  if (req.headers.range) headers.Range = req.headers.range;

  const preq = mod.request({
    protocol: u.protocol,
    hostname: host,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + u.search,
    method: 'GET',
    headers,
    timeout: 25000,
  }, (pres) => {
    if ([301, 302, 303, 307, 308].includes(pres.statusCode) && pres.headers.location && depth < 4) {
      pres.resume();
      return pipeStream(new URL(pres.headers.location, targetUrl).href, req, res, depth + 1);
    }
    const out = {};
    for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      if (pres.headers[k]) out[k] = pres.headers[k];
    }
    // m4a 装 mp4 容器，浏览器 <audio> 认，这里不强行改类型
    res.writeHead(pres.statusCode || 200, out);
    pres.pipe(res);
  });
  preq.on('timeout', () => preq.destroy(new Error('stream timeout')));
  preq.on('error', () => {
    try { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('音频转发失败'); } catch (e) { /* ignore */ }
  });
  preq.end();
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1:' + PORT);

  if (u.pathname === '/api' || u.pathname === '/api.php') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    try {
      const ctx = {};
      const t = (u.searchParams.get('types') || '').toLowerCase();
      if (req.method === 'POST' && (t === 'saveplist' || t === 'loadplist')) {
        try {
          ctx.body = await readRequestBody(req, PLIST_MAX_BYTES + 1024);
        } catch (e) {
          res.writeHead(200);
          return res.end(JSON.stringify({ ok: false, detail: '歌单数据太大或上传中断' }));
        }
      }
      const out = await handleApi(u.searchParams, ctx);
      res.writeHead(200);
      res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(200);
      res.end(JSON.stringify({ detail: '代理出错：' + (e && e.message) }));
    }
    return;
  }

  // 音频流转发：/stream?source=&id=&br=
  if (u.pathname === '/stream') {
    const source = SRC_ALIAS[(u.searchParams.get('source') || '').toLowerCase()] || (u.searchParams.get('source') || '');
    const id = u.searchParams.get('id') || '';
    const br = u.searchParams.get('br') || '320';
    if (!id) { res.writeHead(400); return res.end('缺少 id'); }
    try {
      const r = await apiUrl(source, id, br, {
        name: u.searchParams.get('name') || '',
        artist: u.searchParams.get('artist') || '',
        album: u.searchParams.get('album') || '',
        duration: parseInt(u.searchParams.get('dur') || '0', 10) || 0,
      });
      if (!r || !r.url) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('拿不到音频地址'); }
      pipeStream(r.url, req, res, 0);
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('音频转发失败：' + (e && e.message));
    }
    return;
  }

  // 静态文件
  let p = decodeURIComponent(u.pathname);
  // 备份数据目录不能被直接下载（只能走 types=loadplist 按码取）
  if (/^\/(data|\.git)(\/|$)/i.test(p)) { res.writeHead(403); return res.end('forbidden'); }
  if (p === '/' || p === '') p = '/' + PAGE;
  if (p === '/index.html' || p === '/index' || p === '/听歌' || p === '/在线听歌') p = '/' + PAGE;
  const file = path.join(ROOT, path.normalize(p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 找不到：' + p);
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`\n  端口 ${PORT} 被占用了 —— 多半是上一次的服务窗口还开着。`);
    console.log('  如果刚更新过代码，关掉那个旧窗口，再双击「启动听歌.bat」重开一次即可。');
    console.log(`  只想听歌的话，直接用旧服务也行：http://127.0.0.1:${PORT}`);
    console.log(`  想换端口：PORT=9000 node server.js\n`);
  } else if (e.code === 'EACCES') {
    console.error(`\n  没有权限监听 ${PORT} 端口（1024 以下是系统保留端口），换个端口：PORT=8898 node server.js\n`);
  } else {
    console.error('服务启动失败：', e.message);
  }
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
  console.log('');
  console.log('  ┌────────────────────────────────────────────┐');
  console.log('  │  在线听歌 · 音源代理服务已启动              │');
  console.log('  └────────────────────────────────────────────┘');
  console.log('');
  console.log(`   请在浏览器打开：  http://${shown}:${PORT}`);
  if (HOST === '0.0.0.0') console.log(`   服务器/局域网访问： http://<本机IP>:${PORT}`);
  console.log('');
  console.log('   支持音源：网易云 / 酷我 / 酷狗 / QQ音乐 / 汽水音乐 / 咪咕 / JOOX');
  console.log('');
  console.log('   关闭这个窗口即可停止服务。');
  console.log('');
});
