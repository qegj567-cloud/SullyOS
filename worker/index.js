const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1";
const FEISHU_BASE = "https://open.feishu.cn/open-apis";
const XHS_BASE = "https://edith.xiaohongshu.com";
const XHS_MEDIA_HOST_CANDIDATES = [
  "https://edith.xiaohongshu.com",
  "https://creator.xiaohongshu.com",
  "https://www.xiaohongshu.com",
];
const XHS_PUBLISH_HOST_CANDIDATES = [
  "https://edith.xiaohongshu.com",
  "https://www.xiaohongshu.com",
];

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, xi-api-key, model, language, X-MiniMax-Region, X-MiniMax-API-Key, Depth, X-Brave-API-Key, X-Notion-API-Key, X-Feishu-Token, X-Xhs-Cookie, X-Xhs-Platform, X-Rnote-API-Key, X-Xhs-Experiment-Ack, X-Netease-Cookie, X-WebDAV-Method, X-WebDAV-Depth, X-WebDAV-Range, X-GitHub-Method, X-GitHub-Api-Version, X-CF-Method, Mcp-Session-Id, Accept, Range",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(obj, { status = 200, origin } = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(origin),
    },
  });
}

// ---- /fetch-webpage 用: SSRF 防护 + body 大小上限 ----
// 网页分享代理只抓用户粘贴的公网网页, 拒绝 loopback / 私有网段 / link-local / 内网后缀。
function isUnsafeFetchTarget(parsed) {
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === '::1' || host === '0.0.0.0') return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]), b = Number(v4[2]);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  // IPv6 唯一本地 (fc00::/7) / link-local (fe80::/10)
  if (/^f[cd][0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host)) return true;
  return false;
}

// 读 Response body, 累加到 maxBytes 就停 (防超大页面打爆 worker)。
async function readBodyCapped(res, maxBytes) {
  const reader = (res.body && res.body.getReader) ? res.body.getReader() : null;
  if (!reader) return await res.text();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      chunks.push(value);
      if (total >= maxBytes) { try { await reader.cancel(); } catch (e) { /* ignore */ } break; }
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { merged.set(c.subarray(0, total - offset), offset); offset += c.length; }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged);
}

function route(url) {
  const p = url.pathname.replace(/\/+$/, "");
  if (p === "" || p === "/") return { kind: "web" };
  if (p === "/search") return { kind: "web" };
  if (p === "/news") return { kind: "news" };
  if (p === "/videos") return { kind: "videos" };
  if (p === "/images") return { kind: "images" };
  return null;
}

// ================================================================
//  小红书签名 — 基于 xhshow 逆向的真实算法
//  参考: https://github.com/Cloxl/xhshow
// ================================================================

// ---------- Pure-JS MD5 (RFC 1321) ----------
function md5(string) {
  function md5cycle(x, k) {
    let a = x[0], b = x[1], c = x[2], d = x[3];
    a = ff(a, b, c, d, k[0], 7, -680876936);   d = ff(d, a, b, c, k[1], 12, -389564586);
    c = ff(c, d, a, b, k[2], 17, 606105819);    b = ff(b, c, d, a, k[3], 22, -1044525330);
    a = ff(a, b, c, d, k[4], 7, -176418897);    d = ff(d, a, b, c, k[5], 12, 1200080426);
    c = ff(c, d, a, b, k[6], 17, -1473231341);  b = ff(b, c, d, a, k[7], 22, -45705983);
    a = ff(a, b, c, d, k[8], 7, 1770035416);    d = ff(d, a, b, c, k[9], 12, -1958414417);
    c = ff(c, d, a, b, k[10], 17, -42063);      b = ff(b, c, d, a, k[11], 22, -1990404162);
    a = ff(a, b, c, d, k[12], 7, 1804603682);   d = ff(d, a, b, c, k[13], 12, -40341101);
    c = ff(c, d, a, b, k[14], 17, -1502002290); b = ff(b, c, d, a, k[15], 22, 1236535329);
    a = gg(a, b, c, d, k[1], 5, -165796510);    d = gg(d, a, b, c, k[6], 9, -1069501632);
    c = gg(c, d, a, b, k[11], 14, 643717713);   b = gg(b, c, d, a, k[0], 20, -373897302);
    a = gg(a, b, c, d, k[5], 5, -701558691);    d = gg(d, a, b, c, k[10], 9, 38016083);
    c = gg(c, d, a, b, k[15], 14, -660478335);  b = gg(b, c, d, a, k[4], 20, -405537848);
    a = gg(a, b, c, d, k[9], 5, 568446438);     d = gg(d, a, b, c, k[14], 9, -1019803690);
    c = gg(c, d, a, b, k[3], 14, -187363961);   b = gg(b, c, d, a, k[8], 20, 1163531501);
    a = gg(a, b, c, d, k[13], 5, -1444681467);  d = gg(d, a, b, c, k[2], 9, -51403784);
    c = gg(c, d, a, b, k[7], 14, 1735328473);   b = gg(b, c, d, a, k[12], 20, -1926607734);
    a = hh(a, b, c, d, k[5], 4, -378558);       d = hh(d, a, b, c, k[8], 11, -2022574463);
    c = hh(c, d, a, b, k[11], 16, 1839030562);  b = hh(b, c, d, a, k[14], 23, -35309556);
    a = hh(a, b, c, d, k[1], 4, -1530992060);   d = hh(d, a, b, c, k[4], 11, 1272893353);
    c = hh(c, d, a, b, k[7], 16, -155497632);   b = hh(b, c, d, a, k[10], 23, -1094730640);
    a = hh(a, b, c, d, k[13], 4, 681279174);    d = hh(d, a, b, c, k[0], 11, -358537222);
    c = hh(c, d, a, b, k[3], 16, -722521979);   b = hh(b, c, d, a, k[6], 23, 76029189);
    a = hh(a, b, c, d, k[9], 4, -640364487);    d = hh(d, a, b, c, k[12], 11, -421815835);
    c = hh(c, d, a, b, k[15], 16, 530742520);   b = hh(b, c, d, a, k[2], 23, -995338651);
    a = ii(a, b, c, d, k[0], 6, -198630844);    d = ii(d, a, b, c, k[7], 10, 1126891415);
    c = ii(c, d, a, b, k[14], 15, -1416354905); b = ii(b, c, d, a, k[5], 21, -57434055);
    a = ii(a, b, c, d, k[12], 6, 1700485571);   d = ii(d, a, b, c, k[3], 10, -1894986606);
    c = ii(c, d, a, b, k[10], 15, -1051523);    b = ii(b, c, d, a, k[1], 21, -2054922799);
    a = ii(a, b, c, d, k[8], 6, 1873313359);    d = ii(d, a, b, c, k[15], 10, -30611744);
    c = ii(c, d, a, b, k[6], 15, -1560198380);  b = ii(b, c, d, a, k[13], 21, 1309151649);
    a = ii(a, b, c, d, k[4], 6, -145523070);    d = ii(d, a, b, c, k[11], 10, -1120210379);
    c = ii(c, d, a, b, k[2], 15, 718787259);    b = ii(b, c, d, a, k[9], 21, -343485551);
    x[0] = add32(a, x[0]); x[1] = add32(b, x[1]); x[2] = add32(c, x[2]); x[3] = add32(d, x[3]);
  }
  function cmn(q, a, b, x, s, t) { a = add32(add32(a, q), add32(x, t)); return add32((a << s) | (a >>> (32 - s)), b); }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | ((~b) & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }
  function add32(a, b) { return (a + b) & 0xFFFFFFFF; }

  const encoder = new TextEncoder();
  const bytes = encoder.encode(string);
  let n = bytes.length;
  let tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  let i;
  for (i = 0; i < n; i++) tail[i >> 2] |= bytes[i] << ((i % 4) << 3);
  // We need to handle longer strings properly
  let state = [1732584193, -271733879, -1732584194, 271733878];
  let nBlocks = ((n + 8) >> 6) + 1;
  let totalLen = nBlocks * 64;
  let buf = new Uint8Array(totalLen);
  buf.set(bytes);
  buf[n] = 0x80;
  let dv = new DataView(buf.buffer);
  dv.setUint32(totalLen - 8, (n * 8) & 0xFFFFFFFF, true);
  dv.setUint32(totalLen - 4, Math.floor(n * 8 / 0x100000000), true);
  for (let offset = 0; offset < totalLen; offset += 64) {
    let k = [];
    for (let j = 0; j < 16; j++) k[j] = dv.getUint32(offset + j * 4, true);
    md5cycle(state, k);
  }
  const hex = [];
  for (let si = 0; si < 4; si++) {
    for (let bi = 0; bi < 4; bi++) {
      hex.push(((state[si] >> (bi * 8)) & 0xFF).toString(16).padStart(2, '0'));
    }
  }
  return hex.join('');
}

// ---------- Custom Base64 alphabets ----------
const STD_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CUSTOM_B64 = "ZmserbBoHQtNP+wOcza/LpngG8yJq42KWYj0DSfdikx3VT16IlUAFM97hECvuRX5";
const X3_B64 = "MfgqrsbcyzPQRStuvC7mn501HIJBo2DEFTKdeNOwxWXYZap89+/A4UVLhijkl63G";

function translateB64(input, fromAlpha, toAlpha) {
  let out = "";
  for (const ch of input) {
    const idx = fromAlpha.indexOf(ch);
    out += idx >= 0 ? toAlpha[idx] : ch;
  }
  return out;
}

function bytesToStdB64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

function customB64Encode(bytes) {
  return translateB64(bytesToStdB64(bytes), STD_B64, CUSTOM_B64);
}

function x3B64Encode(bytes) {
  return translateB64(bytesToStdB64(bytes), STD_B64, X3_B64);
}

// ---------- 124-byte XOR key (from xhshow) ----------
const HEX_KEY = "71a302257793271ddd273bcee3e4b98d9d7935e1da33f5765e2ea8afb6dc77a51a499d23b67c20660025860cbf13d4540d92497f58686c574e508f46e1956344f39139bf4faf22a3eef120b79258145b2feb5193b6478669961298e79bedca646e1a693a926154a5a7a1bd1cf0dedb742f917a747a1e388b234f2277";

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  return bytes;
}
const XOR_KEY = hexToBytes(HEX_KEY);

// ---------- Constants ----------
const VERSION_BYTES = [119, 104, 96, 41];
const CHECKSUM_FIXED_TAIL = [249, 65, 103, 103, 201, 181, 131, 99, 94, 7, 68, 250, 132, 21];

function intToLE(val, len = 4) {
  const arr = [];
  for (let i = 0; i < len; i++) { arr.push(val & 0xFF); val = Math.floor(val / 256); }
  return arr;
}

// Timestamp fingerprint with XOR key 41
function envFingerprintA(tsMs, xorKey) {
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  // Write as two 32-bit ints (little-endian) since BigInt may not be available everywhere
  dv.setUint32(0, tsMs & 0xFFFFFFFF, true);
  dv.setUint32(4, Math.floor(tsMs / 0x100000000) & 0xFFFFFFFF, true);
  const data = new Uint8Array(buf);
  const sum1 = (data[1] + data[2] + data[3] + data[4]) & 0xFF;
  const sum2 = (data[5] + data[6] + data[7]) & 0xFF;
  data[0] = (sum1 + sum2) & 0xFF;
  for (let i = 0; i < data.length; i++) data[i] ^= xorKey;
  return Array.from(data);
}

function envFingerprintB(tsMs) {
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  dv.setUint32(0, tsMs & 0xFFFFFFFF, true);
  dv.setUint32(4, Math.floor(tsMs / 0x100000000) & 0xFFFFFFFF, true);
  return Array.from(new Uint8Array(buf));
}

// ---------- Build the 124-byte payload ----------
function buildPayloadArray(md5Hex, a1Value, contentStr, timestampSec) {
  const payload = [];

  // [0-3] Version magic
  payload.push(...VERSION_BYTES);

  // [4-7] Random seed
  const seed = new Uint8Array(4);
  crypto.getRandomValues(seed);
  payload.push(...seed);
  const seedByte0 = seed[0];

  // [8-15] Env fingerprint A
  const tsMs = Math.floor(timestampSec * 1000);
  payload.push(...envFingerprintA(tsMs, 41));

  // [16-23] Env fingerprint B (offset timestamp)
  const offset = Math.floor(Math.random() * 40) + 10;
  payload.push(...envFingerprintB(Math.floor((timestampSec - offset) * 1000)));

  // [24-27] sequence value
  payload.push(...intToLE(Math.floor(Math.random() * 36) + 15));

  // [28-31] window props length
  payload.push(...intToLE(Math.floor(Math.random() * 301) + 900));

  // [32-35] content string length
  payload.push(...intToLE(contentStr.length));

  // [36-43] First 8 bytes of MD5, XOR'd with seedByte0
  const md5Bytes = hexToBytes(md5Hex);
  for (let i = 0; i < 8; i++) payload.push(md5Bytes[i] ^ seedByte0);

  // [44] a1 field length marker
  payload.push(52);

  // [45-96] a1 cookie value, padded/truncated to 52 bytes
  const a1Bytes = new TextEncoder().encode(a1Value);
  const a1Padded = new Uint8Array(52);
  a1Padded.set(a1Bytes.slice(0, 52));
  payload.push(...a1Padded);

  // [97] app identifier length marker
  payload.push(10);

  // [98-107] "xhs-pc-web"
  const appId = new TextEncoder().encode("xhs-pc-web");
  const appPadded = new Uint8Array(10);
  appPadded.set(appId.slice(0, 10));
  payload.push(...appPadded);

  // [108-109] fixed values
  payload.push(1);
  payload.push(1); // CHECKSUM_VERSION

  // [110] seed XOR 115
  payload.push(seedByte0 ^ 115);

  // [111-124] fixed tail
  payload.push(...CHECKSUM_FIXED_TAIL);

  return new Uint8Array(payload);
}

// ---------- XOR transform ----------
function xorTransform(payload) {
  const result = new Uint8Array(payload.length);
  for (let i = 0; i < payload.length; i++) {
    result[i] = i < XOR_KEY.length ? (payload[i] ^ XOR_KEY[i]) & 0xFF : payload[i] & 0xFF;
  }
  return result;
}

// ---------- CRC32 table for X-s-common ----------
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? ((0xEDB88320 ^ (c >>> 1)) >>> 0) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

// XHS variant of CRC32 — processes first 57 chars
function mrc(e) {
  let o = 0xFFFFFFFF;
  const len = Math.min(57, e.length);
  for (let n = 0; n < len; n++) {
    o = (CRC32_TABLE[(o & 255) ^ e.charCodeAt(n)] ^ (o >>> 8)) >>> 0;
  }
  return ((o ^ 0xFFFFFFFF) ^ 0xEDB88320) >>> 0;
}

// Generate X-s-common header value
function generateXsCommon(xs, xt, a1) {
  const common = {
    s0: 5, s1: "",
    x0: "1", x1: "3.6.8", x2: "Windows",
    x3: "xhs-pc-web", x4: "4.21.1",
    x5: a1, x6: xt, x7: xs,
    x8: "", x9: mrc(xt + xs), x10: 1
  };
  const jsonStr = JSON.stringify(common);
  const encoded = encodeURIComponent(jsonStr);
  const bytes = Array.from(encoded).map(c => c.charCodeAt(0));
  return customB64Encode(bytes);
}

// ---------- Generate X-s and X-t ----------
function signXs(method, uri, a1Value, postBody = null) {
  // Step 1: Build content string (POST 需要包含 body)
  let content = uri;
  if (method === "POST" && postBody) {
    content = uri + JSON.stringify(postBody);
  }

  // Step 2: MD5
  const md5Hex = md5(content);

  // Step 3: Build 124-byte payload
  const timestamp = Date.now() / 1000;
  const payloadArray = buildPayloadArray(md5Hex, a1Value, content, timestamp);

  // Step 4: XOR transform
  const xorResult = xorTransform(payloadArray);

  // Step 5: Custom Base64 → x3
  const x3Sig = x3B64Encode(Array.from(xorResult.slice(0, 124)));

  // Step 6: Signature data JSON
  const sigData = {
    x0: "4.2.6",
    x1: "xhs-pc-web",
    x2: "Windows",
    x3: "mns0301_" + x3Sig,
    x4: ""
  };

  // Step 7: Encode entire JSON with custom Base64
  const jsonStr = JSON.stringify(sigData);
  const jsonBytes = Array.from(new TextEncoder().encode(jsonStr));

  // Step 8: Final x-s
  const xs = "XYS_" + customB64Encode(jsonBytes);
  const xt = String(Math.floor(timestamp * 1000));

  return { xs, xt };
}

// ---------- Cookie parser ----------
function getCookieValue(cookieStr, key) {
  const match = cookieStr.match(new RegExp(`(?:^|;\\s*)${key}=([^;]*)`));
  return match ? match[1] : '';
}

// ---------- XHS API fetch ----------
// options: { baseUrl, origin, referer }
function xhsFetch(cookie, api, method = 'GET', body = null, options = {}) {
  const a1 = getCookieValue(cookie, 'a1');
  if (!a1) {
    return Promise.resolve({ ok: false, status: 401, data: { success: false, message: 'Cookie 中缺少 a1' } });
  }

  const { xs, xt } = signXs(method, api, a1, body);
  const xsCommon = generateXsCommon(xs, xt, a1);

  const originHost = options.origin || 'https://www.xiaohongshu.com';
  const refererUrl = options.referer || (originHost + '/');

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cookie': cookie,
    'Origin': originHost,
    'Referer': refererUrl,
    'X-s': xs,
    'X-t': xt,
    'X-s-common': xsCommon,
    'X-b3-traceid': crypto.randomUUID().replace(/-/g, '').slice(0, 16),
  };

  const fetchOptions = { method, headers };
  if (method === 'POST' || method === 'PUT') {
    headers['Content-Type'] = 'application/json;charset=UTF-8';
    if (body) fetchOptions.body = JSON.stringify(body);
  }

  const baseUrl = options.baseUrl || XHS_BASE;
  const url = `${baseUrl}${api}`;
  return fetch(url, fetchOptions).then(async (res) => {
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { ok: res.ok, status: res.status, data };
  });
}


// ---------- XHS 图片上传 ----------
// 生成一个最小的有效 PNG 图片 (1080x1080 纯色)
function generateMinimalPNG() {
  // 生成一张 1x1 的深紫色 PNG，小红书会自动拉伸
  // PNG signature + IHDR + IDAT + IEND
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  // IHDR: 1x1, 8-bit RGB
  const ihdr = [
    0, 0, 0, 13, // chunk length
    73, 72, 68, 82, // "IHDR"
    0, 0, 0, 1, // width = 1
    0, 0, 0, 1, // height = 1
    8, 2, // 8-bit RGB
    0, 0, 0, // compression, filter, interlace
    // CRC32 of IHDR
    0x1E, 0x93, 0x09, 0x36
  ];
  // IDAT: deflated [filter_none(0), R, G, B] = [0, 88, 28, 120] (dark purple)
  // Raw deflate of [0, 88, 28, 120]: use stored block
  const rawData = new Uint8Array([0, 88, 28, 120]); // filter=0, R=88, G=28, B=120
  // Zlib: CMF=0x78, FLG=0x01 (no dict, low compression)
  // Stored block: BFINAL=1, BTYPE=00, LEN=4, NLEN=0xFFFB, data, Adler32
  const adler = adler32(rawData);
  const idat_data = new Uint8Array([
    0x78, 0x01, // zlib header
    0x01, // BFINAL=1, BTYPE=00 (stored)
    0x04, 0x00, 0xFB, 0xFF, // LEN=4, NLEN=~4
    ...rawData,
    (adler >> 24) & 0xFF, (adler >> 16) & 0xFF, (adler >> 8) & 0xFF, adler & 0xFF
  ]);
  const idat_crc = crc32Bytes([73, 68, 65, 84, ...idat_data]);
  const idat = [
    (idat_data.length >> 24) & 0xFF, (idat_data.length >> 16) & 0xFF,
    (idat_data.length >> 8) & 0xFF, idat_data.length & 0xFF,
    73, 68, 65, 84, // "IDAT"
    ...idat_data,
    (idat_crc >> 24) & 0xFF, (idat_crc >> 16) & 0xFF, (idat_crc >> 8) & 0xFF, idat_crc & 0xFF
  ];
  // IEND
  const iend = [0, 0, 0, 0, 73, 69, 78, 68, 0xAE, 0x42, 0x60, 0x82];
  return new Uint8Array([...signature, ...ihdr, ...idat, ...iend]);
}

function adler32(data) {
  let a = 1, b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function crc32Bytes(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = (CRC32_TABLE[(crc & 0xFF) ^ data[i]] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// 获取 XHS 上传凭证
// ReaJason/xhs 使用 GET edith.xiaohongshu.com/api/media/v1/upload/web/permit?...
// 真实浏览器发布时 Origin 为 creator.xiaohongshu.com
async function getUploadCredentials(cookie, count = 1) {
  const params = { biz_name: 'spectrum', scene: 'image', file_count: count, version: '1', source: 'web' };
  const qs = Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&');
  const getApi = `/api/media/v1/upload/web/permit?${qs}`;
  const attempts = [];

  // 组合: host × origin，优先匹配 ReaJason 库 (edith + 无特殊 origin)
  const originCombos = [
    {}, // 默认 www.xiaohongshu.com
    { origin: 'https://creator.xiaohongshu.com', referer: 'https://creator.xiaohongshu.com/' },
  ];

  for (const baseUrl of XHS_MEDIA_HOST_CANDIDATES) {
    for (const originOpt of originCombos) {
      const result = await xhsFetch(cookie, getApi, 'GET', null, { baseUrl, ...originOpt });
      attempts.push({
        baseUrl,
        origin: originOpt.origin || 'default',
        method: 'GET',
        status: result.status,
        ok: result.ok,
        raw: JSON.stringify(result.data).slice(0, 240),
      });
      if (result.ok && result.data?.data?.uploadTempPermits) {
        return { ...result, debug: { baseUrl, method: 'GET', origin: originOpt.origin || 'default', attempts } };
      }
    }
  }

  return {
    ok: false,
    status: 502,
    data: { message: '所有候选 host + origin 的上传凭证接口均失败' },
    debug: { attempts }
  };
}

// 上传图片字节到 XHS (ros-upload CDN)
async function uploadBytesToXhs(cookie, imgBytes, contentType = 'image/png') {
  // Step 1: 获取上传凭证
  const result = await getUploadCredentials(cookie);
  // 响应格式: { data: { uploadTempPermits: [{ fileIds: [...], token: "..." }] } }
  // 或者:     { uploadTempPermits: [...] }
  const permitRoot = result.data?.data || result.data;
  const tempPermit = permitRoot?.uploadTempPermits?.[0];

  if (!tempPermit?.fileIds?.[0] || !tempPermit?.token) {
    return {
      error: '获取上传凭证失败',
      debug: {
        raw: JSON.stringify(result.data).slice(0, 500),
        attempts: result.debug?.attempts || []
      }
    };
  }

  const fileId = tempPermit.fileIds[0];
  const token = tempPermit.token;

  // Step 2: PUT 上传到 ros-upload CDN
  const uploadUrl = `https://ros-upload.xiaohongshu.com/${fileId}`;
  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'X-Cos-Security-Token': token,
      'Content-Type': contentType,
    },
    body: imgBytes
  });

  if (uploadRes.ok) {
    return { file_id: fileId };
  }

  const uploadText = await uploadRes.text().catch(() => '');
  return {
    error: `CDN上传失败: ${uploadRes.status}`,
    debug: { fileId, response: uploadText.slice(0, 300) }
  };
}

// 上传图片到 XHS (通过 image_url 下载后上传)
async function uploadImageToXhs(cookie, imageUrl) {
  try {
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) return { error: `下载图片失败: ${imgRes.status}`, debug: { url: imageUrl } };
    const imgBytes = new Uint8Array(await imgRes.arrayBuffer());
    const ct = imgRes.headers.get('content-type') || 'image/jpeg';
    return await uploadBytesToXhs(cookie, imgBytes, ct);
  } catch (e) {
    return { error: `图片上传异常: ${e.message}` };
  }
}

// 上传占位图到 XHS
async function uploadPlaceholderImage(cookie) {
  try {
    const pngData = generateMinimalPNG();
    return await uploadBytesToXhs(cookie, pngData, 'image/png');
  } catch (e) {
    return { error: `占位图上传异常: ${e.message}` };
  }
}

// ================================================================
//  网易云音乐代理 — 转发到用户自部署的 api-enhanced
//  api-enhanced: https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced
//  一键部署到 Vercel, 得到一个类似 https://xxx.vercel.app 的地址后填到下面
// ================================================================
//
// ⚠️ 多上游 —— 可以填 N 个 api-enhanced 部署地址, Worker 会随机挑选 + 自动容灾。
// 推荐组合:
//   1) Vercel (主) — 你现有的这个
//   2) Deno Deploy (备) — 免费 100w req/天, 国外走这个最快
//   3) 另一个 Vercel 账号的二部署 — 双倍配额
// 见 notes/music-scaling.md 部署教程。
const NETEASE_UPSTREAMS = [
  "https://api-enhanced-ochre-kappa.vercel.app",
  // "https://sully-music.deno.dev",          // ← 部署 Deno Deploy 后把 URL 粘贴到这里
  // "https://api-enhanced-mirror.vercel.app", // ← 部署第二个 Vercel 后把 URL 粘贴到这里
];

// 国内 IP 伪装, 部分接口需要 realIP 参数才会返回内地版权数据
const NETEASE_REAL_IP = "116.25.146.177";

// ========== 边缘缓存 TTL 配置 ==========
// 单位: 秒。0 或未列出的 action 不缓存（登录/用户数据等）。
// 命中缓存 → 不打上游, 零成本。Cloudflare 免费 KV-like 缓存, 每 PoP 独立。
const NETEASE_CACHE_TTL = {
  // 长期稳定 — 激进缓存
  'lyric':              30 * 24 * 3600, // 30天 (歌词几乎不变)
  'lyric/new':          30 * 24 * 3600,
  'song/detail':              3600,     // 1小时
  'album':                    1800,     // 30分
  'artists':                  1800,
  'artist/songs':             1800,
  'mv/detail':                1800,
  // 中期
  'search':                    600,     // 10分
  'search/hot':               1800,
  'search/hot/detail':        1800,
  'search/default':            600,
  'toplist':                   600,
  'toplist/detail':            600,
  'top/playlist':              600,
  'playlist/detail':           600,
  'playlist/track/all':        600,
  'banner':                   1800,
  'personalized':             1800,
  'personalized/newsong':     1800,
  'comment/music':             300,     // 5分
  // 短期 — 签名链接有效期短
  'song/url':                  180,     // 3分 (URL 5分钟过期, 留余量)
  'mv/url':                    180,
  // 用户专属: 不出现在本表 = 不缓存
  //   login/*, captcha/*, user/*, likelist, like, logout,
  //   recommend/songs, personal_fm, daily_signin, check/music
};

// 已知 action → 真实上游路径的特例映射（大多数 api-enhanced 路径和 action 同名，
// 下面只处理名字不同 / 有特殊参数的那几个）。
const NETEASE_ACTION_REWRITE = {
  "search": "/cloudsearch",           // 用 cloudsearch 返回更完整的字段
  "song/url": "/song/url/v1",
  "user/detail": "/user/detail",
  "user/playlist": "/user/playlist",
  "user/record": "/user/record",
  "user/cloud": "/user/cloud",
  "user/subcount": "/user/subcount",
  "likelist": "/likelist",
  "like": "/like",
  "playlist/detail": "/playlist/detail",
  "playlist/track/all": "/playlist/track/all",
  "personal_fm": "/personal_fm",
  "recommend/songs": "/recommend/songs",
  "recommend/resource": "/recommend/resource",
  "daily_signin": "/daily_signin",
  "toplist": "/toplist",
  "toplist/detail": "/toplist/detail",
  "top/playlist": "/top/playlist",
  "personalized": "/personalized",
  "personalized/newsong": "/personalized/newsong",
  "banner": "/banner",
  "login/status": "/login/status",
  "login/cellphone": "/login/cellphone",
  "login/qr/key": "/login/qr/key",
  "login/qr/create": "/login/qr/create",
  "login/qr/check": "/login/qr/check",
  "captcha/sent": "/captcha/sent",
  "captcha/verify": "/captcha/verify",
  "logout": "/logout",
  "song/detail": "/song/detail",
  "lyric": "/lyric",
  "lyric/new": "/lyric/new",
  "comment/music": "/comment/music",
  "album": "/album",
  "artists": "/artists",
  "artist/songs": "/artist/songs",
  "mv/detail": "/mv/detail",
  "mv/url": "/mv/url",
};

// action 白名单 — 只允许 api-enhanced 已知的安全接口（防止被当成开放代理）
const NETEASE_ACTION_ALLOWED = new Set([
  ...Object.keys(NETEASE_ACTION_REWRITE),
  "song/url",
  "search/suggest",
  "search/hot",
  "search/hot/detail",
  "search/default",
  "check/music",
]);

function buildNeteaseUpstream(action, body, cookie) {
  if (!NETEASE_ACTION_ALLOWED.has(action)) return null;

  const p = new URLSearchParams();
  if (cookie && cookie.trim()) p.set("cookie", cookie.trim());
  p.set("realIP", NETEASE_REAL_IP);
  // cache-buster, 避免 Vercel 边缘缓存干扰登录态
  p.set("timestamp", Date.now().toString());

  // Special-case 几个需要重命名 / 默认值的字段
  if (action === "search") {
    p.set("keywords", body.keyword || body.keywords || "");
    p.set("type", String(body.type || 1));
    p.set("limit", String(body.limit || 30));
    p.set("offset", String(body.offset || 0));
  } else if (action === "song/url") {
    const ids = Array.isArray(body.ids) ? body.ids : (body.id != null ? [body.id] : []);
    if (ids.length) p.set("id", ids.join(","));
    p.set("level", body.level || "exhigh");
  } else if (action === "song/detail") {
    const ids = Array.isArray(body.ids) ? body.ids : (body.id != null ? [body.id] : []);
    if (ids.length) p.set("ids", ids.join(","));
  } else if (action === "user/playlist") {
    if (body.uid != null) p.set("uid", String(body.uid));
    p.set("limit", String(body.limit || 30));
    p.set("offset", String(body.offset || 0));
  } else if (action === "user/record") {
    if (body.uid != null) p.set("uid", String(body.uid));
    p.set("type", String(body.type ?? 1)); // 0: 全部, 1: 最近一周
  } else if (action === "user/cloud") {
    p.set("limit", String(body.limit || 30));
    p.set("offset", String(body.offset || 0));
  } else {
    // 通用：所有其余参数直接透传（字符串化）
    for (const [k, v] of Object.entries(body || {})) {
      if (v == null) continue;
      if (Array.isArray(v)) p.set(k, v.join(","));
      else p.set(k, String(v));
    }
  }

  const upstream = NETEASE_ACTION_REWRITE[action] || `/${action}`;
  return `${upstream}?${p}`;
}

// ========== 缓存 Key 构造 ==========
// 使用"虚拟" URL 作为 Cache API 的 key。只包含业务参数（action + 过滤后的 body），
// 故意剔除 cookie / realIP / timestamp / level(cookie 桶代替) 等不稳定参数。
// 这样同一个 action 的相同查询跨 PoP / 多上游 都能命中同一个缓存条目。
function buildCacheKey(action, body, cookieBucket) {
  const p = new URLSearchParams();
  const skip = new Set(['timestamp', 'realIP', 'cookie', '_']);
  for (const [k, v] of Object.entries(body || {})) {
    if (v == null || skip.has(k)) continue;
    if (Array.isArray(v)) p.set(k, v.join(","));
    else p.set(k, String(v));
  }
  // 排序保证确定性 (对象顺序 / 用户输入顺序不同也能命中同一 key)
  const sorted = [...p.entries()].sort(([a], [b]) => a.localeCompare(b));
  const qs = sorted.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return new Request(
    `https://sully-netease-cache.internal/${action}/${cookieBucket}?${qs}`,
    { method: 'GET' }
  );
}

// ========== 多上游 fetch 带失败转移 ==========
// 从 NETEASE_UPSTREAMS 随机打乱, 依次尝试, 任何一个成功(HTTP 2xx + code!=-460)就返回。
// 自动屏蔽被网易风控的上游 (HTTP 200 但 body 里 code=-460 / -7 = 被限流)。
function shuffleCopy(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function fetchFromAnyUpstream(upstreamPath, timeoutMs = 8000) {
  const order = shuffleCopy(NETEASE_UPSTREAMS);
  const errors = [];
  for (const base of order) {
    const upstreamUrl = base.replace(/\/+$/, '') + upstreamPath;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(upstreamUrl, {
        method: "GET",
        headers: { "Accept": "application/json" },
        signal: ctrl.signal,
      });
      clearTimeout(t);

      const text = await res.text();
      // HTTP 层挂了直接换下一个
      if (!res.ok) {
        errors.push(`${new URL(base).host} HTTP ${res.status}`);
        continue;
      }
      // 应用层风控: 尝试识别 -460/-7 等明显失败码, 这种情况下换个上游可能成功
      let shouldFailover = false;
      try {
        const j = JSON.parse(text);
        if (j?.code === -460 || j?.code === -7) shouldFailover = true;
      } catch { /* 不是 JSON, 当成功处理 */ }
      if (shouldFailover && order.length > 1) {
        errors.push(`${new URL(base).host} risk-control (code=-460/-7)`);
        continue;
      }
      return { text, status: res.status, upstream: new URL(base).host, error: null };
    } catch (e) {
      errors.push(`${new URL(base).host} ${e.name === 'AbortError' ? 'timeout' : e.message}`);
    }
  }
  return { text: '', status: 502, upstream: '', error: errors.join(' | ') };
}


// ================================================================
//  XHS Lite —— 验证过的纯算签名 + web API 封装（隔离在 IIFE 内，
//  不与上面旧的 /xhs/ 签名实现冲突）。对外暴露 /api/<command> 桥接契约，
//  与 scripts/xhs-bridge.mjs 完全兼容，前端 bridge 模式直接复用。
//
//  签名移植自 Cloxl/xhshow (MIT)，已与 Python 原版逐字节比对验证
//  （见 worker/xhs-lite/test/）。cookie 经 X-Xhs-Cookie 头按请求传入。
// ================================================================
const XHSLite = (() => {
  const STANDARD_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const CUSTOM_B64 = 'ZmserbBoHQtNP+wOcza/LpngG8yJq42KWYj0DSfdikx3VT16IlUAFM97hECvuRX5';
  const X3_B64 = 'MfgqrsbcyzPQRStuvC7mn501HIJBo2DEFTKdeNOwxWXYZap89+/A4UVLhijkl63G';
  const HEX_KEY =
    '71a302257793271ddd273bcee3e4b98d9d7935e1da33f5765e2ea8afb6dc77a5' +
    '1a499d23b67c20660025860cbf13d4540d92497f58686c574e508f46e1956344' +
    'f39139bf4faf22a3eef120b79258145b2feb5193b6478669961298e79bedca64' +
    '6e1a693a926154a5a7a1bd1cf0dedb742f917a747a1e388b234f2277516db711' +
    '6035439730fa61e9822a0eca7bff72d8';
  const VERSION_BYTES = [121, 104, 96, 41];
  const PAYLOAD_LENGTH = 144, A1_LENGTH = 52, APP_ID_LENGTH = 10;
  const A3_PREFIX = [2, 97, 51, 16];
  const ENV_TABLE = [115, 248, 83, 102, 103, 201, 181, 131, 99, 94, 4, 68, 250, 132, 21];
  const ENV_CHECKS_DEFAULT = [0, 1, 18, 1, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0];
  const HASH_IV = [1831565813, 461845907, 2246822507, 3266489909];
  const X3_PREFIX = 'mns0301_', XYS_PREFIX = 'XYS_', XYW_PREFIX = 'XYW_', B1_SECRET_KEY = 'xhswebmplfbt';
  const XYW_AES_KEY = '7cc4adla5ay0701v';
  const XYW_AES_IV = '4uzjr7mbsibcaldp';
  const XYW_ENV_FLAGS = '0|0|0|1|0|0|1|0|0|0|1|0|0|0|0|1|0|0|1';
  const SIGNATURE_DATA_TEMPLATE = { x0: '4.3.5', x1: 'xhs-pc-web', x2: 'Windows', x3: '', x4: 'object' };
  const SIGNATURE_XSCOMMON_TEMPLATE = {
    s0: 5, s1: '', x0: '1', x1: '4.3.5', x2: 'Windows', x3: 'xhs-pc-web', x4: '4.86.0',
    x5: '', x6: '', x7: '', x8: '', x9: -596800761, x10: 0, x11: 'normal',
  };
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0';
  const IMG_FORMATS = ['jpg', 'webp', 'avif'];
  const EDITH = 'https://edith.xiaohongshu.com', CREATOR = 'https://creator.xiaohongshu.com', WWW = 'https://www.xiaohongshu.com';
  const XHS_PLATFORMS = Object.freeze({
    xhs: Object.freeze({ key: 'xhs', apiBase: EDITH, webBase: WWW }),
    rednote: Object.freeze({ key: 'rednote', apiBase: 'https://webapi.rednote.com', webBase: 'https://www.rednote.com' }),
  });
  const PLATFORM_CACHE_TTL_MS = 30 * 60 * 1000;
  const platformCache = new Map();
  const SPIDER_V3 = Object.freeze({
    schemaVersion: 1,
    signVersion: '4.3.7',
    webBuild: '6.32.2',
    appId: 'xhs-pc-web',
    platform: 'Windows',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    secChUa: '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
    envConst: 1352,
    envFpTail: Object.freeze(hexToBytes('f9416767c9b581635e0744fa8415')),
  });
  const SPIDER_V3_STRATEGIES = new Set([
    'no-client-hints',
    'browser-hints',
    'legacy-transport',
  ]);
  const SPIDER_V3_DSL_URL = 'https://as.xiaohongshu.com/api/sec/v1/ds?appId=xhs-pc-web';
  const SPIDER_V3_DSL_TTL_MS = 5 * 60 * 1000;
  const SPIDER_V3_DSLLT_REFRESH_MS = 15 * 60 * 1000;
  let spiderV3DslCache = { value: '', expiresAt: 0 };

  const RNG = {
    randint(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); },
    randbytes(n) { const o = new Uint8Array(n); crypto.getRandomValues(o); return o; },
  };

  const u32 = (v) => v >>> 0;
  const rotl = (v, n) => u32((v << n) | (v >>> (32 - n)));
  const utf8 = (s) => new TextEncoder().encode(s);
  function intToLeBytes(val, length = 4) {
    const arr = []; let v = val;
    for (let i = 0; i < length; i++) { arr.push(v & 0xff); v = Math.floor(v / 256); }
    return arr;
  }
  function hexToBytes(hex) {
    const out = [];
    for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
    return out;
  }

  function md5Hex(bytes) {
    if (typeof bytes === 'string') bytes = utf8(bytes);
    const s = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    const K = [];
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
    const ml = bytes.length * 8;
    const withOne = bytes.length + 1;
    const padLen = ((withOne + 8 + 63) & ~63) - withOne - 8;
    const total = bytes.length + 1 + padLen + 8;
    const msg = new Uint8Array(total);
    msg.set(bytes); msg[bytes.length] = 0x80;
    const lenLo = ml >>> 0, lenHi = Math.floor(ml / 4294967296) >>> 0;
    for (let i = 0; i < 4; i++) msg[total - 8 + i] = (lenLo >>> (8 * i)) & 0xff;
    for (let i = 0; i < 4; i++) msg[total - 4 + i] = (lenHi >>> (8 * i)) & 0xff;
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let off = 0; off < total; off += 64) {
      const M = new Array(16);
      for (let i = 0; i < 16; i++) {
        M[i] = ((msg[off + i * 4]) | (msg[off + i * 4 + 1] << 8) | (msg[off + i * 4 + 2] << 16) | (msg[off + i * 4 + 3] << 24)) >>> 0;
      }
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | (~D >>> 0)); g = (7 * i) % 16; }
        F = (F + A + K[i] + M[g]) >>> 0;
        A = D; D = C; C = B; B = (B + rotl(F, s[i])) >>> 0;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    const toHex = (n) => { let h = ''; for (let i = 0; i < 4; i++) h += ((n >>> (8 * i)) & 0xff).toString(16).padStart(2, '0'); return h; };
    return toHex(a0) + toHex(b0) + toHex(c0) + toHex(d0);
  }

  function bytesToStdB64(bytes) {
    let out = ''; const n = bytes.length;
    for (let i = 0; i < n; i += 3) {
      const b0 = bytes[i], b1 = i + 1 < n ? bytes[i + 1] : 0, b2 = i + 2 < n ? bytes[i + 2] : 0;
      out += STANDARD_B64[b0 >> 2];
      out += STANDARD_B64[((b0 & 3) << 4) | (b1 >> 4)];
      out += i + 1 < n ? STANDARD_B64[((b1 & 15) << 2) | (b2 >> 6)] : '=';
      out += i + 2 < n ? STANDARD_B64[b2 & 63] : '=';
    }
    return out;
  }
  function translateAlphabet(str, to) {
    let out = '';
    for (const ch of str) { const idx = STANDARD_B64.indexOf(ch); out += idx === -1 ? ch : to[idx]; }
    return out;
  }
  const encodeCustom = (bytes) => translateAlphabet(bytesToStdB64(bytes), CUSTOM_B64);
  const encodeX3 = (bytes) => translateAlphabet(bytesToStdB64(bytes), X3_B64);
  const encodeCustomStr = (str) => encodeCustom(utf8(str));

  const CRC_POLY = 0xedb88320;
  let CRC_TABLE = null;
  function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    CRC_TABLE = new Uint32Array(256);
    for (let d = 0; d < 256; d++) { let r = d; for (let k = 0; k < 8; k++) r = (r & 1) ? ((r >>> 1) ^ CRC_POLY) : (r >>> 1); CRC_TABLE[d] = r >>> 0; }
    return CRC_TABLE;
  }
  function crc32JsInt(str) {
    const tbl = crcTable(); let c = 0xffffffff;
    for (let i = 0; i < str.length; i++) { const b = str.charCodeAt(i) & 0xff; c = (tbl[(c ^ b) & 0xff] ^ (c >>> 8)) >>> 0; }
    const v = ((0xffffffff ^ c) ^ CRC_POLY) >>> 0;
    return v & 0x80000000 ? v - 0x100000000 : v;
  }

  function rc4(keyBytes, dataBytes) {
    const S = new Uint8Array(256);
    for (let i = 0; i < 256; i++) S[i] = i;
    let j = 0;
    for (let i = 0; i < 256; i++) { j = (j + S[i] + keyBytes[i % keyBytes.length]) & 0xff; const t = S[i]; S[i] = S[j]; S[j] = t; }
    const out = new Uint8Array(dataBytes.length);
    let a = 0, b = 0;
    for (let k = 0; k < dataBytes.length; k++) {
      a = (a + 1) & 0xff; b = (b + S[a]) & 0xff;
      const t = S[a]; S[a] = S[b]; S[b] = t;
      out[k] = dataBytes[k] ^ S[(S[a] + S[b]) & 0xff];
    }
    return out;
  }

  function customHashV2(inputBytes) {
    let [s0, s1, s2, s3] = HASH_IV;
    const length = inputBytes.length;
    s0 = u32(s0 ^ length); s1 = u32(s1 ^ u32(length << 8)); s2 = u32(s2 ^ u32(length << 16)); s3 = u32(s3 ^ u32(length << 24));
    const dv = new DataView(new Uint8Array(inputBytes).buffer);
    for (let i = 0; i < Math.floor(length / 8); i++) {
      const v0 = dv.getUint32(i * 8, true), v1 = dv.getUint32(i * 8 + 4, true);
      s0 = rotl(u32(u32(s0 + v0) ^ s2), 7);
      s1 = rotl(u32(u32(v0 ^ s1) + s3), 11);
      s2 = rotl(u32(u32(s2 + v1) ^ s0), 13);
      s3 = rotl(u32(u32(s3 ^ v1) + s1), 17);
    }
    const t0 = u32(s0 ^ length), t1 = u32(s1 ^ t0), t2 = u32(s2 + t1), t3 = u32(s3 ^ t2);
    const r0 = rotl(t0, 9), r1 = rotl(t1, 13), r2 = rotl(t2, 17), r3 = rotl(t3, 19);
    s0 = u32(r0 + r2); s1 = u32(r1 ^ r3); s2 = u32(r2 + s0); s3 = u32(r3 ^ s1);
    const result = [];
    for (const s of [s0, s1, s2, s3]) result.push(...intToLeBytes(s, 4));
    return result;
  }

  function pyQuote(value, safeExtra) {
    const keep = new Set();
    const always = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-~';
    for (const c of always) keep.add(c);
    for (const c of safeExtra) keep.add(c);
    let out = '';
    for (const byte of utf8(value)) {
      const ch = String.fromCharCode(byte);
      if (byte < 0x80 && keep.has(ch)) out += ch;
      else out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
    }
    return out;
  }
  const jsonCompact = (obj) => JSON.stringify(obj);
  function buildContentString(method, uri, payload) {
    payload = payload || {};
    if (method.toUpperCase() === 'POST') return uri + jsonCompact(payload);
    const keys = Object.keys(payload);
    if (!keys.length) return uri;
    const parts = keys.map((k) => {
      const v = payload[k];
      let s; if (Array.isArray(v)) s = v.map(String).join(','); else if (v !== null && v !== undefined) s = String(v); else s = '';
      return `${k}=${pyQuote(s, ',')}`;
    });
    return `${uri}?${parts.join('&')}`;
  }
  function extractUri(uri) {
    uri = uri.trim();
    if (uri.startsWith('http')) return new URL(uri).pathname;
    const q = uri.indexOf('?');
    return q === -1 ? uri : uri.slice(0, q);
  }

  function buildPayloadArray(dValue, mValue, a1Value, appId, stringParam, timestampSec) {
    const seed = RNG.randint(0, 0xffffffff), seedByte = seed & 0xff;
    const payload = [...VERSION_BYTES];
    payload.push(...intToLeBytes(seed, 4));
    const tsMs = Math.floor(timestampSec * 1000), tsBytes = intToLeBytes(tsMs, 8);
    payload.push(...tsBytes);
    const timeOffset = RNG.randint(10, 50);
    payload.push(...intToLeBytes(Math.floor((timestampSec - timeOffset) * 1000), 8));
    payload.push(...intToLeBytes(RNG.randint(15, 50), 4));
    payload.push(...intToLeBytes(RNG.randint(1000, 1200), 4));
    payload.push(...intToLeBytes(utf8(stringParam).length, 4));
    const md5Bytes = hexToBytes(dValue);
    for (let i = 0; i < 8; i++) payload.push(md5Bytes[i] ^ seedByte);
    const a1Full = utf8(a1Value).slice(0, A1_LENGTH);
    const a1Bytes = new Uint8Array(A1_LENGTH); a1Bytes.set(a1Full);
    payload.push(a1Bytes.length); payload.push(...a1Bytes);
    const appFull = utf8(appId).slice(0, APP_ID_LENGTH);
    const appBytes = new Uint8Array(APP_ID_LENGTH); appBytes.set(appFull);
    payload.push(appBytes.length); payload.push(...appBytes);
    const part11 = [1, seedByte ^ ENV_TABLE[0]];
    for (let i = 1; i < 15; i++) part11.push(ENV_TABLE[i] ^ ENV_CHECKS_DEFAULT[i]);
    payload.push(...part11);
    const md5PathBytes = hexToBytes(mValue);
    const hashed = customHashV2([...tsBytes, ...md5PathBytes]);
    payload.push(...A3_PREFIX, ...hashed.map((b) => b ^ seedByte));
    return payload;
  }
  function xorTransform(src) {
    const key = hexToBytes(HEX_KEY);
    const out = new Uint8Array(src.length);
    for (let i = 0; i < src.length; i++) out[i] = (i < key.length ? (src[i] ^ key[i]) : src[i]) & 0xff;
    return out;
  }

  function signXs(method, uri, a1Value, { appId = 'xhs-pc-web', payload = null, timestampSec = null } = {}) {
    uri = extractUri(uri);
    if (timestampSec === null) timestampSec = Date.now() / 1000;
    const contentString = buildContentString(method, uri, payload);
    const dValue = md5Hex(contentString);
    const mValue = method.toUpperCase() === 'GET' ? dValue : md5Hex(uri);
    const xorResult = xorTransform(buildPayloadArray(dValue, mValue, a1Value, appId, contentString, timestampSec));
    const x3sig = encodeX3(xorResult.slice(0, PAYLOAD_LENGTH));
    return XYS_PREFIX + encodeCustomStr(jsonCompact({ ...SIGNATURE_DATA_TEMPLATE, x3: X3_PREFIX + x3sig }));
  }

  function randomUint32() {
    const out = new Uint32Array(1);
    crypto.getRandomValues(out);
    return out[0] >>> 0;
  }

  async function sha256Prefix(value) {
    const digest = await crypto.subtle.digest('SHA-256', utf8(String(value)));
    return Array.from(new Uint8Array(digest).slice(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function finiteInteger(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(parsed)));
  }

  async function normalizeSpiderV3State(cookieDict, suppliedState, nowMs = Date.now()) {
    const a1Tag = await sha256Prefix(cookieDict.a1);
    const supplied = suppliedState && typeof suppliedState === 'object' ? suppliedState : {};
    const suppliedLoadts = finiteInteger(supplied.loadts, 0, 1, Number.MAX_SAFE_INTEGER);
    const reusable = supplied.version === SPIDER_V3.schemaVersion
      && supplied.a1Tag === a1Tag
      && suppliedLoadts > 0;
    const cookieLoadts = /^\d{13}$/.test(cookieDict.loadts || '') ? Number(cookieDict.loadts) : 0;
    const loadts = reusable
      ? suppliedLoadts
      : (cookieLoadts || (nowMs - RNG.randint(50, 200)));
    const b1Seed = reusable
      ? finiteInteger(supplied.b1Seed, randomUint32(), 0, 0xffffffff)
      : randomUint32();
    return {
      version: SPIDER_V3.schemaVersion,
      a1Tag,
      loadts,
      dsllt: reusable
        ? finiteInteger(supplied.dsllt, loadts, 1, Number.MAX_SAFE_INTEGER)
        : loadts,
      mnsSeq: reusable ? finiteInteger(supplied.mnsSeq, 0, 0, 0x7fffffff) : 0,
      signCount: reusable ? finiteInteger(supplied.signCount, 0, 0, 0x7fffffff) : 0,
      b1Seed,
      timeOrigin: reusable && Number.isFinite(Number(supplied.timeOrigin))
        ? Number(supplied.timeOrigin)
        : loadts - (700 + (b1Seed % 1600)),
      webBuild: String(cookieDict.webBuild || supplied.webBuild || SPIDER_V3.webBuild),
      reset: !reusable,
    };
  }

  function spiderV3Telemetry(state) {
    const seed = state.b1Seed >>> 0;
    const mouseCount = 45 + (seed % 11);
    const clickCount = 1 + ((seed >>> 5) % 3);
    const focusCount = 3 + ((seed >>> 9) % 4);
    const blurCount = Math.max(1, focusCount - 1);
    return `{mt:{to:${state.timeOrigin}},m:{me:${mouseCount},mm:${mouseCount},md:${clickCount},mu:${clickCount},c:${clickCount}},k:{},p:{ulr:1,ps:1,f:${focusCount},b:${blurCount},vc:0,rs:1,sc:0},st:{h:0,f:1,kr:0},ft:{ae:3.3656015629507223,ak:6.231183732330187,cdr:0.4096814442007536,bf:{ar:0.6210873146622735,fr:7.158084478545331},fi:${2151.1 + (seed % 200) / 10}}}`;
  }

  function generateSpiderV3B1(state, nowMs) {
    const seed = state.b1Seed >>> 0;
    const mini = {
      x33: '0',
      x34: '0',
      x35: '0',
      x36: String(2 + (seed % 3)),
      x37: '0|0|0|0|0|0|0|0|0|1|0|0|1|0|0|0|0|1|1|0|0|0|0|0',
      x38: '0|0|1|0|1|0|0|0|0|0|1|0|1|0|1|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0',
      x39: String(21 + ((seed >>> 4) % 3)),
      x42: '3.5.4',
      x43: 'Canvas not supported',
      x44: String(nowMs),
      x45: '__SEC_CAV__1-1-1-1-1|',
      x46: 'false',
      x48: '',
      x49: '{list:[],type:}',
      x50: '131,88,103',
      x51: '',
      x52: '',
      x82: '1|_BHjFmfUMEtxhI|_AUuXfEG27Xa3x|__xhsPendingNotePoint25300ReportMap|__xhsReportedNotePoint25300RecordMap|setImDebugMode|anti_hp_sign_config|__rap_app_id__|__rap_report__|__rap_last_sign_cost__|__rap_last_transform_cost__|__rap_hijack_installed__|__ed1a7dddf7c818e4bd',
      x84: spiderV3Telemetry(state),
    };
    const cipher = rc4(utf8(B1_SECRET_KEY), utf8(jsonCompact(mini)));
    let binary = '';
    for (const byte of cipher) binary += String.fromCharCode(byte);
    return encodeCustom(utf8(binary));
  }

  function buildSpiderV3Payload(api, a1Value, context) {
    const a1Bytes = Array.from(utf8(a1Value));
    if (a1Bytes.length !== A1_LENGTH) {
      throw new Error(`Spider v3 requires a ${A1_LENGTH}-byte a1 cookie`);
    }
    const appBytes = Array.from(utf8(SPIDER_V3.appId));
    const version = context.version >>> 0;
    const versionByte = version & 0xff;
    const timestampBytes = intToLeBytes(context.now, 8);
    const md5Full = hexToBytes(md5Hex(api));
    const md5Api = hexToBytes(md5Hex(api));
    const dsSignature = customHashV2([...timestampBytes, ...md5Api]);
    const payload = [
      ...VERSION_BYTES,
      ...intToLeBytes(version, 4),
      ...timestampBytes,
      ...intToLeBytes(context.loadts, 8),
      ...intToLeBytes(context.seq, 4),
      ...intToLeBytes(SPIDER_V3.envConst, 4),
      ...intToLeBytes(utf8(api).length, 4),
      ...md5Full.slice(0, 8).map((byte) => byte ^ versionByte),
      a1Bytes.length,
      ...a1Bytes,
      appBytes.length,
      ...appBytes,
      1,
      versionByte ^ 115,
      ...SPIDER_V3.envFpTail,
      2,
      97,
      51,
      16,
      ...dsSignature.map((byte) => byte ^ versionByte),
    ];
    if (payload.length !== PAYLOAD_LENGTH) {
      throw new Error(`Spider v3 MNS payload length mismatch: ${payload.length}`);
    }
    return payload;
  }

  function signSpiderV3Comment(api, cookieDict, state, dsl, options = {}) {
    const nextState = { ...state };
    nextState.mnsSeq += 1;
    nextState.signCount += 1;
    const now = finiteInteger(options.now, Date.now(), 1, Number.MAX_SAFE_INTEGER);
    if (now - nextState.dsllt >= SPIDER_V3_DSLLT_REFRESH_MS) nextState.dsllt = now;
    const context = {
      now,
      loadts: nextState.loadts,
      seq: nextState.mnsSeq,
      version: options.version == null ? randomUint32() : Number(options.version) >>> 0,
    };
    const x3 = X3_PREFIX + encodeX3(xorTransform(buildSpiderV3Payload(api, cookieDict.a1, context)));
    const xs = XYS_PREFIX + encodeCustomStr(jsonCompact({
      x0: SPIDER_V3.signVersion,
      x1: SPIDER_V3.appId,
      x2: SPIDER_V3.platform,
      x3,
      x4: '',
    }));
    const xt = String(now);
    const b1 = generateSpiderV3B1(nextState, now);
    const xsCommon = encodeCustomStr(jsonCompact({
      s0: 5,
      s1: '',
      x0: '1',
      x1: SPIDER_V3.signVersion,
      x2: SPIDER_V3.platform,
      x3: SPIDER_V3.appId,
      x4: nextState.webBuild,
      x5: cookieDict.a1,
      x6: '',
      x7: '',
      x8: b1,
      x9: crc32JsInt(b1),
      x10: nextState.signCount,
      x11: 'normal',
      x12: `${nextState.dsllt};${dsl}`,
    }));
    delete nextState.reset;
    return {
      state: nextState,
      headers: {
        'x-s': xs,
        'x-t': xt,
        'x-s-common': xsCommon,
        'x-b3-traceid': b3TraceId(),
        'x-xray-traceid': xrayTraceId(now),
      },
      debug: { x3Prefix: x3.slice(0, 12), x3Length: x3.length, b1Length: b1.length },
    };
  }

  function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  function bytesToHex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  async function signXyw(method, uri, a1Value, { appId = 'xhs-pc-web', payload = null, timestampSec = null } = {}) {
    uri = extractUri(uri);
    if (timestampSec === null) timestampSec = Date.now() / 1000;
    const contentString = buildContentString(method, uri, payload);
    const timestampMs = String(Math.floor(timestampSec * 1000));
    const x1 = md5Hex(`url=${contentString}`);
    const message = utf8(`x1=${x1};x2=${XYW_ENV_FLAGS};x3=${a1Value};x4=${timestampMs};`);
    const plaintext = utf8(bytesToBase64(message));
    const key = await crypto.subtle.importKey('raw', utf8(XYW_AES_KEY), 'AES-CBC', false, ['encrypt']);
    const encrypted = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-CBC', iv: utf8(XYW_AES_IV) },
      key,
      plaintext,
    ));
    const signData = {
      signSvn: '56',
      signType: 'x2',
      appId,
      signVersion: '1',
      payload: bytesToHex(encrypted),
    };
    return XYW_PREFIX + bytesToBase64(utf8(jsonCompact(signData)));
  }

  // x-rap-param: ported from xhshow 4.3.5. Feed/search endpoints started
  // requiring this browser-risk-control envelope in the 2026 server rollout.
  const XRAP_ROUND_KEYS = [
    [0x6B714931, 0x44546377, 0x4B583930, 0x5A744179],
    [0x89314C98, 0xCD652FEF, 0x863D16DF, 0xDC4957A6],
    [0xC205330C, 0x0F601CE3, 0x895D0A3C, 0x55145D9A],
    [0xD205006E, 0xDD651C8D, 0x543816B1, 0x012C4B2B],
    [0x770C2B6F, 0xAA6937E2, 0xFE512153, 0xFF7D6A78],
    [0x7866FBF4, 0xD20FCC16, 0x2C5EED45, 0xD323873D],
    [0x90E9C67E, 0x42E60A68, 0x6EB8E72D, 0xBD9B6010],
    [0xE9C52BEE, 0xAB232186, 0xC59BC6AB, 0x7800A6BB],
    [0x13BA9A3E, 0xB899BBB8, 0x7D027D13, 0x0502DBA8],
    [0x50613270, 0xE8F889C8, 0x95FAF4DB, 0x90F82F73],
  ];
  const XRAP_LAST_KEY = [0xF396B44F, 0x1B6E3D87, 0x8E94C95C, 0x1E6CE62F];
  const XRAP_SBOX = Uint8Array.from(hexToBytes(
    '7a0158e0504e02791d4b53da6b48d452ed7712211415ec1018e5b9f10c08fc7d' +
    'f9cdb5c8e637268756bab82badf068f78b8dd35e364d2e923182f229703d2dd7' +
    'b640b243448078d20d494a09636c073a9ed506c6e162f4342459a9572a003e17' +
    '2c0a1a42fa93bedcf5b36a13e803c797bb737686e3467247d0054c387c1f81ab' +
    '7551ebf33274118f84899c71227e9dcf3f9169653c6d96a2989933399acac39f' +
    'a0bce4a3a4547fa7a8046f5dacb727afb02841aeb46e0b1bdf8e30b1fe906160' +
    'c0cb5c0eef1683ea20e9c955c44585cc1eaa678a7b35d619d8d9c2db94dd1cde' +
    'a6fff8bf5b5a0fe7c1bdd166c525ee8ce25f88a13ba5f6ce952f6423fbfd4f9b'
  ));
  const XRAP_TRACE = Uint8Array.from(hexToBytes(
    '0002000200004700000000000001ffd9ffa8005c23fff1ffff001501ff90fff9000022fff2ffff' +
    '001501ffb800770061a5ffe3ffff002a01fffcffe70000f0ffe4ffff002a01ffd30000003e01' +
    'ffd40000003e01ffc8ffff005301ffbdfffa006901ffbefffb006901ffb1fff4007d01ffa6ff' +
    'ee009301ffa8ffef009301ff9effe900a801ff96ffe600be01ff97ffe600be01ff93ffe500d3' +
    '01ff92ffe500ea01ff92ffe4010501ff92ffe3011b01ff92ffe402d101ff93ffe502f201ff94' +
    'ffe6040501'
  ));
  const XRAP_ENV = Uint8Array.from(hexToBytes(
    '000000010000000000000000fffeffff00000000000000390001ffff00bc00000000006e0002' +
    '0001013400000000012f00000002011a00000000016100000000019f000000000247000000000279' +
    '0000000002b1'
  ));
  const xrapConcat = (...parts) => {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    return out;
  };
  const xrapU16 = (value) => Uint8Array.of((value >>> 8) & 0xff, value & 0xff);
  const xrapU32 = (value) => Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  const xrapU64 = (value) => {
    let n = BigInt(value);
    const out = new Uint8Array(8);
    for (let i = 7; i >= 0; i--) { out[i] = Number(n & 0xffn); n >>= 8n; }
    return out;
  };
  const xrapFieldByte = (tag, value = 0) => xrapConcat(xrapU16(tag), Uint8Array.of(value));
  const xrapFieldU32 = (tag, value) => xrapConcat(xrapU16(tag), xrapU32(value));
  const xrapFieldU64 = (tag, value) => xrapConcat(xrapU16(tag), xrapU64(value));
  const xrapFieldBlob = (tag, value) => xrapConcat(xrapU16(tag), xrapU32(value.length), value);
  function xrapXxh32(data, seed = 0) {
    const p1 = 0x9E3779B1, p2 = 0x85EBCA77, p3 = 0xC2B2AE3D, p4 = 0x27D4EB2F, p5 = 0x165667B1;
    const round = (acc, word) => Math.imul(rotl(u32(acc + Math.imul(word, p2)), 13), p1) >>> 0;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let pos = 0, digest;
    if (data.length >= 16) {
      let a1 = u32(seed + p1 + p2), a2 = u32(seed + p2), a3 = seed >>> 0, a4 = u32(seed - p1);
      while (pos <= data.length - 16) {
        a1 = round(a1, view.getUint32(pos, true)); pos += 4;
        a2 = round(a2, view.getUint32(pos, true)); pos += 4;
        a3 = round(a3, view.getUint32(pos, true)); pos += 4;
        a4 = round(a4, view.getUint32(pos, true)); pos += 4;
      }
      digest = u32(rotl(a1, 1) + rotl(a2, 7) + rotl(a3, 12) + rotl(a4, 18));
    } else {
      digest = u32(seed + p5);
    }
    digest = u32(digest + data.length);
    while (pos + 4 <= data.length) {
      digest = Math.imul(rotl(u32(digest + Math.imul(view.getUint32(pos, true), p3)), 17), p4) >>> 0;
      pos += 4;
    }
    while (pos < data.length) {
      digest = Math.imul(rotl(u32(digest + Math.imul(data[pos], p5)), 11), p1) >>> 0;
      pos++;
    }
    digest ^= digest >>> 15;
    digest = Math.imul(digest, p2) >>> 0;
    digest ^= digest >>> 13;
    digest = Math.imul(digest, p3) >>> 0;
    digest ^= digest >>> 16;
    return digest >>> 0;
  }
  let xrapLuts;
  function getXrapLuts() {
    if (xrapLuts) return xrapLuts;
    const tables = Array.from({ length: 4 }, () => new Uint32Array(256));
    const gf2 = (value) => ((value << 1) ^ ((value & 0x80) ? 0x11b : 0)) & 0xff;
    XRAP_SBOX.forEach((s, i) => {
      const a = gf2(s), d = a ^ s;
      tables[0][i] = u32((a << 24) | (s << 16) | (s << 8) | d);
      tables[1][i] = u32((d << 24) | (a << 16) | (s << 8) | s);
      tables[2][i] = u32((s << 24) | (d << 16) | (a << 8) | s);
      tables[3][i] = u32((s << 24) | (s << 16) | (d << 8) | a);
    });
    xrapLuts = tables;
    return tables;
  }
  function xrapEncryptBlock(block) {
    const src = new Uint8Array(16);
    src.set(block.slice(0, 16));
    const view = new DataView(src.buffer);
    let state = [0, 1, 2, 3].map((i) => u32(view.getUint32(i * 4) ^ XRAP_ROUND_KEYS[0][i]));
    const lut = getXrapLuts();
    for (let round = 1; round < 10; round++) {
      const next = [];
      for (let i = 0; i < 4; i++) {
        next[i] = u32(
          lut[0][state[i] >>> 24] ^
          lut[1][(state[(i + 1) & 3] >>> 16) & 0xff] ^
          lut[2][(state[(i + 2) & 3] >>> 8) & 0xff] ^
          lut[3][state[(i + 3) & 3] & 0xff] ^
          XRAP_ROUND_KEYS[round][i]
        );
      }
      state = next;
    }
    const lastKey = xrapConcat(...XRAP_LAST_KEY.map(xrapU32));
    const out = new Uint8Array(16);
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        const index = (state[(row + col) & 3] >>> (24 - 8 * col)) & 0xff;
        out[row * 4 + col] = XRAP_SBOX[index] ^ lastKey[row * 4 + col];
      }
    }
    return out;
  }
  function xrapEncryptBlocks(data) {
    const blocks = [];
    for (let offset = 0; offset < data.length; offset += 16) blocks.push(xrapEncryptBlock(data.slice(offset, offset + 16)));
    return xrapConcat(...blocks);
  }
  const xrapRandomAscii = (length) => {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let value = '';
    for (let i = 0; i < length; i++) value += chars[RNG.randint(0, chars.length - 1)];
    return value;
  };
  function xrapBuildBody(api, data, options) {
    const bodyString = typeof data === 'string' ? data : jsonCompact(data);
    const timestamp = options.timestampMs ?? Date.now();
    const innerKey = utf8(options.innerKey ?? xrapRandomAscii(16));
    const mask = options.mask ?? RNG.randint(1, 255);
    const nonce = options.bodyRand32 ?? RNG.randint(0, 0xffffffff);
    const fields = [
      xrapFieldU64(0x03e8, timestamp),
      xrapFieldU32(0x03e9, nonce),
      xrapFieldBlob(0x03ea, innerKey),
      xrapFieldU32(0x03eb, xrapXxh32(utf8(api + bodyString))),
    ];
    for (const tag of [...Array.from({ length: 15 }, (_, i) => 1051 + i), 1070, ...Array.from({ length: 4 }, (_, i) => 1066 + i)]) {
      fields.push(xrapFieldByte(tag));
    }
    fields.push(xrapFieldU32(1100, 0));
    for (let tag = 1071; tag < 1074; tag++) fields.push(xrapFieldByte(tag));
    fields.push(xrapFieldU32(1075, 0x564), xrapFieldU32(1076, 0x2c));
    fields.push(xrapFieldU64(1077, Math.max(0, timestamp - 0x434)), xrapFieldBlob(1078, XRAP_TRACE));
    fields.push(xrapFieldU32(1082, 0), xrapFieldU32(1084, 0), xrapFieldU32(1085, 0), xrapFieldU32(1086, 100));
    fields.push(xrapFieldU64(1087, Math.max(0, timestamp - 0x2d7)), xrapFieldBlob(1088, XRAP_ENV));
    fields.push(xrapFieldU32(1090, 0), xrapFieldU32(1097, 0), xrapFieldU32(1092, 0x566), xrapFieldU32(1094, 0x519));
    fields.push(xrapFieldU64(1095, Math.max(0, timestamp - 0x218c)), xrapFieldU32(1093, 0), xrapFieldByte(1096));
    fields.push(xrapFieldBlob(1091, Uint8Array.of(0, 0, 0xff, 0xff)));
    for (let tag = 1151; tag < 1157; tag++) fields.push(xrapFieldByte(tag));
    const raw = xrapConcat(...fields);
    for (let i = 16; i < raw.length; i++) raw[i] ^= mask;
    return raw;
  }
  async function xrapGzip(data, mtime) {
    if (typeof CompressionStream !== 'function') throw new Error('CompressionStream(gzip) is unavailable');
    const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('gzip'));
    const output = new Uint8Array(await new Response(stream).arrayBuffer());
    if (mtime !== undefined && output.length >= 10) {
      const value = mtime >>> 0;
      output[4] = value & 0xff; output[5] = (value >>> 8) & 0xff;
      output[6] = (value >>> 16) & 0xff; output[7] = (value >>> 24) & 0xff;
    }
    if (output.length >= 10) output[9] = 0x03;
    return output;
  }
  async function xRapParam(api, data, options = {}) {
    const raw = xrapBuildBody(api, data, options);
    const compressed = await xrapGzip(raw, options.gzipMtime);
    const key = utf8(options.aesKey ?? xrapRandomAscii(16));
    const salt = utf8(options.randomString ?? xrapRandomAscii(RNG.randint(4, 6)));
    const xored = Uint8Array.from(compressed, (byte, i) => byte ^ key[i % key.length]);
    const cipherBody = xrapConcat(xrapEncryptBlocks(xored), xrapU32(compressed.length));
    const content = xrapConcat(salt, xrapEncryptBlock(key), xrapU32(16), cipherBody);
    const processingTime = options.bodyEncryptTime ?? RNG.randint(60, 240);
    const header = xrapConcat(
      Uint8Array.of(0x07, 0x24, 0x01, salt.length),
      xrapU32(1), xrapU32(20), xrapU32(cipherBody.length),
      xrapU32(xrapXxh32(content)), xrapU32(10300), xrapU32(processingTime),
      new Uint8Array(8),
    );
    return bytesToBase64(xrapConcat(header, content));
  }

  function generateB1(fp) {
    const keys = ['x33', 'x34', 'x35', 'x36', 'x37', 'x38', 'x39', 'x42', 'x43', 'x44', 'x45', 'x46', 'x48', 'x49', 'x50', 'x51', 'x52', 'x82'];
    const b1fp = {};
    for (const k of keys) b1fp[k] = fp[k];
    const cipher = rc4(utf8(B1_SECRET_KEY), utf8(jsonCompact(b1fp)));
    let cipherStr = '';
    for (const b of cipher) cipherStr += String.fromCharCode(b);
    const encodedUrl = pyQuote(cipherStr, "!*'()~_-");
    const b = [];
    for (const c of encodedUrl.split('%').slice(1)) {
      b.push(parseInt(c.slice(0, 2), 16));
      for (const ch of c.slice(2)) b.push(ch.charCodeAt(0));
    }
    return encodeCustom(b);
  }

  const GPU_VENDORS = [
    'Google Inc. (Intel)|ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E9B) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'Google Inc. (NVIDIA)|ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x0000250F) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'Google Inc. (AMD)|ANGLE (AMD, AMD Radeon RX 6600 (0x000073FF) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  ];
  const SCREEN_RES = ['1366;768', '1920;1080', '2560;1440'];
  const pick = (arr) => arr[RNG.randint(0, arr.length - 1)];
  const randMd5 = () => md5Hex(RNG.randbytes(32));
  function generateFingerprint(cookies) {
    const cookieString = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const [w, h] = pick(SCREEN_RES).split(';').map(Number);
    const incognito = RNG.randint(0, 99) < 95 ? 'true' : 'false';
    const [vendor, renderer] = pick(GPU_VENDORS).split('|');
    return {
      x1: UA, x2: 'false', x3: 'zh-CN', x4: pick([16, 24, 30, 32]), x5: pick([2, 4, 8, 16]), x6: '24',
      x7: `${vendor},${renderer}`, x8: pick([4, 6, 8, 12, 16]), x9: `${w};${h}`, x10: `${w};${h}`, x11: '-480', x12: 'Asia/Shanghai',
      x13: incognito, x14: incognito, x15: incognito, x16: 'false', x17: 'false', x18: 'un', x19: 'Win32', x20: '',
      x21: 'PDF Viewer,Chrome PDF Viewer', x22: randMd5(), x23: 'false', x24: 'false', x25: 'false', x26: 'false', x27: 'false',
      x28: '0,false,false', x29: '4,7,8', x30: 'swf object not loaded',
      x33: '0', x34: '0', x35: '0', x36: `${RNG.randint(1, 20)}`,
      x37: '0|0|0|0|0|0|0|0|0|1|0|0|0|0|0|0|0|0|1|0|0|0|0|0',
      x38: '0|0|1|0|1|0|0|0|0|0|1|0|1|0|1|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0',
      x39: 0, x40: '0', x41: '0', x42: '3.4.4', x43: randMd5(), x44: `${Date.now()}`,
      x45: '__SEC_CAV__1-1-1-1-1|__SEC_WSA__|', x46: 'false', x47: '1|0|0|0|0|0',
      x48: '', x49: '{list:[],type:}', x50: '', x51: '', x52: '', x82: '_0x17a2|_0x1954',
      x53: randMd5(), x57: cookieString,
    };
  }

  function signXsCommon(cookieDict, fingerprint) {
    const fp = fingerprint || generateFingerprint(cookieDict);
    const b1 = generateB1(fp);
    return encodeCustomStr(jsonCompact({ ...SIGNATURE_XSCOMMON_TEMPLATE, x5: cookieDict.a1, x8: b1, x9: crc32JsInt(b1) }));
  }

  const HEX_CHARS = 'abcdef0123456789';
  function b3TraceId() { let s = ''; for (let i = 0; i < 16; i++) s += HEX_CHARS[RNG.randint(0, 15)]; return s; }
  function xrayTraceId(tsMs) {
    if (!tsMs) tsMs = Date.now();
    const part1 = ((BigInt(tsMs) << 23n) | BigInt(RNG.randint(0, 8388607))).toString(16).padStart(16, '0');
    let part2 = ''; for (let i = 0; i < 16; i++) part2 += HEX_CHARS[RNG.randint(0, 15)];
    return part1 + part2;
  }
  async function signHeaders(method, uri, cookieDict, {
    params = null,
    payload = null,
    timestampSec = null,
    signFormat = 'xys',
  } = {}) {
    if (timestampSec === null) timestampSec = Date.now() / 1000;
    const m = method.toUpperCase();
    const requestData = m === 'GET' ? params : payload;
    const xSignature = signFormat === 'xyw'
      ? await signXyw(m, uri, cookieDict.a1, { payload: requestData, timestampSec })
      : signXs(m, uri, cookieDict.a1, { payload: requestData, timestampSec });
    return {
      'x-s': xSignature,
      'x-s-common': signXsCommon(cookieDict),
      'x-t': String(Math.floor(timestampSec * 1000)),
      'x-b3-traceid': b3TraceId(),
      'x-xray-traceid': xrayTraceId(Math.floor(timestampSec * 1000)),
    };
  }

  // ---------- API layer ----------
  function parseCookies(s) {
    const out = {};
    if (!s) return out;
    for (const part of s.split(';')) { const i = part.indexOf('='); if (i === -1) continue; out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
    return out;
  }
  function normalizePlatform(value) {
    const platform = String(value || '').trim().toLowerCase();
    return platform === 'xhs' || platform === 'rednote' ? platform : 'auto';
  }
  function platformConfig(value) {
    return XHS_PLATFORMS[normalizePlatform(value)] || XHS_PLATFORMS.xhs;
  }
  function platformForApiBase(base) {
    return String(base).includes('rednote.com') ? XHS_PLATFORMS.rednote : XHS_PLATFORMS.xhs;
  }
  function platformCacheKey(cookieStr) {
    const a1 = parseCookies(cookieStr).a1 || '';
    return a1 ? md5Hex(a1).slice(0, 16) : '';
  }
  function getCachedPlatform(cookieStr, now = Date.now()) {
    const key = platformCacheKey(cookieStr);
    const cached = key ? platformCache.get(key) : null;
    if (!cached) return '';
    if (cached.expiresAt <= now) {
      platformCache.delete(key);
      return '';
    }
    return cached.platform;
  }
  function cachePlatform(cookieStr, platform, now = Date.now()) {
    const key = platformCacheKey(cookieStr);
    if (key) platformCache.set(key, { platform, expiresAt: now + PLATFORM_CACHE_TTL_MS });
  }
  function clearCachedPlatform(cookieStr) {
    const key = platformCacheKey(cookieStr);
    if (key) platformCache.delete(key);
  }
  function baseHeaders(cookieStr, apiBase = EDITH) {
    const { webBase } = platformForApiBase(apiBase);
    return {
      accept: 'application/json, text/plain, */*', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'content-type': 'application/json;charset=UTF-8', origin: webBase, referer: webBase + '/', 'user-agent': UA,
      'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Microsoft Edge";v="138"', 'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"', 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-site',
      'x-mns': 'unload', cookie: cookieStr,
    };
  }
  function buildSignedQuery(params) {
    if (!params) return '';
    const keys = Object.keys(params);
    if (!keys.length) return '';
    return keys.map((k) => {
      const v = params[k];
      let s; if (Array.isArray(v)) s = v.map(String).join(','); else if (v !== null && v !== undefined) s = String(v); else s = '';
      return `${k}=${pyQuote(s, ',')}`;
    }).join('&');
  }
  async function readJsonResponse(resp) {
    let data;
    try {
      data = await resp.json();
    } catch {
      data = { success: false, msg: `HTTP ${resp.status} returned a non-JSON response` };
    }
    if (!resp.ok) {
      return { ...data, success: false, http_status: resp.status };
    }
    return data;
  }
  async function fetchSpiderV3Dsl(nowMs = Date.now()) {
    if (spiderV3DslCache.value && spiderV3DslCache.expiresAt > nowMs) {
      return spiderV3DslCache.value;
    }
    try {
      const response = await fetch(SPIDER_V3_DSL_URL, {
        method: 'GET',
        headers: {
          accept: '*/*',
          referer: WWW + '/',
          'user-agent': SPIDER_V3.userAgent,
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const source = await response.text();
      const match = source.match(/function\s+getdss\s*\(\s*\)\s*\{\s*return\s*['"](\d{13})['"]/);
      if (!match) throw new Error('getdss timestamp was not found');
      spiderV3DslCache = { value: match[1], expiresAt: nowMs + SPIDER_V3_DSL_TTL_MS };
      return match[1];
    } catch (error) {
      if (spiderV3DslCache.value) return spiderV3DslCache.value;
      throw new Error(`Spider v3 DSL unavailable: ${error?.message || error}`);
    }
  }

  function spiderV3RequestHeaders(cookieStr, strategy, signedHeaders) {
    const headers = {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      origin: WWW,
      referer: WWW + '/',
      priority: 'u=1, i',
      'user-agent': SPIDER_V3.userAgent,
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-site',
      cookie: cookieStr,
      ...signedHeaders,
    };
    if (strategy === 'browser-hints' || strategy === 'legacy-transport') {
      headers['sec-ch-ua'] = SPIDER_V3.secChUa;
      headers['sec-ch-ua-mobile'] = '?0';
      headers['sec-ch-ua-platform'] = '"Windows"';
    }
    if (strategy === 'legacy-transport') headers['x-mns'] = 'unload';
    return headers;
  }

  async function experimentalComments(cookieStr, body) {
    const strategy = String(body.strategy || 'no-client-hints');
    if (!SPIDER_V3_STRATEGIES.has(strategy)) {
      return {
        success: false,
        error: `Unknown Spider v3 strategy: ${strategy}`,
        error_code: 'XHS_EXPERIMENT_INVALID_STRATEGY',
        allowed_strategies: Array.from(SPIDER_V3_STRATEGIES),
      };
    }
    const noteId = String(body.feed_id || body.note_id || '').trim();
    if (!noteId) {
      return {
        success: false,
        error: 'feed_id is required',
        error_code: 'XHS_EXPERIMENT_MISSING_FEED_ID',
      };
    }
    const cookieDict = parseCookies(cookieStr);
    const now = Date.now();
    const state = await normalizeSpiderV3State(cookieDict, body.session_state, now);
    const stateWasReset = state.reset;
    let dsl;
    try {
      dsl = await fetchSpiderV3Dsl(now);
    } catch (error) {
      const sessionState = { ...state };
      delete sessionState.reset;
      return {
        success: false,
        error: error?.message || String(error),
        error_code: 'XHS_EXPERIMENT_DSL_UNAVAILABLE',
        upstream_requests: { dsl: 1, comments: 0 },
        retry_performed: false,
        session_state: sessionState,
      };
    }
    const params = {
      note_id: noteId,
      cursor: String(body.cursor || ''),
      top_comment_id: String(body.top_comment_id || ''),
      image_formats: 'jpg,webp,avif',
      xsec_token: String(body.xsec_token || ''),
    };
    const uri = '/api/sns/web/v2/comment/page';
    const api = `${uri}?${buildSignedQuery(params)}`;
    const signed = signSpiderV3Comment(api, cookieDict, state, dsl);
    const experiment = {
      name: 'spider-session-v3',
      strategy,
      state_reset: stateWasReset,
      retry_performed: false,
      signature: signed.debug,
    };
    if (body.dry_run === true) {
      return {
        success: true,
        dry_run: true,
        experiment,
        upstream_requests: { dsl: 1, comments: 0 },
        session_state: signed.state,
      };
    }
    const response = await fetch(EDITH + api, {
      method: 'GET',
      headers: spiderV3RequestHeaders(cookieStr, strategy, signed.headers),
    });
    let raw;
    try {
      raw = await response.json();
    } catch {
      raw = { success: false, msg: `HTTP ${response.status} returned a non-JSON response` };
    }
    if (response.status === 406) {
      return {
        success: false,
        error: raw?.msg || 'XHS rejected the isolated comment request with HTTP 406',
        error_code: 'XHS_EXPERIMENT_HTTP_406',
        http_status: 406,
        circuit_open: true,
        retry_performed: false,
        upstream_requests: { dsl: 1, comments: 1 },
        experiment,
        session_state: signed.state,
      };
    }
    if (!response.ok || raw?.success === false) {
      return {
        success: false,
        error: raw?.msg || `XHS comment request failed with HTTP ${response.status}`,
        error_code: 'XHS_EXPERIMENT_UPSTREAM_REJECTED',
        http_status: response.status,
        circuit_open: false,
        retry_performed: false,
        upstream_requests: { dsl: 1, comments: 1 },
        experiment,
        session_state: signed.state,
      };
    }
    const comments = Array.isArray(raw?.data?.comments) ? raw.data.comments.map(normComment) : [];
    return {
      success: true,
      data: {
        comments: {
          list: comments,
          cursor: raw?.data?.cursor || '',
          has_more: !!raw?.data?.has_more,
        },
        comments_status: 'loaded',
        comments_provider: 'spider-session-v3',
      },
      upstream_requests: { dsl: 1, comments: 1 },
      experiment,
      session_state: signed.state,
    };
  }

  async function signedGet(base, uri, params, cookieStr, ck, extraHeaders = {}, signFormat = 'xys', useXrap = false) {
    const query = buildSignedQuery(params);
    const sig = await signHeaders('GET', uri, ck, { params: params || {}, signFormat });
    const requestUri = uri + (query ? '?' + query : '');
    const xrapHeader = useXrap
      ? { 'x-rap-param': await xRapParam(`//${new URL(base).host}${requestUri}`, '') }
      : {};
    const resp = await fetch(base + requestUri, { method: 'GET', headers: { ...baseHeaders(cookieStr, base), ...sig, ...xrapHeader, ...extraHeaders } });
    return readJsonResponse(resp);
  }
  async function signedPost(base, uri, payload, cookieStr, ck, extraHeaders = {}, useXrap = false) {
    const sig = await signHeaders('POST', uri, ck, { payload });
    const xrapHeader = useXrap
      ? { 'x-rap-param': await xRapParam(`//${new URL(base).host}${uri}`, payload) }
      : {};
    const resp = await fetch(base + uri, { method: 'POST', headers: { ...baseHeaders(cookieStr, base), ...sig, ...xrapHeader, ...extraHeaders }, body: JSON.stringify(payload) });
    return readJsonResponse(resp);
  }

  function pickCover(nc) {
    const cover = nc?.cover || {};
    const url = cover.url_default || cover.url_pre || cover.url || (cover.info_list?.[0]?.url) || '';
    return url ? url.replace(/^http:\/\//, 'https://') : '';
  }
  function normItem(item) {
    const nc = item.note_card || item.noteCard || item;
    const user = nc.user || {};
    const interact = nc.interact_info || nc.interactInfo || {};
    const liked = interact.liked_count ?? interact.likedCount ?? 0;
    const id = item.id || nc.note_id || nc.id || '';
    const token = item.xsec_token || nc.xsec_token || '';
    return {
      id, note_id: id, noteId: id, xsec_token: token, xsecToken: token,
      title: nc.display_title || nc.title || '', display_title: nc.display_title || nc.title || '',
      desc: nc.desc || '', type: nc.type || item.model_type || '',
      user: { nickname: user.nickname || user.nick_name || '', user_id: user.user_id || user.userId || '' },
      nickname: user.nickname || '', author: user.nickname || '', authorId: user.user_id || '',
      interact_info: { liked_count: String(liked) }, liked_count: String(liked),
      cover: { url_default: pickCover(nc) },
    };
  }
  function normComment(c) {
    const u = c.user_info || c.userInfo || c.user || {};
    const id = c.id || c.comment_id || c.commentId || '';
    const replies = Array.isArray(c.sub_comments) ? c.sub_comments
      : Array.isArray(c.subComments) ? c.subComments
      : Array.isArray(c.replies) ? c.replies
      : [];
    return {
      id, comment_id: id, commentId: id, content: c.content || c.text || '',
      nickname: u.nickname || u.name || '', author_name: u.nickname || u.name || '',
      user: { nickname: u.nickname || u.name || '', user_id: u.user_id || u.userId || '' },
      like_count: c.like_count ?? c.likeCount ?? c.likes ?? '0',
      likes: c.like_count ?? c.likeCount ?? c.likes ?? '0',
      sub_comments: replies.map(normComment),
    };
  }

  function findCommentArray(value, depth = 0) {
    if (depth > 5 || value == null) return null;
    if (Array.isArray(value)) {
      if (value.length === 0) return value;
      const first = value[0];
      if (first && typeof first === 'object' &&
          (first.content != null || first.comment_id || first.commentId || first.id)) {
        return value;
      }
      return null;
    }
    if (typeof value !== 'object') return null;
    for (const key of ['comments', 'comment_list', 'commentList', 'items', 'list']) {
      const found = findCommentArray(value[key], depth + 1);
      if (found) return found;
    }
    for (const key of ['data', 'result', 'response']) {
      const found = findCommentArray(value[key], depth + 1);
      if (found) return found;
    }
    return null;
  }

  async function getRnoteComments(feedId, env, requestApiKey) {
    const apiKey = requestApiKey || (env && env.RNOTE_API_KEY);
    if (!apiKey) return null;

    const providerUrl = new URL('https://rnote.dev/api/v2/crawler/note/comments');
    providerUrl.searchParams.set('note_id', feedId);
    providerUrl.searchParams.set('index', '0');
    providerUrl.searchParams.set('pageArea', 'UNFOLDED');
    providerUrl.searchParams.set('sort_strategy', 'like_count');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const resp = await fetch(providerUrl.toString(), {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'X-API-Key': apiKey,
        },
        signal: controller.signal,
      });
      const body = await readJsonResponse(resp);
      if (!resp.ok || body?.success === false) {
        return {
          success: false,
          error: {
            status: resp.status,
            code: body?.debug_id || 'COMMENT_PROVIDER_REJECTED',
            message: body?.error || body?.message || `真实评论服务 HTTP ${resp.status}`,
          },
        };
      }
      const rawComments = findCommentArray(body?.data ?? body) || [];
      return {
        success: true,
        comments: rawComments.map(normComment).filter((comment) => comment.content),
        provider: 'rnote',
      };
    } catch (e) {
      return {
        success: false,
        error: {
          code: e?.name === 'AbortError' ? 'COMMENT_PROVIDER_TIMEOUT' : 'COMMENT_PROVIDER_FAILED',
          message: e instanceof Error ? e.message : String(e),
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function getManagedComments(feedId, env, requestRnoteApiKey) {
    const rnoteConfigured = !!(requestRnoteApiKey || env?.RNOTE_API_KEY);
    if (!rnoteConfigured) {
      return {
        success: false,
        error: {
          code: 'COMMENT_PROVIDER_NOT_CONFIGURED',
          message: '真实评论服务尚未配置',
        },
      };
    }

    const cacheKey = new Request(`https://sullyos.invalid/_xhs-comments/${encodeURIComponent(feedId)}`);
    const cache = globalThis.caches && globalThis.caches.default;
    if (cache) {
      const cached = await cache.match(cacheKey);
      if (cached) {
        const data = await cached.json();
        return {
          success: true,
          comments: data.comments || [],
          provider: data.provider || 'managed-cache',
          cached: true,
        };
      }
    }

    const result = await getRnoteComments(feedId, env, requestRnoteApiKey);
    if (result?.success) {
      const comments = result.comments || [];
      if (cache) {
        const cacheResponse = new Response(JSON.stringify({
          comments,
          provider: result.provider,
        }), {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'public, max-age=300',
          },
        });
        await cache.put(cacheKey, cacheResponse);
      }
      return { ...result, comments, cached: false };
    }
    return result || {
      success: false,
      error: { code: 'COMMENT_PROVIDER_NOT_CONFIGURED', message: '真实评论服务尚未配置' },
    };
  }

  async function checkLoginOnPlatform(cookieStr, platform) {
    const config = platformConfig(platform);
    const ck = parseCookies(cookieStr);
    let r = await signedGet(config.apiBase, '/api/sns/web/v2/user/me', null, cookieStr, ck);
    let root = r?.data || {};
    let d = root.user_info || root.userInfo || root.user || root;
    let sessionOk = !!(r?.success && (
      d.user_id
      || d.userId
      || root.user_id
      || root.userId
      || d.guest === false
      || root.guest === false
      || d.logged_in === true
      || d.loggedIn === true
    ));
    // The global backend has also shipped /v1/user/selfinfo. Its login bit is
    // nested under data.result.success, so use it as a RedNote-only fallback.
    if (!sessionOk && config.key === 'rednote') {
      const selfInfo = await signedGet(config.apiBase, '/api/sns/web/v1/user/selfinfo', null, cookieStr, ck);
      const selfRoot = selfInfo?.data || {};
      const selfResult = selfRoot.result || {};
      if (selfResult.success === true) {
        r = selfInfo;
        root = selfRoot;
        d = selfResult.user_info || selfResult.userInfo || selfResult.user || selfResult;
        sessionOk = true;
      }
    }
    const userId = d.user_id || d.userId || root.user_id || root.userId || '';
    return {
      logged_in: sessionOk,
      nickname: d.nickname || d.nick_name || root.nickname || '',
      user_id: userId,
      red_id: d.red_id || d.redId || root.red_id || '',
      platform: config.key,
      api_host: new URL(config.apiBase).host,
      web_host: new URL(config.webBase).host,
      raw: r,
    };
  }
  async function checkLogin(cookieStr, requestedPlatform = 'auto') {
    const requested = normalizePlatform(requestedPlatform);
    const cached = requested === 'auto' ? getCachedPlatform(cookieStr) : '';
    const candidates = requested === 'auto'
      ? [...new Set([cached, 'xhs', 'rednote'].filter(Boolean))]
      : [requested];
    let lastResult = null;
    for (const platform of candidates) {
      const result = await checkLoginOnPlatform(cookieStr, platform);
      lastResult = result;
      if (result.logged_in) {
        cachePlatform(cookieStr, platform);
        return result;
      }
    }
    clearCachedPlatform(cookieStr);
    return {
      ...(lastResult || {}),
      logged_in: false,
      platform: requested === 'auto' ? undefined : requested,
      checked_platforms: candidates,
    };
  }
  async function resolvePlatform(cookieStr, requestedPlatform = 'auto') {
    const requested = normalizePlatform(requestedPlatform);
    if (requested !== 'auto') return { platform: requested, login: null };
    const cached = getCachedPlatform(cookieStr);
    if (cached) return { platform: cached, login: null };
    const login = await checkLogin(cookieStr, 'auto');
    return { platform: login.platform || '', login };
  }
  async function listFeeds(cookieStr, { category = 'homefeed_recommend', cursorScore = '', noteIndex = 0, refreshType = 1 } = {}, platform = 'xhs') {
    const { apiBase } = platformConfig(platform);
    const ck = parseCookies(cookieStr);
    const payload = { cursor_score: cursorScore, num: 20, refresh_type: refreshType, note_index: noteIndex, unread_begin_note_id: '', unread_end_note_id: '', unread_note_count: 0, category, search_key: '', need_num: 10, image_formats: IMG_FORMATS, need_filter_image: false };
    const r = await signedPost(apiBase, '/api/sns/web/v1/homefeed', payload, cookieStr, ck);
    return { feeds: (r?.data?.items || []).map(normItem), cursor_score: r?.data?.cursor_score, success: !!r?.success, msg: r?.msg, raw_error: r?.success ? undefined : r };
  }
  const SORT_MAP = { general: 'general', time: 'time_descending', hot: 'popularity_descending', comment: 'comment_descending', collect: 'collect_descending' };
  function genSearchId() {
    const big = (BigInt(Date.now()) << 64n) + BigInt(Math.ceil(0x7ffffffe * Math.random()));
    const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';
    let n = big, s = ''; if (n === 0n) return '0';
    while (n > 0n) { s = B36[Number(n % 36n)] + s; n /= 36n; }
    return s;
  }
  async function search(cookieStr, keyword, { page = 1, sort = 'general' } = {}, platform = 'xhs') {
    const { apiBase } = platformConfig(platform);
    const ck = parseCookies(cookieStr);
    const st = SORT_MAP[sort] || 'general';
    const payload = { keyword, page, page_size: 20, search_id: genSearchId(), sort: st, note_type: 0, ext_flags: [],
      filters: [{ tags: [st], type: 'sort_type' }, { tags: ['不限'], type: 'filter_note_type' }, { tags: ['不限'], type: 'filter_note_time' }, { tags: ['不限'], type: 'filter_note_range' }, { tags: ['不限'], type: 'filter_pos_distance' }],
      geo: '', image_formats: IMG_FORMATS };
    const r = await signedPost(apiBase, '/api/sns/web/v1/search/notes', payload, cookieStr, ck);
    const items = (r?.data?.items || []).filter((it) => it.id && (it.note_card || it.model_type === 'note'));
    return { feeds: items.map(normItem), success: !!r?.success, msg: r?.msg, raw_error: r?.success ? undefined : r };
  }
  async function getFeedDetail(cookieStr, feedId, xsecToken, {
    xsecSource = 'pc_feed',
    loadComments = true,
    env,
    requestRnoteApiKey,
    platform = 'xhs',
  } = {}) {
    const { apiBase } = platformConfig(platform);
    const ck = parseCookies(cookieStr);
    const payload = { source_note_id: feedId, image_formats: IMG_FORMATS, extra: { need_body_topic: '1' }, xsec_source: xsecSource || 'pc_feed', xsec_token: xsecToken || '' };
    const r = await signedPost(apiBase, '/api/sns/web/v1/feed', payload, cookieStr, ck, { 'xy-direction': '13' });
    const nc = r?.data?.items?.[0]?.note_card || {};
    const note = { note_id: feedId, title: nc.title || '', content: nc.desc || '', desc: nc.desc || '', user: nc.user || {}, interact_info: nc.interact_info || {}, image_list: nc.image_list || [], xsec_token: xsecToken || '' };
    const embeddedComments = findCommentArray(nc?.comments) || [];
    let comments = embeddedComments.map(normComment).filter((comment) => comment.content);
    let commentsStatus = comments.length ? 'loaded' : 'not_requested';
    let commentsError;
    let commentsProvider;
    if (loadComments && comments.length === 0) {
      const managed = await getManagedComments(feedId, env, requestRnoteApiKey);
      if (managed.success) {
        comments = managed.comments;
        commentsProvider = managed.provider;
        commentsStatus = comments.length ? 'loaded' : 'empty';
      } else {
        commentsStatus = 'unavailable';
        commentsError = managed.error;
      }
    }
    return {
      data: {
        note,
        comments: { list: comments },
        comments_status: commentsStatus,
        comments_provider: commentsProvider,
        comments_error: commentsError,
      },
      success: !!r?.success,
      msg: r?.msg,
      raw_error: r?.success ? undefined : r,
    };
  }
  async function userProfile(cookieStr, userId, xsecToken, platform = 'xhs') {
    const { apiBase } = platformConfig(platform);
    const ck = parseCookies(cookieStr);
    let info = null;
    let infoError = '';
    try {
      info = await signedGet(apiBase, '/api/sns/web/v1/user/otherinfo', { target_user_id: userId }, cookieStr, ck);
      if (!info?.success) infoError = info?.msg || `HTTP ${info?.http_status || 'unknown'}`;
    } catch (e) {
      infoError = e?.message || String(e);
    }
    let notes = [];
    let notesLoaded = false;
    let notesError = '';
    try {
      // Spider_XHS 将 user_posted 列入 RAP 白名单；GET 的 RAP 摘要包含完整 query，body 为空串。
      const posted = await signedGet(apiBase, '/api/sns/web/v1/user_posted', { num: 30, cursor: '', user_id: userId, image_formats: 'jpg,webp,avif', xsec_token: xsecToken || '', xsec_source: 'pc_user' }, cookieStr, ck, {}, 'xys', true);
      notesLoaded = !!posted?.success;
      notes = (posted?.data?.notes || []).map(normItem);
      if (!notesLoaded) notesError = posted?.msg || `HTTP ${posted?.http_status || 'unknown'}`;
    } catch (e) {
      notesError = e?.message || String(e);
    }
    if (!info?.success && !notesLoaded) {
      return { error: `获取主页失败: ${notesError || infoError || '上游未返回成功状态'}` };
    }
    return {
      basic_info: info?.data?.basic_info || {},
      notes,
      feeds: notes,
      success: true,
      profile_status: info?.success ? 'loaded' : 'unavailable',
      profile_error: info?.success ? undefined : infoError,
      notes_status: notesLoaded ? 'loaded' : 'unavailable',
      notes_error: notesLoaded ? undefined : notesError,
    };
  }
  async function likeFeed(cookieStr, feedId, unlike = false, platform = 'xhs') {
    const { apiBase } = platformConfig(platform);
    const ck = parseCookies(cookieStr);
    const r = await signedPost(apiBase, unlike ? '/api/sns/web/v1/note/dislike' : '/api/sns/web/v1/note/like', { note_oid: feedId }, cookieStr, ck);
    return { success: !!r?.success, msg: r?.msg, raw: r };
  }
  async function favoriteFeed(cookieStr, feedId, unfavorite = false, platform = 'xhs') {
    const { apiBase } = platformConfig(platform);
    const ck = parseCookies(cookieStr);
    const r = await signedPost(apiBase, unfavorite ? '/api/sns/web/v1/note/uncollect' : '/api/sns/web/v1/note/collect', unfavorite ? { note_ids: feedId } : { note_id: feedId }, cookieStr, ck);
    return { success: !!r?.success, msg: r?.msg, raw: r };
  }
  async function postComment(cookieStr, feedId, content, { targetCommentId = null, xsecToken = '', platform = 'xhs' } = {}) {
    const { apiBase } = platformConfig(platform);
    const ck = parseCookies(cookieStr);
    const payload = { note_id: feedId, content, at_users: [] };
    if (xsecToken) payload.xsec_token = xsecToken;
    if (targetCommentId) payload.target_comment_id = targetCommentId;
    // Spider_XHS 的 RAP 白名单同样包含 comment/post。
    const r = await signedPost(apiBase, '/api/sns/web/v1/comment/post', payload, cookieStr, ck, {}, true);
    if (!r?.success) {
      return { error: `评论失败: ${r?.msg || `HTTP ${r?.http_status || 'unknown'}`}`, raw: r };
    }
    return { success: true, msg: r?.msg, comment: r?.data?.comment, raw: r };
  }

  async function sha1Hex(str) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  async function hmacSha1Hex(key, msg) {
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  async function cosUploadSignature(message, fileId, contentLength, host) {
    host = host || 'ros-upload.xiaohongshu.com';
    const signKey = await hmacSha1Hex('null', message);
    const params = await sha1Hex(`put\n/spectrum/${fileId}\n\ncontent-length=${contentLength}&host=${host}\n`);
    return hmacSha1Hex(signKey, `sha1\n${message}\n${params}\n`);
  }
  function imageSize(buf) {
    try {
      if (buf[0] === 0x89 && buf[1] === 0x50) { const dv = new DataView(buf.buffer); return { width: dv.getUint32(16), height: dv.getUint32(20) }; }
      if (buf[0] === 0xff && buf[1] === 0xd8) {
        let o = 2;
        while (o < buf.length) {
          if (buf[o] !== 0xff) { o++; continue; }
          const marker = buf[o + 1];
          if (marker >= 0xc0 && marker <= 0xc3) { const dv = new DataView(buf.buffer); return { height: dv.getUint16(o + 5), width: dv.getUint16(o + 7) }; }
          o += 2 + ((buf[o + 2] << 8) | buf[o + 3]);
        }
      }
      if (buf[8] === 0x57 && buf[9] === 0x45 && buf[12] === 0x56 && buf[15] === 0x20) {
        return { width: ((buf[27] << 8) | buf[26]) & 0x3fff, height: ((buf[29] << 8) | buf[28]) & 0x3fff };
      }
    } catch (e) { /* ignore */ }
    return null;
  }
  // 上传凭证：不同登录态/版本接口名不同，依次尝试，取第一个成功的
  async function getUploadPermit(cookieStr, ck) {
    const params = { biz_name: 'spectrum', scene: 'image', file_count: '1', version: '1', source: 'web' };
    const candidates = [
      { host: EDITH, path: '/api/media/v1/upload/web/permit', origin: WWW, referer: WWW + '/' },
      { host: CREATOR, path: '/api/media/v1/upload/creator/permit', origin: CREATOR, referer: CREATOR + '/publish/publish' },
      { host: EDITH, path: '/api/media/v1/upload/creator/permit', origin: CREATOR, referer: CREATOR + '/publish/publish' },
      { host: CREATOR, path: '/api/media/v1/upload/web/permit', origin: WWW, referer: WWW + '/' },
    ];
    let lastErr = '';
    for (const c of candidates) {
      try {
        const sig = signHeaders('GET', c.path, ck, { params });
        const resp = await fetch(c.host + c.path + '?' + buildSignedQuery(params), { method: 'GET', headers: { ...baseHeaders(cookieStr), ...sig, origin: c.origin, referer: c.referer } });
        const j = await resp.json().catch(() => ({}));
        const permit = j?.data?.uploadTempPermits?.[0];
        if (permit) return { permit, xt: sig['x-t'] };
        lastErr = `${c.path}@${c.host.replace('https://', '')} -> ${JSON.stringify(j).slice(0, 120)}`;
      } catch (e) { lastErr = `${c.path}: ${e.message}`; }
    }
    throw new Error('获取上传凭证失败（已试多种接口）: ' + lastErr);
  }
  async function uploadImageFromUrl(cookieStr, ck, imgUrl) {
    const imgResp = await fetch(imgUrl);
    if (!imgResp.ok) throw new Error(`图片下载失败 ${imgResp.status}: ${imgUrl}`);
    const buf = new Uint8Array(await imgResp.arrayBuffer());
    const mime = imgResp.headers.get('content-type') || 'image/png';
    const { width, height } = imageSize(buf) || { width: 1080, height: 1080 };
    const { permit, xt } = await getUploadPermit(cookieStr, ck);
    const fileIds = permit.fileIds[0].split('/').pop();
    const uploadAddr = permit.uploadAddr || 'ros-upload.xiaohongshu.com';
    const uploadHost = uploadAddr.replace(/^https?:\/\//, '');
    const uploadBase = uploadAddr.startsWith('http') ? uploadAddr : `https://${uploadAddr}`;
    const message = `${String(xt).slice(0, 10)};${String(permit.expireTime).slice(0, 10)}`;
    const signature = await cosUploadSignature(message, fileIds, buf.length, uploadHost);
    const putResp = await fetch(`${uploadBase}/spectrum/${fileIds}`, {
      method: 'PUT',
      headers: { accept: '*/*', authorization: `q-sign-algorithm=sha1&q-ak=null&q-sign-time=${message}&q-key-time=${message}&q-header-list=content-length;host&q-url-param-list=&q-signature=${signature}`, origin: CREATOR, referer: CREATOR + '/', 'user-agent': UA, 'x-cos-security-token': permit.token, cookie: cookieStr },
      body: buf,
    });
    if (!putResp.ok) throw new Error(`图片上传失败 ${putResp.status}`);
    return { fileIds, width, height, file_size: buf.length, mime_type: mime };
  }
  function buildImageNoteData(title, desc, privacyType, fileInfos, hashTags) {
    const images = fileInfos.map((f) => ({
      file_id: `spectrum/${f.fileIds}`, width: f.width, height: f.height, metadata: { source: -1 }, stickers: { version: 2, floating: [] },
      extra_info_json: JSON.stringify({ mimeType: f.mime_type || 'image/png', image_metadata: { bg_color: '', origin_size: (f.file_size || 0) / 1024 } }),
    }));
    const contextJson = JSON.stringify({ recommend_title: { recommend_title_id: '', is_use: 3, used_index: -1 }, recommendTitle: [], recommend_topics: { used: [] } });
    return {
      common: { type: 'normal', title, note_id: '', desc, source: '{"type":"web","ids":"","extraInfo":"{\\"subType\\":\\"official\\",\\"systemId\\":\\"web\\"}"}', ats: [], hash_tag: hashTags, post_loc: {}, privacy_info: { op_type: 1, type: privacyType, user_ids: [] }, goods_info: {}, biz_relations: [], capa_trace_info: { contextJson } },
      image_info: { images }, video_info: null,
    };
  }
  async function publishNote(cookieStr, { title = '', content = '', images = [], tags = [], isPrivate = false }) {
    const ck = parseCookies(cookieStr);
    const fileInfos = [];
    for (const imgUrl of images) fileInfos.push(await uploadImageFromUrl(cookieStr, ck, imgUrl));
    if (!fileInfos.length) return { error: '小红书发帖至少需要一张图片，请提供 images（图床 URL 数组）' };
    let desc = content;
    const hashTags = [];
    for (const t of tags) { const name = String(t).replace(/^#/, ''); desc += ` #${name}[话题]#`; hashTags.push({ id: '', link: '', name, type: 'topic' }); }
    const r = await signedPost(EDITH, '/web_api/sns/v2/note', buildImageNoteData(title, desc, isPrivate ? 1 : 0, fileInfos, hashTags), cookieStr, ck);
    const noteId = r?.data?.id || r?.data?.note_id || r?.data?.note?.id || '';
    // 失败用 error 字段：bridgePost 会据此判定 success=false（无需改 useChatAI）
    if (!(r?.success && noteId)) {
      return { error: `发布失败（小红书未确认）: ${JSON.stringify(r).slice(0, 300)}` };
    }
    return { success: true, note_id: noteId, noteId, msg: '发布成功', raw: r };
  }

  async function handle(command, body, cookie, env, requestContext = {}) {
    const requestedPlatform = requestContext.platform || body.platform || 'auto';
    if (command === 'check-login') return checkLogin(cookie, requestedPlatform);

    const resolved = await resolvePlatform(cookie, requestedPlatform);
    if (!resolved.platform) {
      return {
        error: '这串 cookie 在 xiaohongshu.com 和 rednote.com 两套后端都没有通过登录校验。请从当前实际登录的网站重新复制完整请求 Cookie。',
        checked_platforms: resolved.login?.checked_platforms || ['xhs', 'rednote'],
      };
    }
    const platform = resolved.platform;
    let result;
    switch (command) {
      case 'search': result = await search(cookie, body.keyword || '', { sort: body.sort_by, page: body.page }, platform); break;
      case 'list-feeds': result = await listFeeds(cookie, { category: body.category, cursorScore: body.cursor_score, noteIndex: body.note_index }, platform); break;
      case 'get-feed-detail': result = await getFeedDetail(cookie, body.feed_id, body.xsec_token, {
        xsecSource: body.xsec_source,
        loadComments: body.load_all_comments !== false,
        env,
        requestRnoteApiKey: requestContext.rnoteApiKey,
        platform,
      }); break;
      case 'xhs-experimental-comments':
        result = platform === 'rednote'
          ? { error: 'Spider v3 评论实验目前只支持 xiaohongshu.com 国内后端。' }
          : await experimentalComments(cookie, body);
        break;
      case 'post-comment': result = await postComment(cookie, body.feed_id, body.content, { xsecToken: body.xsec_token, platform }); break;
      case 'reply-comment': result = await postComment(cookie, body.feed_id, body.content, { targetCommentId: body.comment_id, xsecToken: body.xsec_token, platform }); break;
      case 'like-feed': result = await likeFeed(cookie, body.feed_id, !!body.unlike, platform); break;
      case 'favorite-feed': result = await favoriteFeed(cookie, body.feed_id, !!body.unfavorite, platform); break;
      case 'user-profile': result = await userProfile(cookie, body.user_id, body.xsec_token, platform); break;
      case 'publish':
        result = platform === 'rednote'
          ? { error: 'RedNote 全球后端的图片发布链路尚未验证；搜索、浏览、详情和互动已支持。' }
          : await publishNote(cookie, { title: body.title, content: body.content, images: body.images || [], tags: body.tags || [], isPrivate: body.visibility === 'private' || !!body.is_private });
        break;
      case 'login': result = { error: 'lite 模式用 cookie 登录，无需扫码。请在设置里粘贴 cookie。' }; break;
      case 'get-qrcode': result = { error: 'lite 模式不支持二维码登录，请粘贴 cookie。' }; break;
      case 'delete-cookies': result = { ok: true }; break;
      case 'publish-video': result = { error: '视频发布暂未在 lite 模式实现。' }; break;
      case 'long-article': result = { error: '长文发布暂未在 lite 模式实现。' }; break;
      default: return null;
    }
    if (result && typeof result === 'object' && !Array.isArray(result)) return { ...result, platform };
    return result;
  }

  return {
    handle,
    __test: {
      RNG,
      signXs,
      signXyw,
      signXsCommon,
      generateB1,
      xRapParam,
      spiderV3: {
        normalizeState: normalizeSpiderV3State,
        signComment: signSpiderV3Comment,
        generateB1: generateSpiderV3B1,
        parseCookies,
        resetDslCache() { spiderV3DslCache = { value: '', expiresAt: 0 }; },
        resetPlatformCache() { platformCache.clear(); },
      },
      _internals: { md5Hex, encodeCustomStr, crc32JsInt, xrapEncryptBlock, xrapXxh32 },
    },
  };
})();

// 供 Node 验证用（Worker 运行时忽略多余的具名导出）。见 worker/xhs-lite/test/verify.mjs
export const __xhsLiteTest = XHSLite.__test;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "*";

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // ========== 小红书 Lite 桥接 (/api/<command>) ==========
    // 与 scripts/xhs-bridge.mjs 契约一致，前端 bridge 模式直接复用。
    const apiMatch = url.pathname.match(/^\/api\/(.+)$/);
    if (apiMatch) {
      const command = apiMatch[1].replace(/\/+$/, '');
      // 探活：前端 testConnection 会先 GET /api/health（不带 cookie），不能要求鉴权
      if (command === 'health') {
        return jsonResponse({ status: 'ok', backend: 'xhs-lite', signing: 'xhshow-pure-js' }, { origin });
      }
      let body = {};
      if (request.method === 'POST') { try { body = await request.json(); } catch (e) { /* allow empty */ } }
      if (
        command === 'xhs-experimental-comments'
        && (
          request.headers.get('x-xhs-experiment-ack') !== 'spider-v3-isolated-cookie'
          || body.acknowledge_risk !== true
        )
      ) {
        return jsonResponse({
          error: 'Spider v3 is an isolated experiment and requires explicit risk acknowledgement.',
          hint: 'Use a disposable test cookie; the normal Lite path never calls this endpoint.',
        }, { status: 403, origin });
      }
      const cookie = request.headers.get('x-xhs-cookie') || body.cookie || (env && env.XHS_COOKIE) || '';
      if (!cookie) return jsonResponse({ error: '未配置 cookie。请在 SullyOS 设置里粘贴小红书 cookie。' }, { status: 401, origin });
      if (!cookie.includes('a1=')) return jsonResponse({ error: 'cookie 缺少 a1 字段，请复制完整的小红书 cookie。' }, { status: 400, origin });
      try {
        const result = await XHSLite.handle(command, body, cookie, env, {
          rnoteApiKey: request.headers.get('x-rnote-api-key') || '',
          platform: request.headers.get('x-xhs-platform') || 'auto',
        });
        if (result === null) return jsonResponse({ error: `Unknown command: ${command}` }, { status: 404, origin });
        const response = jsonResponse(result, { origin });
        if (command === 'xhs-experimental-comments') response.headers.set('Cache-Control', 'no-store');
        return response;
      } catch (e) {
        return jsonResponse({ error: e.message || String(e) }, { status: 500, origin });
      }
    }

    // ========== WebDAV 代理 ==========
    if (url.pathname === '/webdav') {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, { status: 405, origin });
      }
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) {
        return jsonResponse({ error: 'Missing url parameter' }, { status: 400, origin });
      }
      let parsedTarget;
      try {
        parsedTarget = new URL(targetUrl);
        if (parsedTarget.protocol !== 'https:') {
          return jsonResponse({ error: 'Only HTTPS URLs allowed' }, { status: 400, origin });
        }
      } catch {
        return jsonResponse({ error: 'Invalid URL' }, { status: 400, origin });
      }
      const webdavMethod = (request.headers.get('X-WebDAV-Method') || 'GET').toUpperCase();
      const allowedMethods = ['GET', 'PUT', 'PROPFIND', 'MKCOL', 'DELETE'];
      if (!allowedMethods.includes(webdavMethod)) {
        return jsonResponse({ error: 'WebDAV method not allowed' }, { status: 400, origin });
      }
      const forwardHeaders = {};
      const auth = request.headers.get('Authorization');
      if (auth) forwardHeaders['Authorization'] = auth;
      const contentType = request.headers.get('Content-Type');
      if (contentType) forwardHeaders['Content-Type'] = contentType;
      const depth = request.headers.get('X-WebDAV-Depth') || request.headers.get('Depth');
      if (depth) forwardHeaders['Depth'] = depth;
      const range = request.headers.get('X-WebDAV-Range') || request.headers.get('Range');
      if (range) forwardHeaders['Range'] = range;
      forwardHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
      forwardHeaders['Accept'] = '*/*';
      try {
        let body = null;
        if (webdavMethod !== 'GET' && webdavMethod !== 'MKCOL') {
          body = await request.arrayBuffer();
          if (body.byteLength === 0) body = null;
        }
        const upstream = await fetch(targetUrl, {
          method: webdavMethod,
          headers: forwardHeaders,
          body,
        });
        console.log('webdav', webdavMethod, targetUrl, '→', upstream.status);
        const respHeaders = new Headers(corsHeaders(origin));
        const rct = upstream.headers.get('Content-Type');
        if (rct) respHeaders.set('Content-Type', rct);
        // Only forward Content-Length for range responses (size is known and the
        // chunk fully buffers). For full-file 200 streams, omit Content-Length
        // and let chunked transfer-encoding handle it — otherwise a mid-stream
        // disconnect surfaces as ERR_CONTENT_LENGTH_MISMATCH on the client.
        if (upstream.status === 206) {
          const rcl = upstream.headers.get('Content-Length');
          if (rcl) respHeaders.set('Content-Length', rcl);
        }
        const rcr = upstream.headers.get('Content-Range');
        if (rcr) respHeaders.set('Content-Range', rcr);
        const rar = upstream.headers.get('Accept-Ranges');
        if (rar) respHeaders.set('Accept-Ranges', rar);
        respHeaders.set('X-Upstream-Status', String(upstream.status));
        respHeaders.set('X-Upstream-Host', parsedTarget.host);
        respHeaders.set('Access-Control-Expose-Headers', 'X-Upstream-Status, X-Upstream-Host, Content-Length, Content-Range, Accept-Ranges');
        return new Response(upstream.body, {
          status: upstream.status,
          headers: respHeaders,
        });
      } catch (e) {
        return jsonResponse({
          error: `Proxy error: ${String(e && e.message || e)}`,
          stack: String(e && e.stack || '').slice(0, 400),
        }, { status: 502, origin });
      }
    }

    // ========== Cloudflare API 代理 (/cf-api) ==========
    // api.cloudflare.com 一个 CORS 头都不返回，浏览器连最简单的请求都发不出去，所以
    // 「在设置页填一枚 CF token 就把主动消息后端装好」这条路必须过一层中转。
    //
    // 跟 /webdav 的关键区别：目标地址不是调用方给的，是这里拼死的。调用方只能给
    // api.cloudflare.com/client/v4 后面那一截路径，而且限制在账号级资源里——建 D1、
    // 传 worker、加 cron、开 workers.dev 都在 /accounts 下面，够用；/zones/* 那类
    // （改 DNS、签证书）一律挡掉，免得这个端点变成通用的 CF API 中继。
    if (url.pathname === '/cf-api') {
      const CF_ALLOWED_PREFIXES = ['/accounts', '/memberships', '/user/tokens/verify'];
      // 探针：不带任何凭据 GET 一下就知道这条中转在不在。
      // 这个 worker 要手动部署，而它对未知路径的 POST 一律回 405，光看状态码分不出
      // 「部署好了」还是「路由不存在」；GET 这里回 200、旧版本落到末尾的 404，一眼分得开。
      // 前端也拿它判断用户自填的代理 worker 支不支持一键部署。
      if (request.method === 'GET') {
        return jsonResponse({
          ok: true,
          relay: 'cf-api',
          upstream: 'api.cloudflare.com',
          allowed: CF_ALLOWED_PREFIXES,
        }, { origin });
      }
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, { status: 405, origin });
      }
      const apiPath = url.searchParams.get('path') || '';
      if (!apiPath.startsWith('/') || apiPath.includes('://') || apiPath.includes('..')) {
        return jsonResponse({ error: 'Invalid path parameter' }, { status: 400, origin });
      }
      const prefixAllowed = CF_ALLOWED_PREFIXES.some(
        (p) => apiPath === p || apiPath.startsWith(p + '/') || apiPath.startsWith(p + '?')
      );
      if (!prefixAllowed) {
        return jsonResponse({
          error: 'This proxy only relays account-scoped Cloudflare API paths',
          allowed: CF_ALLOWED_PREFIXES,
        }, { status: 403, origin });
      }
      // 真实方法走 header：全局 CORS 只放行 GET/POST/OPTIONS，跟 /webdav 一个套路。
      const cfMethod = (request.headers.get('X-CF-Method') || 'GET').toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(cfMethod)) {
        return jsonResponse({ error: 'CF method not allowed' }, { status: 400, origin });
      }
      const cfTargetUrl = 'https://api.cloudflare.com/client/v4' + apiPath;
      // 拼完再验一次 host。上面的字符串检查已经拦掉了绝对地址，这里是兜底：
      // 只要解析出来不是 api.cloudflare.com 就宁可 400，不往外发。
      let parsedCf;
      try {
        parsedCf = new URL(cfTargetUrl);
      } catch {
        return jsonResponse({ error: 'Invalid path parameter' }, { status: 400, origin });
      }
      if (parsedCf.host !== 'api.cloudflare.com') {
        return jsonResponse({ error: 'Refusing to relay off api.cloudflare.com' }, { status: 400, origin });
      }
      const cfAuth = request.headers.get('Authorization');
      if (!cfAuth) {
        return jsonResponse({ error: 'Missing Authorization header' }, { status: 401, origin });
      }
      // worker.bundle.js 现在 ~500KB，multipart 包一层还要再大些。给到 10MB 够宽裕，
      // 同时别让这个端点变成谁都能拿来传大文件的口子。
      const CF_MAX_BODY = 10 * 1024 * 1024;
      const declaredLen = Number(request.headers.get('Content-Length') || '0');
      if (Number.isFinite(declaredLen) && declaredLen > CF_MAX_BODY) {
        return jsonResponse({ error: 'Request body too large' }, { status: 413, origin });
      }
      const cfHeaders = { Authorization: cfAuth };
      const cfContentType = request.headers.get('Content-Type');
      // multipart 上传要靠 Content-Type 里的 boundary，原样带过去，别自己拼。
      if (cfContentType) cfHeaders['Content-Type'] = cfContentType;
      try {
        let cfBody = null;
        if (cfMethod !== 'GET' && cfMethod !== 'DELETE') {
          cfBody = await request.arrayBuffer();
          if (cfBody.byteLength > CF_MAX_BODY) {
            return jsonResponse({ error: 'Request body too large' }, { status: 413, origin });
          }
          if (cfBody.byteLength === 0) cfBody = null;
        }
        const upstream = await fetch(cfTargetUrl, {
          method: cfMethod,
          headers: cfHeaders,
          body: cfBody,
        });
        // 日志只留方法 / 路径 / 状态码，排障够用。token 在 header 里、不打；
        // query 也不打（pathname 已经把它切掉了）。路径里的账号 id 会留下。
        console.log('cf-api', cfMethod, parsedCf.pathname, '→', upstream.status);
        const respHeaders = new Headers(corsHeaders(origin));
        respHeaders.set('Content-Type', upstream.headers.get('Content-Type') || 'application/json; charset=utf-8');
        // 状态码原样透传，前端能直接分辨 401（token 不对）和 403（权限不够）。
        return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
      } catch (e) {
        return jsonResponse({
          error: `CF proxy error: ${String((e && e.message) || e)}`,
        }, { status: 502, origin });
      }
    }

    // ========== 短链展开 (/expand-url) ==========
    // 逐跳展开；拿到小红书笔记 URL 即返回，避免再访问正文被重定向到验证码页。
    // 前端展开后才能提取，再走小红书 Lite 抓详情。见 utils/webpageExtractor.ts expandShortUrl。
    if (url.pathname === '/expand-url') {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed. Use POST.' }, { status: 405, origin });
      }
      let b = {};
      try { b = await request.json(); } catch (e) { /* allow empty */ }
      const raw = (b && typeof b.url === 'string') ? b.url.trim() : '';
      if (!raw) return jsonResponse({ error: 'Missing url' }, { status: 400, origin });
      let target;
      try { target = new URL(raw); } catch { return jsonResponse({ error: 'Invalid URL' }, { status: 400, origin }); }
      if (isUnsafeFetchTarget(target)) {
        return jsonResponse({ error: '只允许展开公网 http(s) 链接' }, { status: 400, origin });
      }
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 8000);
      try {
        let current = target;
        for (let hop = 0; hop < 10; hop++) {
          if (isUnsafeFetchTarget(current)) throw new Error('重定向目标不是公网 http(s) 链接');
          const host = current.hostname.toLowerCase().replace(/\.$/, '');
          const isNoteHost = ['xiaohongshu.com', 'rednote.com']
            .some(domain => host === domain || host.endsWith(`.${domain}`));
          if (isNoteHost && /^\/(?:discovery\/item|explore|item)\/[a-f0-9]{24}(?:\/|$)/i.test(current.pathname)) {
            return jsonResponse({ success: true, data: { finalUrl: current.toString() } }, { origin });
          }
          const res = await fetch(current.toString(), {
            method: 'GET',
            redirect: 'manual',
            headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
            signal: c.signal,
          });
          // 只需要响应头，不下载短链/正文页面。
          if (res.body) await res.body.cancel();
          const location = res.headers.get('location');
          if ([301, 302, 303, 307, 308].includes(res.status) && location) {
            current = new URL(location, current);
            continue;
          }
          if (!res.ok) throw new Error(`短链服务返回 HTTP ${res.status}`);
          return jsonResponse({ success: true, data: { finalUrl: current.toString() } }, { origin });
        }
        throw new Error('短链重定向次数过多');
      } catch (e) {
        const aborted = e && e.name === 'AbortError';
        return jsonResponse({ error: aborted ? '展开超时' : `展开失败: ${String((e && e.message) || e)}` }, { status: aborted ? 504 : 502, origin });
      } finally {
        clearTimeout(t);
      }
    }

    // ========== 网页分享代理 (/fetch-webpage) ==========
    // 前端把用户粘贴的链接发来，worker 抓回正文（绕过浏览器 CORS），存成 webpage_card 让角色"看见"。
    // 见 utils/webpageExtractor.ts。两段式：
    //   1) Jina Reader (r.jina.ai)：后端渲染 JS/SPA + 正文提取，MSN/微博/知乎这类动态页也能读到正文；
    //   2) 失败/限速时回退裸抓 HTML，前端用 DOMParser 兜底提取。
    // 返回 data.mode 区分：'reader'(干净正文 content) / 'raw'(原始 html)。
    // 可选 env.JINA_API_KEY 提升 Jina 速率（无 key 也能用，走 IP 限速）。SSRF 防护 + 2MB 截断。
    if (url.pathname === '/fetch-webpage') {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed. Use POST.' }, { status: 405, origin });
      }
      let reqBody = {};
      try { reqBody = await request.json(); } catch (e) { /* allow empty */ }
      const rawUrl = (reqBody && typeof reqBody.url === 'string') ? reqBody.url.trim() : '';
      if (!rawUrl) {
        return jsonResponse({ error: 'Missing url' }, { status: 400, origin });
      }
      let target;
      try { target = new URL(rawUrl); } catch {
        return jsonResponse({ error: 'Invalid URL' }, { status: 400, origin });
      }
      if (isUnsafeFetchTarget(target)) {
        return jsonResponse({ error: '只允许抓取公网 http(s) 网页' }, { status: 400, origin });
      }

      // 1) Jina Reader 优先（渲染 + 正文提取）。失败静默回退裸抓，不影响整体。
      {
        const jc = new AbortController();
        const jt = setTimeout(() => jc.abort(), 20000); // 渲染慢，给 20s
        try {
          const jh = { 'Accept': 'application/json', 'X-Return-Format': 'markdown' };
          if (env && env.JINA_API_KEY) jh['Authorization'] = `Bearer ${env.JINA_API_KEY}`;
          const jr = await fetch(`https://r.jina.ai/${target.toString()}`, { method: 'GET', headers: jh, signal: jc.signal });
          if (jr.ok) {
            const jj = await jr.json().catch(() => null);
            const d = jj && jj.data;
            const content = (d && typeof d.content === 'string') ? d.content.trim() : '';
            if (content) {
              console.log('fetch-webpage[jina]', target.toString(), '→', content.length, 'chars');
              return jsonResponse({ success: true, data: { mode: 'reader', title: (d.title || '').trim(), content, finalUrl: d.url || target.toString() } }, { origin });
            }
          }
          console.log('fetch-webpage[jina] miss → raw fallback, status', jr.status);
        } catch (jinaErr) {
          console.log('fetch-webpage[jina] error → raw fallback:', String((jinaErr && jinaErr.message) || jinaErr));
        } finally { clearTimeout(jt); }
      }

      // 2) 裸抓 HTML 兜底
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const upstream = await fetch(target.toString(), {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; SullyOS-WebpageBot/1.0; +https://github.com/sully)',
            'Accept': 'text/html,application/xhtml+xml',
          },
          redirect: 'follow',
          signal: controller.signal,
        });
        if (!upstream.ok) {
          return jsonResponse({ error: `目标站点返回 HTTP ${upstream.status}` }, { status: 502, origin });
        }
        const ct = upstream.headers.get('content-type') || '';
        if (ct && !/text\/html|application\/xhtml\+xml|text\/plain/i.test(ct)) {
          return jsonResponse({ error: `不支持的内容类型: ${ct}` }, { status: 415, origin });
        }
        const html = await readBodyCapped(upstream, 2 * 1024 * 1024);
        console.log('fetch-webpage[raw]', target.toString(), '→', upstream.status, html.length, 'chars');
        return jsonResponse({ success: true, data: { mode: 'raw', html, finalUrl: upstream.url || target.toString(), contentType: ct } }, { origin });
      } catch (e) {
        const aborted = e && e.name === 'AbortError';
        return jsonResponse(
          { error: aborted ? '抓取超时' : `抓取出错: ${String((e && e.message) || e)}` },
          { status: aborted ? 504 : 502, origin }
        );
      } finally {
        clearTimeout(timer);
      }
    }

    // ========== GitHub 代理 ==========
    // 给国内连不上 github.com 的用户兜底用。只放行 api.github.com 和
    // uploads.github.com，方法用 X-GitHub-Method 头携带。
    if (url.pathname === '/github') {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, { status: 405, origin });
      }
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) {
        return jsonResponse({ error: 'Missing url parameter' }, { status: 400, origin });
      }
      let parsedGh;
      try {
        parsedGh = new URL(targetUrl);
      } catch {
        return jsonResponse({ error: 'Invalid URL' }, { status: 400, origin });
      }
      const allowedHosts = new Set(['api.github.com', 'uploads.github.com']);
      if (parsedGh.protocol !== 'https:' || !allowedHosts.has(parsedGh.hostname)) {
        return jsonResponse({ error: 'Host not allowed' }, { status: 400, origin });
      }
      const ghMethod = (request.headers.get('X-GitHub-Method') || 'GET').toUpperCase();
      const ghAllowed = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
      if (!ghAllowed.includes(ghMethod)) {
        return jsonResponse({ error: 'Method not allowed' }, { status: 400, origin });
      }
      const ghHeaders = {};
      const ghAuth = request.headers.get('Authorization');
      if (ghAuth) ghHeaders['Authorization'] = ghAuth;
      const ghCt = request.headers.get('Content-Type');
      if (ghCt) ghHeaders['Content-Type'] = ghCt;
      const ghAccept = request.headers.get('Accept');
      if (ghAccept) ghHeaders['Accept'] = ghAccept;
      const ghApiVer = request.headers.get('X-GitHub-Api-Version');
      if (ghApiVer) ghHeaders['X-GitHub-Api-Version'] = ghApiVer;
      const ghContentLength = request.headers.get('Content-Length');
      if (ghContentLength) ghHeaders['Content-Length'] = ghContentLength;
      // GitHub 拒绝没有 UA 的请求
      ghHeaders['User-Agent'] = 'sully-backup-proxy';
      try {
        // Stream upload bodies to GitHub instead of buffering the whole part
        // inside the 128 MB Worker isolate.
        const ghBody = ghMethod !== 'GET' && ghMethod !== 'DELETE' ? request.body : null;
        const ghUpstream = await fetch(targetUrl, {
          method: ghMethod,
          headers: ghHeaders,
          body: ghBody,
          redirect: 'follow',
        });
        console.log('github', ghMethod, targetUrl, '→', ghUpstream.status);
        const ghRespHeaders = new Headers(corsHeaders(origin));
        const ghForwardedResponseHeaders = [
          'Content-Type', 'Content-Length', 'Content-Range', 'Retry-After',
          'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset',
          'X-RateLimit-Used', 'X-GitHub-Request-Id', 'Link',
        ];
        for (const header of ghForwardedResponseHeaders) {
          const value = ghUpstream.headers.get(header);
          if (value) ghRespHeaders.set(header, value);
        }
        ghRespHeaders.set('Access-Control-Expose-Headers', ghForwardedResponseHeaders.join(', '));
        return new Response(ghUpstream.body, {
          status: ghUpstream.status,
          headers: ghRespHeaders,
        });
      } catch (e) {
        return jsonResponse({
          error: `Proxy error: ${String(e && e.message || e)}`,
          stack: String(e && e.stack || '').slice(0, 400),
        }, { status: 502, origin });
      }
    }

    // ========== Notion 代理 ==========
    if (url.pathname.startsWith('/notion/')) {
      const notionKey = request.headers.get("X-Notion-API-Key");
      if (!notionKey) {
        return jsonResponse({ error: "Missing header: X-Notion-API-Key" }, { status: 401, origin });
      }

      // POST /notion/pages - 创建页面
      if (url.pathname === '/notion/pages' && request.method === 'POST') {
        const body = await request.json();
        const notionRes = await fetch('https://api.notion.com/v1/pages', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${notionKey}`,
            'Notion-Version': '2022-06-28',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        });
        const text = await notionRes.text();
        return new Response(text, {
          status: notionRes.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
        });
      }

      // POST /notion/query - 查询数据库
      if (url.pathname === '/notion/query' && request.method === 'POST') {
        const body = await request.json();
        const dbId = body.database_id;
        if (!dbId) {
          return jsonResponse({ error: "Missing database_id in body" }, { status: 400, origin });
        }
        const notionRes = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${notionKey}`,
            'Notion-Version': '2022-06-28',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            filter: body.filter || undefined,
            sorts: body.sorts || [{ property: 'Date', direction: 'descending' }],
            page_size: body.page_size || 10
          })
        });
        const text = await notionRes.text();
        return new Response(text, {
          status: notionRes.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
        });
      }

      // GET /notion/database/:id - 测试连接
      if (url.pathname.startsWith('/notion/database/') && request.method === 'GET') {
        const dbId = url.pathname.replace('/notion/database/', '');
        const notionRes = await fetch(`https://api.notion.com/v1/databases/${dbId}`, {
          headers: {
            'Authorization': `Bearer ${notionKey}`,
            'Notion-Version': '2022-06-28'
          }
        });
        const text = await notionRes.text();
        return new Response(text, {
          status: notionRes.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
        });
      }

      // GET /notion/blocks/:pageId - 读取页面内容
      if (url.pathname.startsWith('/notion/blocks/') && request.method === 'GET') {
        const pageId = url.pathname.replace('/notion/blocks/', '');
        const notionRes = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`, {
          headers: {
            'Authorization': `Bearer ${notionKey}`,
            'Notion-Version': '2022-06-28'
          }
        });
        const text = await notionRes.text();
        return new Response(text, {
          status: notionRes.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
        });
      }

      return jsonResponse({ error: "Unknown Notion endpoint" }, { status: 404, origin });
    }

    // ========== 飞书代理 ==========
    if (url.pathname.startsWith('/feishu/')) {
      // POST /feishu/token - 获取 tenant_access_token
      if (url.pathname === '/feishu/token' && request.method === 'POST') {
        const body = await request.json();
        if (!body.app_id || !body.app_secret) {
          return jsonResponse({ error: "Missing app_id or app_secret" }, { status: 400, origin });
        }
        const fsRes = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            app_id: body.app_id,
            app_secret: body.app_secret
          })
        });
        const text = await fsRes.text();
        return new Response(text, {
          status: fsRes.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
        });
      }

      // 以下所有 bitable 端点都需要 token
      const feishuToken = request.headers.get("X-Feishu-Token");
      if (!feishuToken) {
        return jsonResponse({ error: "Missing header: X-Feishu-Token" }, { status: 401, origin });
      }
      const feishuHeaders = {
        'Authorization': `Bearer ${feishuToken}`,
        'Content-Type': 'application/json'
      };

      // 解析路径: /feishu/bitable/{appToken}/...
      const bitablePath = url.pathname.replace('/feishu/bitable/', '');
      const segments = bitablePath.split('/');
      if (segments.length < 1 || !segments[0]) {
        return jsonResponse({ error: "Invalid path. Need /feishu/bitable/{appToken}/..." }, { status: 400, origin });
      }

      const appToken = segments[0];
      const rest = segments.slice(1).join('/');

      // GET /feishu/bitable/{appToken}/tables - 列出所有数据表（测试连接）
      if (rest === 'tables' && request.method === 'GET') {
        const fsRes = await fetch(
          `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables`,
          { headers: feishuHeaders }
        );
        const text = await fsRes.text();
        return new Response(text, {
          status: fsRes.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
        });
      }

      // 以下端点需要 tableId
      const tableId = segments[1];
      if (!tableId) {
        return jsonResponse({ error: "Missing tableId in path" }, { status: 400, origin });
      }
      const tableRest = segments.slice(2).join('/');

      // POST /feishu/bitable/{appToken}/{tableId}/records - 创建记录
      if (tableRest === 'records' && request.method === 'POST') {
        const body = await request.json();
        const fsRes = await fetch(
          `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
          {
            method: 'POST',
            headers: feishuHeaders,
            body: JSON.stringify(body)
          }
        );
        const text = await fsRes.text();
        return new Response(text, {
          status: fsRes.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
        });
      }

      // POST /feishu/bitable/{appToken}/{tableId}/records/search - 搜索记录
      if (tableRest === 'records/search' && request.method === 'POST') {
        const body = await request.json();
        const fsRes = await fetch(
          `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records/search`,
          {
            method: 'POST',
            headers: feishuHeaders,
            body: JSON.stringify(body)
          }
        );
        const text = await fsRes.text();
        return new Response(text, {
          status: fsRes.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
        });
      }

      // GET /feishu/bitable/{appToken}/{tableId}/records/{recordId} - 获取单条记录
      if (tableRest.startsWith('records/') && tableRest !== 'records/search' && request.method === 'GET') {
        const recordId = tableRest.replace('records/', '');
        const fsRes = await fetch(
          `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`,
          { headers: feishuHeaders }
        );
        const text = await fsRes.text();
        return new Response(text, {
          status: fsRes.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
        });
      }

      return jsonResponse({ error: "Unknown Feishu endpoint" }, { status: 404, origin });
    }

    // ========== 小红书代理 ==========
    if (url.pathname.startsWith('/xhs/')) {
      const cookie = request.headers.get("X-Xhs-Cookie");
      if (!cookie) {
        return jsonResponse({ error: "Missing header: X-Xhs-Cookie" }, { status: 401, origin });
      }

      // GET /xhs/debug - 测试签名，返回完整原始响应
      if (url.pathname === '/xhs/debug' && request.method === 'GET') {
        try {
          const testApi = url.searchParams.get('api') || '/api/sns/web/v1/user/selfinfo';
          const a1 = getCookieValue(cookie, 'a1');
          const { xs, xt } = signXs('GET', testApi, a1);
          const result = await xhsFetch(cookie, testApi, 'GET');
          return jsonResponse({
            debug: true,
            api: testApi,
            a1_len: a1.length,
            xs_prefix: xs.slice(0, 20),
            xt,
            response_status: result.status,
            response_ok: result.ok,
            response_data: result.data
          }, { origin });
        } catch (e) {
          return jsonResponse({ debug: true, error: e.message }, { status: 500, origin });
        }
      }

      // GET /xhs/upload-test - 测试图片上传凭证获取（诊断用）
      if (url.pathname === '/xhs/upload-test' && request.method === 'GET') {
        try {
          const credResult = await getUploadCredentials(cookie);
          const permitRoot = credResult.data?.data || credResult.data;
          const tempPermit = permitRoot?.uploadTempPermits?.[0];

          if (tempPermit?.fileIds?.[0] && tempPermit?.token) {
            return jsonResponse({
              success: true,
              message: '上传凭证获取成功',
              file_id: tempPermit.fileIds[0],
              token_prefix: tempPermit.token.slice(0, 30) + '...',
              debug: credResult.debug
            }, { origin });
          }

          return jsonResponse({
            success: false,
            message: '上传凭证获取失败',
            debug: credResult.debug
          }, { origin });
        } catch (e) {
          return jsonResponse({ success: false, message: `上传测试异常: ${e.message}` }, { status: 500, origin });
        }
      }

      // GET /xhs/profile - 测试 Cookie，获取用户信息
      if (url.pathname === '/xhs/profile' && request.method === 'GET') {
        try {
          const api = '/api/sns/web/v1/user/selfinfo';
          const result = await xhsFetch(cookie, api, 'GET');
          const rd = result.data || {};

          // XHS selfinfo 结构: rd.data.basic_info.nickname
          const basicInfo = rd.data?.basic_info || {};
          const nickname = basicInfo.nickname || basicInfo.nick_name || basicInfo.red_id || '';

          if (nickname) {
            return jsonResponse({
              success: true,
              nickname,
              userid: basicInfo.red_id || '',
              avatar: basicInfo.imageb || basicInfo.images || ''
            }, { origin });
          }

          // basic_info 没有但请求本身成功
          if (rd.success || rd.code === 0) {
            return jsonResponse({
              success: true,
              nickname: '已连接',
              _raw: JSON.stringify(rd).slice(0, 600)
            }, { origin });
          }

          // 返回详细错误信息方便调试（含完整原始响应）
          return jsonResponse({
            success: false,
            message: result.data?.msg || 'Cookie 无效或已过期',
            raw_status: result.status,
            debug: {
              code: result.data?.code,
              msg: result.data?.msg,
              raw: JSON.stringify(result.data).slice(0, 500),
              data_keys: result.data?.data ? Object.keys(result.data.data).join(',') : 'NO_DATA',
              full_response_keys: Object.keys(result.data || {}).join(',')
            }
          }, { status: 200, origin });
        } catch (e) {
          return jsonResponse({ success: false, message: `请求失败: ${e.message}` }, { status: 500, origin });
        }
      }

      // GET /xhs/note/:noteId - 获取单条笔记详情
      const noteMatch = url.pathname.match(/^\/xhs\/note\/([a-f0-9]+)$/);
      if (noteMatch && request.method === 'GET') {
        const noteId = noteMatch[1];
        try {
          const api = '/api/sns/web/v1/feed';
          const body = { source_note_id: noteId, image_formats: ['jpg', 'webp'], extra: { need_body_topic: 1 } };
          const result = await xhsFetch(cookie, api, 'POST', body);
          const rd = result.data || {};

          if (rd.data?.items?.[0]?.note_card) {
            const card = rd.data.items[0].note_card;
            const user = card.user || {};
            const interactInfo = card.interact_info || {};
            return jsonResponse({
              success: true,
              note: {
                note_id: noteId,
                title: card.title || card.display_title || '',
                desc: card.desc || '',
                liked_count: parseInt(interactInfo.liked_count || '0') || 0,
                nickname: user.nickname || user.nick_name || '',
                user_id: user.user_id || ''
              }
            }, { origin });
          }

          // Fallback: try HTML scraping
          try {
            const htmlRes = await fetch(`https://www.xiaohongshu.com/explore/${noteId}`, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Cookie': cookie,
                'Accept': 'text/html,application/xhtml+xml',
              }
            });
            const html = await htmlRes.text();
            const stateMatch = html.match(/__INITIAL_STATE__\s*=\s*({[\s\S]*?})\s*<\/script>/);
            if (stateMatch) {
              const stateStr = stateMatch[1].replace(/undefined/g, 'null');
              const state = JSON.parse(stateStr);
              const noteData = state.note?.noteDetailMap?.[noteId]?.note || state.note?.note;
              if (noteData) {
                return jsonResponse({
                  success: true,
                  note: {
                    note_id: noteId,
                    title: noteData.title || '',
                    desc: noteData.desc || '',
                    liked_count: parseInt(noteData.interactInfo?.likedCount || '0') || 0,
                    nickname: noteData.user?.nickname || '',
                    user_id: noteData.user?.userId || ''
                  }
                }, { origin });
              }
            }
          } catch (htmlErr) {
            console.log('HTML scrape fallback failed:', htmlErr.message);
          }

          return jsonResponse({
            success: false,
            message: '笔记不存在或无法访问',
            debug: { api_code: rd.code, api_msg: rd.msg }
          }, { status: 200, origin });
        } catch (e) {
          return jsonResponse({ success: false, message: `获取笔记失败: ${e.message}` }, { status: 500, origin });
        }
      }

      // POST /xhs/search - 搜索笔记（API + HTML 双重回退）
      if (url.pathname === '/xhs/search' && request.method === 'POST') {
        try {
          const body = await request.json();
          const keyword = body.keyword;
          if (!keyword) {
            return jsonResponse({ success: false, message: '缺少 keyword' }, { status: 400, origin });
          }

          // ---------- search_id: 匹配 ReaJason/xhs 格式 (base36 编码) ----------
          function getSearchId() {
            const ts = BigInt(Date.now()) << 64n;
            const rand = BigInt(Math.floor(Math.random() * 2147483646));
            const combined = ts + rand;
            const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
            let n = combined, s = '';
            while (n > 0n) { s = chars[Number(n % 36n)] + s; n = n / 36n; }
            return s || '0';
          }

          // ---------- 策略 1: API 搜索（带 host/origin 回退） ----------
          const api = '/api/sns/web/v1/search/notes';
          const searchBody = {
            keyword: keyword,
            page: body.page || 1,
            page_size: 20,
            search_id: getSearchId(),
            sort: body.sort || 'general',
            note_type: 0
          };

          // 真实浏览器搜索时 Referer 指向搜索结果页
          const searchReferer = 'https://www.xiaohongshu.com/search_result/' + encodeURIComponent(keyword);
          const apiAttempts = [
            { baseUrl: 'https://edith.xiaohongshu.com', origin: 'https://www.xiaohongshu.com', referer: searchReferer },
            { baseUrl: 'https://edith.xiaohongshu.com', origin: 'https://www.xiaohongshu.com', referer: 'https://www.xiaohongshu.com/' },
          ];

          const apiDebug = [];
          for (const attempt of apiAttempts) {
            const result = await xhsFetch(cookie, api, 'POST', searchBody, attempt);
            apiDebug.push({ host: attempt.baseUrl, referer: attempt.referer, status: result.status, code: result.data?.code, msg: result.data?.msg || '' });

            const items = result.data?.data?.items || [];
            if (items.length > 0) {
              const notes = items.map(item => {
                const note = item.note_card || item;
                return {
                  note_id: note.note_id || item.id || '',
                  title: note.display_title || note.title || '',
                  desc: (note.desc || '').slice(0, 200),
                  liked_count: note.interact_info?.liked_count || note.liked_count || 0,
                  nickname: note.user?.nickname || note.user?.nick_name || '',
                  user_id: note.user?.user_id || ''
                };
              }).filter(n => n.note_id);

              if (notes.length > 0) {
                return jsonResponse({ success: true, notes, source: 'api' }, { origin });
              }
            }

            // 如果不是 461/471 这类签名/风控错误，不再尝试其他 host
            if (result.status !== 461 && result.status !== 471 && result.status < 500) break;
          }

          // ---------- 策略 2: HTML 页面抓取（绕过签名校验） ----------
          const searchUrl = 'https://www.xiaohongshu.com/search_result?keyword=' + encodeURIComponent(keyword) + '&source=web_search_result_note';
          const htmlRes = await fetch(searchUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
              'Cookie': cookie,
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
              'Sec-Fetch-Dest': 'document',
              'Sec-Fetch-Mode': 'navigate',
              'Sec-Fetch-Site': 'none',
            },
            redirect: 'follow'
          });

          const html = await htmlRes.text();
          const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{.+?\})\s*<\/script>/s);
          if (stateMatch) {
            const stateStr = stateMatch[1].replace(/\bundefined\b/g, 'null');
            let state;
            try { state = JSON.parse(stateStr); } catch { state = null; }

            if (state) {
              // 搜索结果可能在各种路径 — 穷举已知 + 自动发现
              let items = [];
              let itemSource = 'unknown';
              const candidates = [
                ['search.notes', state?.search?.notes],
                ['search.items', state?.search?.items],
                ['search.feeds', state?.search?.feeds],
                ['search.noteList', state?.search?.noteList],
                ['search.result', state?.search?.result],
                ['search.results', state?.search?.results],
                ['search.notesResult', state?.search?.notesResult],
                ['search_result.notes', state?.search_result?.notes],
                ['search_result.items', state?.search_result?.items],
                ['note.noteList', state?.note?.noteList],
                ['feed.feeds', state?.feed?.feeds],
              ];
              for (const [name, arr] of candidates) {
                if (Array.isArray(arr) && arr.length > 0) {
                  items = arr;
                  itemSource = name;
                  break;
                }
              }

              // 智能递归: 只接受包含类似笔记对象的数组 (有 id/note_id/noteId 或 note_card/noteCard)
              if (items.length === 0) {
                const looksLikeNote = (obj) => {
                  if (!obj || typeof obj !== 'object') return false;
                  const k = Object.keys(obj);
                  return k.some(key => /^(id|note_id|noteId|model_type|note_card|noteCard|display_title|displayTitle)$/.test(key));
                };
                const findNoteArray = (obj, path = '', depth = 0) => {
                  if (depth > 5 || !obj || typeof obj !== 'object') return null;
                  if (Array.isArray(obj) && obj.length > 2 && looksLikeNote(obj[0])) {
                    return { arr: obj, path };
                  }
                  for (const key of Object.keys(obj)) {
                    const r = findNoteArray(obj[key], path ? `${path}.${key}` : key, depth + 1);
                    if (r) return r;
                  }
                  return null;
                };
                const found = findNoteArray(state);
                if (found) { items = found.arr; itemSource = found.path + '(auto)'; }
              }

              // 尝试提取笔记（兼容 snake_case + camelCase）
              const extractNote = (item) => {
                const note = item.note_card || item.noteCard || item;
                return {
                  note_id: note?.note_id || note?.noteId || note?.id || item?.id || '',
                  title: note?.display_title || note?.displayTitle || note?.title || '',
                  desc: (note?.desc || note?.description || '').slice(0, 200),
                  liked_count: note?.interact_info?.liked_count || note?.interactInfo?.likedCount || note?.liked_count || 0,
                  nickname: note?.user?.nickname || note?.user?.nick_name || note?.user?.nickName || '',
                  user_id: note?.user?.user_id || note?.user?.userId || ''
                };
              };
              const notes = items.map(extractNote).filter(n => n.note_id);

              if (notes.length > 0) {
                return jsonResponse({ success: true, notes, source: 'html_scrape', _debug: { itemSource, apiAttempts: apiDebug } }, { origin });
              }

              // HTML 有数据但映射失败 → 返回详细样本帮助调试
              if (items.length > 0) {
                return jsonResponse({
                  success: false, notes: [],
                  message: `HTML解析到 ${items.length} 条但字段映射失败`,
                  debug: { itemSource, first_keys: items[0] ? Object.keys(items[0]) : [], sample: items.slice(0, 2).map(i => JSON.stringify(i).slice(0, 600)), apiAttempts: apiDebug }
                }, { origin });
              }

              // state 解析成功但没找到笔记列表 → 专门 dump search 对象
              const searchObj = state?.search || {};
              const searchDump = {};
              for (const [k, v] of Object.entries(searchObj)) {
                if (Array.isArray(v)) {
                  searchDump[k] = { type: 'array', len: v.length, first_keys: v[0] && typeof v[0] === 'object' ? Object.keys(v[0]) : typeof v[0], sample: JSON.stringify(v[0]).slice(0, 300) };
                } else if (v && typeof v === 'object') {
                  searchDump[k] = { type: 'object', keys: Object.keys(v) };
                } else {
                  searchDump[k] = { type: typeof v, value: String(v).slice(0, 100) };
                }
              }
              return jsonResponse({
                success: false, notes: [],
                message: '搜索页 __INITIAL_STATE__ 无笔记列表',
                debug: { search_structure: searchDump, state_keys: Object.keys(state), apiAttempts: apiDebug }
              }, { origin });
            }
          }

          // 两条路都没走通
          return jsonResponse({
            success: false, notes: [],
            message: `搜索失败 (API 和 HTML 均未获取到结果)`,
            debug: { apiAttempts: apiDebug, html_status: htmlRes.status, html_len: html.length, html_snippet: html.slice(0, 500) }
          }, { origin });
        } catch (e) {
          return jsonResponse({ success: false, notes: [], message: `搜索异常: ${e.message}` }, { status: 500, origin });
        }
      }

      // POST /xhs/feed - 浏览小红书 (scrape explore page via GET, avoids POST 461)
      if (url.pathname === '/xhs/feed' && request.method === 'POST') {
        try {
          // 策略: GET explore 页面，解析 __INITIAL_STATE__ 里的笔记
          const exploreRes = await fetch('https://www.xiaohongshu.com/explore', {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
              'Cookie': cookie,
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
              'Sec-Fetch-Dest': 'document',
              'Sec-Fetch-Mode': 'navigate',
              'Sec-Fetch-Site': 'none',
            },
            redirect: 'follow'
          });

          const html = await exploreRes.text();

          // 解析 window.__INITIAL_STATE__ JSON
          const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{.+?\})\s*<\/script>/s);
          if (stateMatch) {
            // XHS 用 undefined 代替 null，替换后才能 JSON.parse
            const stateStr = stateMatch[1].replace(/\bundefined\b/g, 'null');
            let state;
            try { state = JSON.parse(stateStr); } catch { state = null; }

            if (state) {
              // 查找笔记列表：尝试多种已知路径
              let feeds = [];
              let feedSource = 'unknown';
              const candidates = [
                ['feed.feeds', state?.feed?.feeds],
                ['explore.feeds', state?.explore?.feeds],
                ['homeFeed.feeds', state?.homeFeed?.feeds],
                ['explore.noteList', state?.explore?.noteList],
                ['feed.noteList', state?.feed?.noteList],
              ];
              for (const [name, arr] of candidates) {
                if (Array.isArray(arr) && arr.length > 0) {
                  feeds = arr;
                  feedSource = name;
                  break;
                }
              }

              // 如果标准路径都没命中，递归找第一个长度 > 5 的数组
              if (feeds.length === 0) {
                const findLargeArray = (obj, path = '', depth = 0) => {
                  if (depth > 3 || !obj || typeof obj !== 'object') return null;
                  if (Array.isArray(obj) && obj.length > 5) return { arr: obj, path };
                  for (const key of Object.keys(obj)) {
                    const result = findLargeArray(obj[key], path ? `${path}.${key}` : key, depth + 1);
                    if (result) return result;
                  }
                  return null;
                };
                const found = findLargeArray(state);
                if (found) {
                  feeds = found.arr;
                  feedSource = found.path + '(auto)';
                }
              }

              // 自适应字段映射：检查第一个 item 的实际结构
              const notes = feeds.map(item => {
                // 笔记可能嵌套在 note_card / noteCard / model_type 下
                const note = item.note_card || item.noteCard || item;
                return {
                  note_id: note?.note_id || note?.noteId || note?.id || item?.id || '',
                  title: note?.display_title || note?.displayTitle || note?.title || note?.name || '',
                  desc: (note?.desc || note?.description || note?.content || '').slice(0, 200),
                  liked_count: note?.interact_info?.liked_count || note?.interactInfo?.likedCount || note?.liked_count || note?.likeCount || 0,
                  nickname: note?.user?.nickname || note?.user?.nickName || note?.user?.nick_name || note?.author || '',
                  user_id: note?.user?.user_id || note?.user?.userId || ''
                };
              }).filter(n => n.note_id);

              // 包含原始样本用于诊断空字段问题
              const rawSample = feeds.slice(0, 2).map(item => JSON.stringify(item).slice(0, 500));

              if (notes.length > 0) {
                return jsonResponse({
                  success: true, notes, source: 'explore_page',
                  _debug: { feedSource, total: feeds.length, sample: rawSample }
                }, { origin });
              }

              // 有 feeds 数组但映射后全空
              if (feeds.length > 0) {
                return jsonResponse({
                  success: false, notes: [],
                  message: `找到 ${feeds.length} 条数据但字段映射失败`,
                  debug: {
                    feedSource,
                    first_item_keys: feeds[0] ? Object.keys(feeds[0]).join(',') : 'empty',
                    sample: rawSample
                  }
                }, { origin });
              }
            }

            // state 解析成功但没有笔记 → 返回 state keys 帮助调试
            return jsonResponse({
              success: false, notes: [],
              message: `Explore页面解析成功但未找到笔记`,
              debug: {
                status: exploreRes.status,
                state_keys: state ? Object.keys(state).join(',') : 'parse_failed',
                state_sample: state ? JSON.stringify(state).slice(0, 800) : ''
              }
            }, { origin });
          }

          // 没匹配到 __INITIAL_STATE__，返回 HTML 片段帮助调试
          return jsonResponse({
            success: false, notes: [],
            message: `Explore页面无 __INITIAL_STATE__ (${exploreRes.status})`,
            debug: {
              status: exploreRes.status,
              html_len: html.length,
              html_snippet: html.slice(0, 500)
            }
          }, { origin });
        } catch (e) {
          return jsonResponse({ success: false, notes: [], message: `浏览异常: ${e.message}` }, { status: 500, origin });
        }
      }

      // POST /xhs/publish - 发布笔记
      // 需要 image_url (外部图片URL) 或 images (已上传的file_id数组)
      if (url.pathname === '/xhs/publish' && request.method === 'POST') {
        try {
          const body = await request.json();
          if (!body.title || !body.content) {
            return jsonResponse({ success: false, message: '缺少 title 或 content' }, { status: 400, origin });
          }

          const rawImages = Array.isArray(body.images) ? body.images : [];
          let images = rawImages.map((img) => {
            if (typeof img === 'string') {
              return {
                file_id: img,
                metadata: { source: -1 },
                stickers: { version: 2, floating: [] },
                extra_info_json: '{"mimeType":"image/jpeg"}'
              };
            }
            return img;
          }).filter(img => img?.file_id);

          const steps = []; // 详细的分步 debug
          const uploadDiagnostics = [];

          // Step 1: 如果提供了 image_url，先下载图片再上传到 XHS
          if (images.length === 0 && body.image_url) {
            const uploadResult = await uploadImageToXhs(cookie, body.image_url);
            if (uploadResult.file_id) {
              images = [{
                file_id: uploadResult.file_id,
                metadata: { source: -1 },
                stickers: { version: 2, floating: [] },
                extra_info_json: '{"mimeType":"image/jpeg"}'
              }];
              steps.push('image_url上传成功: ' + uploadResult.file_id);
            } else {
              steps.push('image_url上传失败: ' + uploadResult.error);
              uploadDiagnostics.push({ stage: 'image_url', ...uploadResult });
            }
          }

          // Step 2: 无论如何都尝试占位图兜底（小红书要求至少一张图片）
          if (images.length === 0) {
            steps.push('尝试上传占位图...');
            const placeholderResult = await uploadPlaceholderImage(cookie);
            if (placeholderResult.file_id) {
              images = [{
                file_id: placeholderResult.file_id,
                metadata: { source: -1 },
                stickers: { version: 2, floating: [] },
                extra_info_json: '{"mimeType":"image/png"}'
              }];
              steps.push('占位图上传成功: ' + placeholderResult.file_id);
            } else {
              steps.push('占位图上传失败: ' + placeholderResult.error);
              uploadDiagnostics.push({ stage: 'placeholder', ...placeholderResult });
            }
          }

          // Step 3: 小红书不支持纯文字笔记，必须有至少一张图片
          if (images.length === 0) {
            return jsonResponse({
              success: false,
              message: '图片上传失败，无法发布笔记。小红书要求每篇笔记至少包含一张图片。请检查上传凭证接口 (GET /xhs/upload-test) 或提供有效的 image_url。',
              debug: { steps, upload_diagnostics: uploadDiagnostics }
            }, { origin });
          }

          // Step 4: 构建发布 body（格式对齐 ReaJason/xhs 库）
          const api = '/web_api/sns/v2/note';
          const commonFields = {
            type: 'normal',
            title: body.title,
            note_id: '',
            desc: body.content,
            source: '{"type":"web","ids":"","extraInfo":"{\\"subType\\":\\"official\\"}"}',
            business_binds: '{"version":1,"noteId":0,"noteOrderBind":{},"notePostTiming":{"postTime":null},"noteCollectionBind":{"id":""}}',
            ats: [],
            hash_tag: (body.tags || []).map(t => ({ id: '', name: t, link: '', type: 'topic' })),
            post_loc: {},
            privacy_info: { op_type: 1, type: 0 },
          };

          const publishBody = { common: commonFields, image_info: { images }, video_info: null };
          steps.push('发布body已构建(有图), images=' + images.length + ', file_id=' + images[0]?.file_id);

          // 发布请求使用 creator.xiaohongshu.com 作为 Origin/Referer（匹配真实浏览器行为）
          const publishOriginOpts = {
            origin: 'https://creator.xiaohongshu.com',
            referer: 'https://creator.xiaohongshu.com/',
          };
          let result = await xhsFetch(cookie, api, 'POST', publishBody, publishOriginOpts);
          const publishHostAttempts = [{
            baseUrl: XHS_BASE,
            origin: publishOriginOpts.origin,
            status: result.status,
            ok: result.ok,
            result: result.data?.result,
            code: result.data?.code,
            msg: result.data?.msg || ''
          }];

          // 如果命中常见风控/网关拦截错误，尝试切换发布 host 再试一次
          const needPublishHostFallback = images.length > 0
            && !result.data?.data?.note_id
            && [-9150, -9110].includes(Number(result.data?.result));
          if (needPublishHostFallback) {
            for (const host of XHS_PUBLISH_HOST_CANDIDATES) {
              if (host === XHS_BASE) continue;
              const retry = await xhsFetch(cookie, api, 'POST', publishBody, { baseUrl: host, ...publishOriginOpts });
              publishHostAttempts.push({
                baseUrl: host,
                origin: publishOriginOpts.origin,
                status: retry.status,
                ok: retry.ok,
                result: retry.data?.result,
                code: retry.data?.code,
                msg: retry.data?.msg || ''
              });
              if (retry.data?.data?.note_id || retry.data?.data?.id) {
                result = retry;
                steps.push('发布host回退成功: ' + host);
                break;
              }
              if (![-9150, -9110].includes(Number(retry.data?.result))) {
                result = retry;
                break;
              }
              result = retry;
            }
          }

          // 严格检查：必须有 note_id 才算真正发布成功
          const noteId = result.data?.data?.note_id || result.data?.data?.id || '';
          if (noteId) {
            return jsonResponse({
              success: true,
              note_id: noteId,
              message: '发布成功'
            }, { origin });
          }

          const resultCode = result.data?.result || result.data?.code;
          const rawText = typeof result.data?.raw === 'string' ? result.data.raw : '';
          const hadImages = images.length > 0;
          let failMessage = result.data?.msg || `发布失败 (${result.status})`;

          if (resultCode === -9150) {
            failMessage = '发布被拒(-9150)：疑似风控/技术升级拦截。可能原因：签名被检测、发布频率过高、账号异常。建议降低频率或更换 Cookie 后重试。';
          } else if (result.status >= 500 && /jarvis-gateway-default/i.test(rawText)) {
            failMessage = '小红书网关暂时不可用（jarvis-gateway-default）。这不是请求体字段错误，建议稍后重试。';
          }

          return jsonResponse({
            success: false,
            message: failMessage,
            debug: {
              steps,
              status: result.status,
              result_code: resultCode,
              had_images: hadImages,
              upload_diagnostics: uploadDiagnostics,
              publish_host_attempts: publishHostAttempts,
              raw: JSON.stringify(result.data).slice(0, 500)
            }
          }, { origin });
        } catch (e) {
          return jsonResponse({ success: false, message: `发布异常: ${e.message}` }, { status: 500, origin });
        }
      }

      // POST /xhs/comment - 评论笔记
      if (url.pathname === '/xhs/comment' && request.method === 'POST') {
        try {
          const body = await request.json();
          if (!body.note_id || !body.content) {
            return jsonResponse({ success: false, message: '缺少 note_id 或 content' }, { status: 400, origin });
          }

          const api = '/api/sns/web/v1/comment/post';
          const commentBody = {
            note_id: body.note_id,
            content: body.content,
            at_users: []
          };

          const result = await xhsFetch(cookie, api, 'POST', commentBody);

          // XHS 可能返回非2xx但body里success=true，以body为准
          if (result.data?.success || result.data?.code === 0 || result.data?.data?.comment) {
            return jsonResponse({ success: true, message: '评论成功' }, { origin });
          }

          return jsonResponse({
            success: false,
            message: result.data?.msg || `评论失败 (${result.status})`,
            debug: { status: result.status, raw: JSON.stringify(result.data).slice(0, 300) }
          }, { origin });
        } catch (e) {
          return jsonResponse({ success: false, message: `评论异常: ${e.message}` }, { status: 500, origin });
        }
      }

      return jsonResponse({ error: "Unknown XHS endpoint. Use /xhs/profile, /xhs/upload-test, /xhs/search, /xhs/feed, /xhs/publish, /xhs/comment" }, { status: 404, origin });
    }

    // ========== Replicate 代理 (写歌 App 用，给 ACE-Step 等模型走) ==========
    // 前端把 Authorization: Bearer r8_xxx 透传过来，Worker 只做路由 + CORS + CDN 兜底。
    //   POST /replicate/predictions          → 起任务 (透传 body 到 api.replicate.com)
    //   GET  /replicate/predictions/:id      → 轮询状态
    //   POST /replicate/predictions/:id/cancel → 取消任务
    //   GET  /replicate/file?url=...         → 下载 replicate.delivery 上的产物 (国内常超时)
    if (url.pathname.startsWith('/replicate/')) {
      // 1) 文件代下载：解决 replicate.delivery / pbxt.replicate.delivery 的国内访问问题
      if (url.pathname === '/replicate/file' && request.method === 'GET') {
        const targetUrl = url.searchParams.get('url');
        if (!targetUrl) {
          return jsonResponse({ error: 'Missing url parameter' }, { status: 400, origin });
        }
        let parsed;
        try {
          parsed = new URL(targetUrl);
        } catch {
          return jsonResponse({ error: 'Invalid URL' }, { status: 400, origin });
        }
        // 白名单：只放行 replicate 的产物 CDN
        const allowed = (host) => host === 'replicate.delivery'
          || host.endsWith('.replicate.delivery')
          || host === 'pbxt.replicate.com'
          || host.endsWith('.replicate.com');
        if (parsed.protocol !== 'https:' || !allowed(parsed.hostname)) {
          return jsonResponse({ error: 'Host not allowed' }, { status: 400, origin });
        }
        try {
          const upstream = await fetch(targetUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 sully-replicate-proxy',
              'Accept': '*/*',
            },
          });
          const respHeaders = new Headers(corsHeaders(origin));
          const ct = upstream.headers.get('Content-Type');
          if (ct) respHeaders.set('Content-Type', ct);
          const cl = upstream.headers.get('Content-Length');
          if (cl) respHeaders.set('Content-Length', cl);
          respHeaders.set('Access-Control-Expose-Headers', 'Content-Length, Content-Type');
          return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
        } catch (e) {
          return jsonResponse({ error: 'Replicate CDN fetch failed', detail: String(e && e.message || e) }, { status: 502, origin });
        }
      }

      // 2) API 转发：除 /file 外的所有路径，剥掉 /replicate 前缀转给 api.replicate.com
      const auth = request.headers.get('Authorization');
      if (!auth) {
        return jsonResponse({ error: 'Missing Authorization header (Replicate token)' }, { status: 401, origin });
      }
      const apiPath = url.pathname.replace(/^\/replicate/, ''); // e.g. /predictions
      const apiUrl = `https://api.replicate.com/v1${apiPath}${url.search || ''}`;
      const allowedMethods = ['GET', 'POST', 'DELETE'];
      if (!allowedMethods.includes(request.method)) {
        return jsonResponse({ error: 'Method not allowed' }, { status: 405, origin });
      }
      try {
        const forwardHeaders = {
          'Authorization': auth,
          'Content-Type': request.headers.get('Content-Type') || 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'sully-replicate-proxy',
        };
        const init = { method: request.method, headers: forwardHeaders };
        if (request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH') {
          init.body = await request.text();
        }
        const upstream = await fetch(apiUrl, init);
        const text = await upstream.text();
        return new Response(text, {
          status: upstream.status,
          headers: {
            'Content-Type': upstream.headers.get('Content-Type') || 'application/json; charset=utf-8',
            ...corsHeaders(origin),
          },
        });
      } catch (e) {
        return jsonResponse({ error: 'Replicate upstream fetch failed', detail: String(e && e.message || e) }, { status: 502, origin });
      }
    }

    // ========== 鱼声 Fish Audio TTS 代理 (静态部署绕 CORS, 纯透传) ==========
    // 前端 POST /fishaudio/tts?model=s2.1-pro  + Authorization: Bearer <fish key>
    // body = { text, reference_id, format, ... }；返回二进制音频(mp3)。
    // model 走 query：避免自定义 'model' header 触发 CORS 预检失败。
    // Worker 不读不存 key，只做 CORS + 转发 https://api.fish.audio/v1/tts。
    if (url.pathname === '/fishaudio/tts') {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, { status: 405, origin });
      }
      const auth = request.headers.get('Authorization');
      if (!auth) {
        return jsonResponse({ error: 'Missing Authorization header (Fish API key)' }, { status: 401, origin });
      }
      const model = (url.searchParams.get('model') || 's2.1-pro').trim();
      try {
        const upstream = await fetch('https://api.fish.audio/v1/tts', {
          method: 'POST',
          headers: {
            'Authorization': auth,
            'Content-Type': request.headers.get('Content-Type') || 'application/json',
            'model': model,
          },
          body: await request.text(),
        });
        const respHeaders = new Headers(corsHeaders(origin));
        respHeaders.set('Content-Type', upstream.headers.get('Content-Type') || 'audio/mpeg');
        respHeaders.set('Access-Control-Expose-Headers', 'Content-Length, Content-Type');
        return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
      } catch (e) {
        return jsonResponse({ error: 'Fish Audio upstream fetch failed', detail: String(e && e.message || e) }, { status: 502, origin });
      }
    }

    // ========== MiniMax STT 代理（静态部署绕 CORS，纯透传 multipart/form-data）==========
    if (url.pathname === '/minimax/stt') {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, { status: 405, origin });
      }
      const auth = request.headers.get('Authorization');
      if (!auth) {
        return jsonResponse({ error: 'Missing Authorization header (MiniMax API key)' }, { status: 401, origin });
      }
      const region = (request.headers.get('X-MiniMax-Region') || url.searchParams.get('region') || '').trim().toLowerCase();
      const base = region === 'overseas' ? 'https://api.minimax.io' : 'https://api.minimaxi.com';
      const lang = (request.headers.get('language') || url.searchParams.get('language') || '').trim();
      const contentType = request.headers.get('Content-Type') || '';
      try {
        const fwdHeaders = {
          'Authorization': auth,
          ...(contentType ? { 'Content-Type': contentType } : {}),
          ...(lang ? { 'language': lang } : {}),
        };
        const upstream = await fetch(`${base}/v1/speech_to_text`, {
          method: 'POST',
          headers: fwdHeaders,
          body: await request.arrayBuffer(),
        });
        const text = await upstream.text();
        return new Response(text, {
          status: upstream.status,
          headers: {
            'Content-Type': upstream.headers.get('Content-Type') || 'application/json; charset=utf-8',
            ...corsHeaders(origin),
          },
        });
      } catch (e) {
        return jsonResponse({ error: 'MiniMax STT upstream fetch failed', detail: String(e && e.message || e) }, { status: 502, origin });
      }
    }

    // ========== 鱼声 Fish Audio STT 代理（静态部署绕 CORS，纯透传 multipart/form-data）==========
    if (url.pathname === '/fishaudio/stt') {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, { status: 405, origin });
      }
      const auth = request.headers.get('Authorization');
      if (!auth) {
        return jsonResponse({ error: 'Missing Authorization header (Fish API key)' }, { status: 401, origin });
      }
      const model = (url.searchParams.get('model') || request.headers.get('model') || 'transcribe-1-pro').trim();
      const contentType = request.headers.get('Content-Type') || '';
      try {
        const upstream = await fetch('https://api.fish.audio/v1/asr', {
          method: 'POST',
          headers: {
            'Authorization': auth,
            'model': model,
            ...(contentType ? { 'Content-Type': contentType } : {}),
          },
          body: await request.arrayBuffer(),
        });
        const text = await upstream.text();
        return new Response(text, {
          status: upstream.status,
          headers: {
            'Content-Type': upstream.headers.get('Content-Type') || 'application/json; charset=utf-8',
            ...corsHeaders(origin),
          },
        });
      } catch (e) {
        return jsonResponse({ error: 'Fish Audio STT upstream fetch failed', detail: String(e && e.message || e) }, { status: 502, origin });
      }
    }

    // ========== ElevenLabs STT 代理（静态部署绕 CORS，纯透传 multipart/form-data）==========
    if (url.pathname === '/elevenlabs/stt') {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, { status: 405, origin });
      }
      const apiKey = (request.headers.get('xi-api-key') || '').trim();
      if (!apiKey) {
        return jsonResponse({ error: 'Missing xi-api-key header (ElevenLabs API key)' }, { status: 401, origin });
      }
      const contentType = request.headers.get('Content-Type') || '';
      try {
        const upstream = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
          method: 'POST',
          headers: {
            'xi-api-key': apiKey,
            ...(contentType ? { 'Content-Type': contentType } : {}),
          },
          body: await request.arrayBuffer(),
        });
        const text = await upstream.text();
        return new Response(text, {
          status: upstream.status,
          headers: {
            'Content-Type': upstream.headers.get('Content-Type') || 'application/json; charset=utf-8',
            ...corsHeaders(origin),
          },
        });
      } catch (e) {
        return jsonResponse({ error: 'ElevenLabs STT upstream fetch failed', detail: String(e && e.message || e) }, { status: 502, origin });
      }
    }

    // ========== ElevenLabs TTS 代理（静态部署绕 CORS，纯透传）==========
    // 前端 POST /elevenlabs/tts?voice_id=...&output_format=... + xi-api-key: <user key>
    // Worker 不记录、不持久化 Key 或待合成文本。
    if (url.pathname === '/elevenlabs/tts') {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, { status: 405, origin });
      }
      const apiKey = (request.headers.get('xi-api-key') || '').trim();
      const voiceId = (url.searchParams.get('voice_id') || '').trim();
      const outputFormat = (url.searchParams.get('output_format') || 'mp3_44100_128').trim();
      const dialogue = url.searchParams.get('mode') === 'dialogue';
      const timestamps = url.searchParams.get('timestamps') === '1';
      if (!apiKey) {
        return jsonResponse({ error: 'Missing xi-api-key header (ElevenLabs API key)' }, { status: 401, origin });
      }
      if (!dialogue && !/^[A-Za-z0-9_-]{8,64}$/.test(voiceId)) {
        return jsonResponse({ error: 'Missing or invalid voice_id' }, { status: 400, origin });
      }
      if (!/^[a-z0-9_]{3,32}$/.test(outputFormat)) {
        return jsonResponse({ error: 'Invalid output_format' }, { status: 400, origin });
      }
      try {
        const endpoint = dialogue ? 'text-to-dialogue' : `text-to-speech/${encodeURIComponent(voiceId)}`;
        const upstreamUrl = `https://api.elevenlabs.io/v1/${endpoint}/stream${timestamps ? '/with-timestamps' : ''}?output_format=${encodeURIComponent(outputFormat)}`;
        const upstream = await fetch(upstreamUrl, {
          method: 'POST',
          signal: request.signal,
          headers: {
            'xi-api-key': apiKey,
            'Content-Type': request.headers.get('Content-Type') || 'application/json',
            'Accept': timestamps ? 'application/json' : 'audio/mpeg',
          },
          body: await request.text(),
        });
        const respHeaders = new Headers(corsHeaders(origin));
        respHeaders.set('Content-Type', upstream.headers.get('Content-Type') || 'audio/mpeg');
        respHeaders.set('Access-Control-Expose-Headers', 'Content-Length, Content-Type, request-id');
        respHeaders.set('Cache-Control', 'no-store, no-transform');
        const requestId = upstream.headers.get('request-id');
        if (requestId) respHeaders.set('request-id', requestId);
        return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
      } catch (e) {
        return jsonResponse({ error: 'ElevenLabs upstream fetch failed', detail: String(e && e.message || e) }, { status: 502, origin });
      }
    }

    // ========== 麦当劳 MCP 代理 (浏览器 CORS 兜底, 纯透传) ==========
    // 前端 POST /mcp/mcd  + Authorization: Bearer <user_mcp_token>
    // body 即 MCP JSON-RPC 报文 (initialize / tools/list / tools/call ...)
    // Worker 不读不存 token, 只做 CORS + 转发 https://mcp.mcd.cn
    if (url.pathname === '/mcp/mcd') {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, { status: 405, origin });
      }
      const auth = request.headers.get('Authorization');
      if (!auth) {
        return jsonResponse({ error: 'Missing Authorization header (McDonald\'s MCP token)' }, { status: 401, origin });
      }
      try {
        const fwdHeaders = {
          'Authorization': auth,
          'Content-Type': request.headers.get('Content-Type') || 'application/json',
          'Accept': request.headers.get('Accept') || 'application/json, text/event-stream',
          'User-Agent': 'aetheros-mcp-proxy/1.0',
        };
        const sid = request.headers.get('Mcp-Session-Id') || request.headers.get('mcp-session-id');
        if (sid) fwdHeaders['Mcp-Session-Id'] = sid;
        const upstream = await fetch('https://mcp.mcd.cn', {
          method: 'POST',
          headers: fwdHeaders,
          body: await request.text(),
        });
        const text = await upstream.text();
        const respHeaders = new Headers(corsHeaders(origin));
        const ct = upstream.headers.get('Content-Type');
        if (ct) respHeaders.set('Content-Type', ct);
        else respHeaders.set('Content-Type', 'application/json; charset=utf-8');
        const upSid = upstream.headers.get('Mcp-Session-Id') || upstream.headers.get('mcp-session-id');
        if (upSid) respHeaders.set('Mcp-Session-Id', upSid);
        return new Response(text, { status: upstream.status, headers: respHeaders });
      } catch (e) {
        return jsonResponse({ error: 'McDonald MCP upstream fetch failed', detail: String(e && e.message || e) }, { status: 502, origin });
      }
    }

    // ========== 瑞幸 MCP 代理 (浏览器 CORS 兜底, 纯透传) ==========
    // 前端 POST /mcp/luckin  + Authorization: Bearer <user_mcp_token>
    // body 即 MCP JSON-RPC 报文 (initialize / tools/list / tools/call ...)
    // Worker 不读不存 token, 只做 CORS + 转发 https://gwmcp.lkcoffee.com/order/user/mcp
    // token 来源: 登录 https://open.lkcoffee.com 复制 (有效期约 1 个月)
    if (url.pathname === '/mcp/luckin') {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, { status: 405, origin });
      }
      const auth = request.headers.get('Authorization');
      if (!auth) {
        return jsonResponse({ error: 'Missing Authorization header (Luckin MCP token)' }, { status: 401, origin });
      }
      try {
        const fwdHeaders = {
          'Authorization': auth,
          'Content-Type': request.headers.get('Content-Type') || 'application/json',
          'Accept': request.headers.get('Accept') || 'application/json, text/event-stream',
          'User-Agent': 'aetheros-mcp-proxy/1.0',
        };
        const sid = request.headers.get('Mcp-Session-Id') || request.headers.get('mcp-session-id');
        if (sid) fwdHeaders['Mcp-Session-Id'] = sid;
        const upstream = await fetch('https://gwmcp.lkcoffee.com/order/user/mcp', {
          method: 'POST',
          headers: fwdHeaders,
          body: await request.text(),
        });
        const text = await upstream.text();
        const respHeaders = new Headers(corsHeaders(origin));
        const ct = upstream.headers.get('Content-Type');
        if (ct) respHeaders.set('Content-Type', ct);
        else respHeaders.set('Content-Type', 'application/json; charset=utf-8');
        const upSid = upstream.headers.get('Mcp-Session-Id') || upstream.headers.get('mcp-session-id');
        if (upSid) respHeaders.set('Mcp-Session-Id', upSid);
        return new Response(text, { status: upstream.status, headers: respHeaders });
      } catch (e) {
        return jsonResponse({ error: 'Luckin MCP upstream fetch failed', detail: String(e && e.message || e) }, { status: 502, origin });
      }
    }

    // ========== 网易云音乐代理 (转发到 api-enhanced, 带边缘缓存 + 多上游容灾) ==========
    // 前端 POST /netease/<action> { ...body }
    // Worker 翻译成 api-enhanced 的 GET 参数形式并转发
    if (url.pathname.startsWith('/netease/')) {
      if (!NETEASE_UPSTREAMS || NETEASE_UPSTREAMS.length === 0) {
        return jsonResponse({
          error: "Worker 里 NETEASE_UPSTREAMS 还没配置",
          hint: "把 api-enhanced 部署到 Vercel/Deno Deploy, 拿到 URL 后改 worker/index.js 开头的 NETEASE_UPSTREAMS 数组, 然后重新部署 Worker"
        }, { status: 500, origin });
      }

      const action = url.pathname.replace('/netease/', '');
      const cookie = request.headers.get("X-Netease-Cookie") || "";
      let body = {};
      if (request.method === 'POST') {
        body = await request.json().catch(() => ({}));
      } else if (request.method === 'GET') {
        body = Object.fromEntries(url.searchParams.entries());
      }

      const upstreamPath = buildNeteaseUpstream(action, body, cookie);
      if (!upstreamPath) {
        return jsonResponse({
          error: "Unknown or unallowed netease action",
          hint: "支持: search, song/url, lyric, song/detail, login/status, login/cellphone, login/qr/key, login/qr/create, login/qr/check, captcha/sent, captcha/verify, user/detail, user/playlist, user/record, user/cloud, user/subcount, likelist, playlist/detail, playlist/track/all, recommend/songs, recommend/resource, personal_fm, daily_signin, toplist, toplist/detail, top/playlist, personalized, personalized/newsong, banner, comment/music, album, artists, artist/songs, mv/detail, mv/url 等"
        }, { status: 404, origin });
      }

      // ── 边缘缓存: 对公共数据(歌词/搜索/song/url 等) 命中直接返回 ──
      const ttl = NETEASE_CACHE_TTL[action] || 0;
      // song/url 受 VIP cookie 影响 → 用 has-cookie 分桶; 其余公共接口 cookie 不影响结果
      const cookieBucket = (action === 'song/url' && cookie) ? 'vip' : 'anon';
      const cacheKey = ttl > 0 ? buildCacheKey(action, body, cookieBucket) : null;
      if (cacheKey) {
        const cached = await caches.default.match(cacheKey);
        if (cached) {
          const text = await cached.text();
          return new Response(text, {
            status: cached.status,
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'X-Sully-Cache': 'HIT',
              ...corsHeaders(origin),
            }
          });
        }
      }

      // ── 多上游 + 容灾: 随机打乱后依次尝试, 任意一个成功就返回 ──
      const { text, status, upstream, error } = await fetchFromAnyUpstream(upstreamPath);
      if (error) {
        return jsonResponse({
          error: "netease upstream fetch failed (all sources)",
          detail: error,
          tried: NETEASE_UPSTREAMS.length,
        }, { status: 502, origin });
      }

      const response = new Response(text, {
        status,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Sully-Cache': 'MISS',
          'X-Sully-Upstream': upstream,
          ...corsHeaders(origin),
        }
      });

      // ── 写回缓存 (异步, 不阻塞响应) ──
      if (cacheKey && status >= 200 && status < 400) {
        const cacheResp = new Response(text, {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': `public, max-age=${ttl}`,
          }
        });
        if (ctx && typeof ctx.waitUntil === 'function') {
          ctx.waitUntil(caches.default.put(cacheKey, cacheResp));
        } else {
          // dev 环境没有 ctx 时直接 fire-and-forget
          caches.default.put(cacheKey, cacheResp).catch(() => {});
        }
      }

      return response;
    }

    // ========== Brave Search 代理 ==========
    if (request.method !== "GET") {
      return jsonResponse({ error: "Method not allowed. Use GET." }, { status: 405, origin });
    }

    const r = route(url);
    if (!r) {
      return jsonResponse({ error: "Not found.", hint: "Use /search, /news, /videos, /notion/*, /feishu/*, or /xhs/*" }, { status: 404, origin });
    }

    const q = url.searchParams.get("q")?.trim();
    if (!q) {
      return jsonResponse({ error: "Missing query param: q" }, { status: 400, origin });
    }

    const userKey = request.headers.get("X-Brave-API-Key")?.trim();
    if (!userKey) {
      return jsonResponse({ error: "Missing header: X-Brave-API-Key" }, { status: 401, origin });
    }

    const braveUrl = new URL(`${BRAVE_ENDPOINT}/${r.kind}/search`);
    braveUrl.searchParams.set("q", q);
    for (const k of ["count", "offset", "country", "safesearch", "spellcheck"]) {
      const v = url.searchParams.get(k);
      if (v) braveUrl.searchParams.set(k, v);
    }

    try {
      const braveRes = await fetch(braveUrl.toString(), {
        headers: { "Accept": "application/json", "X-Subscription-Token": userKey }
      });
      const text = await braveRes.text();
      return new Response(text, {
        status: braveRes.status,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) }
      });
    } catch (e) {
      return jsonResponse({ error: "Upstream fetch failed", detail: String(e) }, { status: 502, origin });
    }
  },
};
