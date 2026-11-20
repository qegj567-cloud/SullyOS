/**
 * 网易云 API 响应缓存层
 *
 * 目标：进入 Music App / 桌面切换 / 反复点击页面时，不再重复打网易云接口。
 *
 * 设计：
 *   1. 内存 Map + localStorage 双层。进程内快，刷新后仍有效。
 *   2. 每条记录带 TTL；不同 path 走不同的有效期（见 TTL_RULES）。
 *   3. Cookie 会作为 key 的盐（仅取末尾 8 位做标识）——换账号不会读到上一个账号的缓存。
 *   4. 同一个 key 的并发请求会合并成一个 in-flight promise，避免 bursty 重复请求。
 *   5. 写操作（like / 签到 / 登录 / 登出）通过 invalidate 主动清掉相关路径。
 *
 * 为什么不走数据导入导出：
 *   这里的 LS key 不在 OSContext 备份 allowlist 里，后端只挑指定键做 backup。
 *   缓存随时可以重建，没必要增加备份体积。
 */

type Entry = { data: any; expires: number };

const LS_KEY = 'sully_music_api_cache_v1'; // 不参与 backup/import-export
const MAX_ENTRIES = 200;

/**
 * 每个 path 的默认 TTL（毫秒）。
 * 精确匹配优先于前缀匹配；没匹配上 → 不缓存（直接走网络）。
 */
const TTL_RULES: Array<{ path: string; ttl: number; exact?: boolean }> = [
  // 用户侧（合理地保守一点，防止登录后看到旧数据）
  { path: '/login/status',       ttl: 60 * 1000 },
  { path: '/user/detail',        ttl: 5 * 60 * 1000 },
  { path: '/user/playlist',      ttl: 5 * 60 * 1000 },
  { path: '/user/record',        ttl: 5 * 60 * 1000 },
  { path: '/user/cloud',         ttl: 10 * 60 * 1000 },
  { path: '/user/subcount',      ttl: 5 * 60 * 1000 },
  { path: '/likelist',           ttl: 5 * 60 * 1000 },

  // 歌单内容
  { path: '/playlist/detail',    ttl: 10 * 60 * 1000 },
  { path: '/playlist/track/all', ttl: 10 * 60 * 1000 },

  // 歌词基本不会改
  { path: '/lyric',              ttl: 24 * 60 * 60 * 1000 },

  // 榜单半小时够了
  { path: '/toplist',            ttl: 30 * 60 * 1000 },

  // CDN 链接一般 ~20min 内有效，给短点避免点进去放不出来
  { path: '/song/url',           ttl: 90 * 1000 },
];

/**
 * 不应该被缓存的 path（即使没匹配 TTL 也显式列出，防止将来手滑加 TTL）：
 *   /search             —— keyword 空间太大，用户会频繁变
 *   /recommend/songs    —— 每日推荐，且带随机
 *   /personal_fm        —— 随机电台
 *   /daily_signin       —— 写
 *   /like               —— 写
 *   /logout             —— 写
 *   /login/cellphone    —— 写
 *   /login/qr/*         —— 验证码态，必须实时
 *   /captcha/sent       —— 写
 */

const MEM = new Map<string, Entry>();
const INFLIGHT = new Map<string, Promise<any>>();
let LOADED = false;

const stableStringify = (v: any): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
};

const cookieSalt = (cookie?: string): string => {
  const c = (cookie || '').trim();
  if (!c) return 'anon';
  // 取末尾 8 位作为账号区分，避免把 cookie 明文落地到 key
  return c.length <= 8 ? c : c.slice(-8);
};

const getTtl = (path: string): number | null => {
  for (const r of TTL_RULES) {
    if (r.path === path) return r.ttl;
  }
  for (const r of TTL_RULES) {
    if (path.startsWith(r.path)) return r.ttl;
  }
  return null;
};

const load = () => {
  if (LOADED) return;
  LOADED = true;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw) as Record<string, Entry>;
    const now = Date.now();
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v.expires === 'number' && v.expires > now) {
        MEM.set(k, v);
      }
    }
  } catch {}
};

const persistNow = () => {
  try {
    // 逐出过期 + 容量裁剪（丢掉最早插入的）
    const now = Date.now();
    const arr: Array<[string, Entry]> = [];
    for (const [k, v] of MEM) {
      if (v.expires > now) arr.push([k, v]);
      else MEM.delete(k);
    }
    if (arr.length > MAX_ENTRIES) arr.splice(0, arr.length - MAX_ENTRIES);
    const out: Record<string, Entry> = {};
    for (const [k, v] of arr) out[k] = v;
    localStorage.setItem(LS_KEY, JSON.stringify(out));
  } catch {}
};

// 批量：同一 task 内多次写只落盘一次。
// 用 microtask（Promise.resolve().then）而不是 setTimeout —— microtask 会在当前 task 末尾、
// 浏览器把页面交给 unload 之前跑完；setTimeout 可能赶不上快速刷新。
let persistQueued = false;
const schedulePersist = () => {
  if (persistQueued) return;
  persistQueued = true;
  Promise.resolve().then(() => {
    persistQueued = false;
    persistNow();
  });
};

/**
 * 页面卸载 / 切后台时同步落盘，兜住 microtask 也错过的边界情况。
 * pagehide 对 bfcache 有效；visibilitychange→hidden 对后台切换有效。
 */
if (typeof window !== 'undefined') {
  const flush = () => { persistQueued = false; persistNow(); };
  window.addEventListener('pagehide', flush);
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}

const makeKey = (path: string, body: any, cookie?: string) =>
  `${cookieSalt(cookie)}|${path}|${stableStringify(body ?? {})}`;

const shouldStoreCache = (path: string, res: any): boolean => {
  if (!res || typeof res !== 'object') return false;
  // 业务异常码（如 -460 风控、301 未登录、400 参数错误）即使以 HTTP 200 返回也不进本地缓存，
  // 防止单次偶发失败把后续正常请求锁死在整个 TTL 窗口内（歌词 TTL 长达 24h）。
  if (typeof res.code === 'number' && res.code !== 200) return false;
  if (path === '/song/url') {
    const first = Array.isArray(res.data) ? res.data[0] : null;
    if (!first?.url) return false;
  }
  return true;
};

/**
 * 包装实际请求。不在缓存规则里的 path → 直接打网络。
 */
export async function cachedCall<T = any>(
  path: string,
  body: any,
  cookie: string | undefined,
  doCall: () => Promise<T>,
): Promise<T> {
  const ttl = getTtl(path);
  if (!ttl) return doCall();

  load();
  const key = makeKey(path, body, cookie);
  const now = Date.now();

  const hit = MEM.get(key);
  if (hit && hit.expires > now) return hit.data as T;

  const pending = INFLIGHT.get(key);
  if (pending) return pending as Promise<T>;

  const p = doCall().then(
    (res) => {
      INFLIGHT.delete(key);
      if (shouldStoreCache(path, res)) {
        MEM.set(key, { data: res, expires: Date.now() + ttl });
        schedulePersist();
      }
      return res;
    },
    (err) => {
      INFLIGHT.delete(key);
      throw err;
    },
  );
  INFLIGHT.set(key, p);
  return p;
}

/**
 * 按路径前缀清除。cookie 传入就只清当前账号，不传就全账号清。
 * 用例：
 *   toggleLike 后       → invalidate('/likelist', cfg.cookie)
 *   签到后              → invalidate('/user/subcount', cfg.cookie)
 *   登录 / 登出 / 换账号 → clearAll()
 */
export function invalidate(pathPrefix: string, cookie?: string) {
  load();
  const salt = cookie !== undefined ? cookieSalt(cookie) : null;
  for (const k of [...MEM.keys()]) {
    const sepA = k.indexOf('|');
    if (sepA < 0) continue;
    const sepB = k.indexOf('|', sepA + 1);
    if (sepB < 0) continue;
    const s = k.slice(0, sepA);
    const path = k.slice(sepA + 1, sepB);
    if (salt && s !== salt) continue;
    if (path.startsWith(pathPrefix)) MEM.delete(k);
  }
  schedulePersist();
}

export function clearAll() {
  MEM.clear();
  INFLIGHT.clear();
  try { localStorage.removeItem(LS_KEY); } catch {}
  LOADED = true;
}
