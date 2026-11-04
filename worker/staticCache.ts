/** Resource caching is isolated from push delivery and never opens application databases. */
export interface StaticEntry { url: string; revision: string; bytes: number }
export interface StaticManifest { buildId: string; appVersion: string; entries: StaticEntry[]; shell: string[] }
interface CacheDependencies {
  manifest: StaticManifest;
  scope: string;
  caches: CacheStorage;
  fetch: (request: Request) => Promise<Response>;
  digest: (bytes: ArrayBuffer) => Promise<string>;
  waitUntil: (promise: Promise<unknown>) => void;
  now?: () => number;
  maxBytes?: number;
  maxEntries?: number;
}

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
// A resource used after this long is refreshed in the background: external ones are downloaded
// again, local ones only have their last-use time renewed.
const REFRESH_MS = 24 * 60 * 60 * 1000;
const SIZE_HEADER = 'X-Sully-Cache-Bytes';
const SAVED_HEADER = 'X-Sully-Cache-Saved';
const immutablePath = (path: string) => /^assets\/build\/[^/]+-[\w-]{8,}\.[\w]+$/.test(path);

export function isPublicExternalAsset(url: URL): boolean {
  if (url.protocol !== 'https:') return false;
  if (url.hostname === 'fonts.googleapis.com') return url.pathname === '/css2';
  if (url.hostname === 'fonts.gstatic.com') return url.pathname.startsWith('/s/');
  if (['cdn.jsdelivr.net', 'fastly.jsdelivr.net', 'gcore.jsdelivr.net'].includes(url.hostname)) {
    return url.pathname.startsWith('/gh/qegj567-cloud/SullyOS-assets@') || /^\/npm\/katex@0\.16\.(9|11)\/dist\//.test(url.pathname);
  }
  if (url.hostname === 'raw.githubusercontent.com') return url.pathname.startsWith('/qegj567-cloud/SullyOS-assets/');
  if (url.hostname === 'cdn.statically.io') return url.pathname.startsWith('/gh/qegj567-cloud/SullyOS-assets/');
  return url.hostname === 'unpkg.com' && url.pathname.startsWith('/katex@0.16.9/dist/');
}

export function createStaticCache(deps: CacheDependencies) {
  const { manifest, caches } = deps;
  const scope = new URL(deps.scope);
  const prefix = `sully-static-${encodeURIComponent(scope.pathname)}-v1-`;
  const shellName = `${prefix}shell-${manifest.buildId}`;
  const runtimeName = `${prefix}runtime`;
  const now = deps.now || Date.now;
  const entries = new Map(manifest.entries.map(entry => [new URL(entry.url, scope).href, entry]));
  const shellPaths = new Set(manifest.shell.map(path => new URL(path, scope).href));
  let writeQueue: Promise<unknown> = Promise.resolve();
  const absolute = (path: string) => new URL(path, scope).href;
  const staleKey = absolute('__sully_shell_stale__');
  const keyFor = (entry: StaticEntry) => immutablePath(entry.url)
    ? absolute(entry.url) : `${absolute(entry.url)}?__sully_revision=${entry.revision}`;
  const serial = <T>(job: () => Promise<T>): Promise<T> => {
    const next = writeQueue.catch(() => {}).then(job);
    writeQueue = next.catch(() => {});
    return next;
  };
  const safeMatch = async (name: string, key: string) => {
    try { return await (await caches.open(name)).match(key); } catch { return undefined; }
  };
  const findOwned = async (key: string): Promise<Response | undefined> => {
    const names = await caches.keys();
    for (const name of names.filter(name => name.startsWith(prefix)).reverse()) {
      const hit = await safeMatch(name, key);
      if (hit) return hit;
    }
    return undefined;
  };
  const isBuildScript = (entry: StaticEntry) => immutablePath(entry.url) && entry.url.endsWith('.js');
  // Cache writes were already checked, but the browser must not execute an unchecked network
  // response (or a damaged cached body) while that background check is still running.
  async function verifiedScript(response: Response, entry: StaticEntry): Promise<Response | undefined> {
    try {
      if (response.status !== 200 || entry.bytes > MAX_FILE_BYTES) return;
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== entry.bytes || await deps.digest(bytes) !== entry.revision) return;
      const headers = new Headers(response.headers);
      headers.delete('Content-Encoding');
      headers.set('Content-Length', String(bytes.byteLength));
      return new Response(bytes, { headers });
    } catch { /* Truncated/erroring response streams are also integrity failures. */ }
  }
  const discardDamaged = (key: string) => serial(async () => {
    runtimeIndex = undefined;
    for (const name of (await caches.keys()).filter(name => name.startsWith(prefix))) {
      await (await caches.open(name)).delete(key);
    }
  }).catch(() => {});

  // Hosts may add scripts to HTML or rewrite parts of it. Such an entry page still belongs to
  // this build as long as every build file it references is one of ours.
  const sameBuildPage = (html: string) => {
    const references = [...html.matchAll(/assets\/build\/[^"'\s<>)]+/g)];
    return references.length > 0 && references.every(match => entries.has(absolute(match[0])));
  };

  /** Consumes `response`; callers pass a copy they do not need afterwards. */
  async function cacheable(response: Response, entry?: StaticEntry): Promise<Response | undefined> {
    if (response.status !== 200 || response.type === 'opaque' || response.redirected ||
      /\b(no-store|private)\b/i.test(response.headers.get('Cache-Control') || '') ||
      response.headers.get('Vary') === '*' || (entry && entry.bytes > MAX_FILE_BYTES)) {
      void response.body?.cancel().catch(() => {});
      return;
    }
    const reader = response.body?.getReader();
    if (!reader) return;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FILE_BYTES) { void reader.cancel().catch(() => {}); return; }
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    if (entry && (size !== entry.bytes || await deps.digest(body.buffer) !== entry.revision) &&
      !(entry.url === 'index.html' && sameBuildPage(new TextDecoder().decode(body)))) return;
    const headers = new Headers(response.headers);
    headers.delete('Content-Encoding');
    headers.set('Content-Length', String(size));
    headers.set(SIZE_HEADER, String(size));
    headers.set(SAVED_HEADER, String(now()));
    return new Response(body, { headers });
  }

  // Sizes and last-use times of the optional cache, read once per worker start so that writes
  // do not reread every stored response. Only the active worker serves requests.
  interface Stored { size: number; saved: number }
  let runtimeIndex: Promise<Map<string, Stored>> | undefined;
  const describe = (response: Response): Stored => ({
    size: Number(response.headers.get(SIZE_HEADER)) || 0, saved: Number(response.headers.get(SAVED_HEADER)) || 0,
  });
  const indexOf = (cache: Cache) => runtimeIndex ??= (async () => {
    const items = new Map<string, Stored>();
    for (const key of await cache.keys()) {
      const response = await cache.match(key);
      if (response) items.set(key.url, describe(response));
    }
    return items;
  })().catch(error => { runtimeIndex = undefined; throw error; });

  async function prune(cache: Cache) {
    const items = await indexOf(cache);
    let bytes = 0;
    for (const item of items.values()) bytes += item.size;
    // Least recently used first, so anything past the maximum age is also at the front.
    for (const [key, item] of [...items].sort((a, b) => a[1].saved - b[1].saved)) {
      const expired = !item.saved || now() - item.saved > MAX_AGE;
      if (!expired && items.size <= (deps.maxEntries ?? 256) && bytes <= (deps.maxBytes ?? 96 * 1024 * 1024)) break;
      await cache.delete(key);
      items.delete(key); bytes -= item.size;
    }
  }

  const store = (key: string, response: Response) => serial(async () => {
    const cache = await caches.open(runtimeName);
    const items = await indexOf(cache);
    const item = describe(response);
    await cache.put(key, response);
    items.set(key, item);
    await prune(cache);
  });

  const remember = async (key: string, response: Response, entry?: StaticEntry) => {
    try {
      const stored = await cacheable(response, entry);
      if (stored) await store(key, stored);
    } catch { /* Storage failure must not turn a successful request into an error. */ }
  };

  const touch = async (key: string) => {
    try {
      const current = await safeMatch(runtimeName, key);
      if (!current) return;
      const headers = new Headers(current.headers);
      headers.set(SAVED_HEADER, String(now()));
      await store(key, new Response(current.body, { headers }));
    } catch { /* The resource stays usable with its previous time. */ }
  };

  // Set once a newer release replaced this build: the server stopped serving one of its hashed
  // files, or the next worker reported a release that needs no consent (`markReplaced`). Kept in
  // the shell cache, so it lasts across worker restarts and ends with the build.
  let shellStale: Promise<boolean> | undefined;
  const isShellStale = () => shellStale ??= safeMatch(shellName, staleKey).then(Boolean);
  const markShellStale = async () => {
    shellStale = Promise.resolve(true);
    try { await (await caches.open(shellName)).put(staleKey, new Response(null)); } catch { /* remembered for this worker run */ }
  };
  const refreshing = new Set<string>();
  const missing = (response: Response) => response.status === 404 || response.status === 410 ||
    (response.ok && /^text\/html\b/i.test(response.headers.get('Content-Type') || ''));

  let installation: Promise<void> | undefined;
  function install(): Promise<void> {
    // Startup, settings and multiple tabs may ask together. Share the writers so a failed
    // attempt cannot remove the completion marker of another attempt that just succeeded.
    return installation ??= prepareShell().finally(() => { installation = undefined; });
  }

  async function prepareShell() {
    const cache = await caches.open(shellName);
    try {
      // Write HTML last: a shell is usable only after every synchronous dependency is verified.
      async function prepare(path: string) {
        const entry = entries.get(absolute(path));
        if (!entry) throw new Error(`Missing shell entry: ${path}`);
        let old = await findOwned(keyFor(entry));
        let damaged = false;
        if (old && isBuildScript(entry)) {
          old = await verifiedScript(old, entry);
          if (!old) { damaged = true; await discardDamaged(keyFor(entry)); }
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);
        try {
          // Some hosts redirect /index.html to the directory URL, which serves the same page everywhere.
          // A hashed name always has the same content, so the copy the page just downloaded is reused.
          const request = new Request(path === 'index.html' ? scope.href : absolute(path),
            { cache: damaged ? 'reload' : immutablePath(path) ? 'default' : 'no-cache', signal: controller.signal });
          let response = old || await cacheable(await deps.fetch(request), entry).catch(() => undefined);
          // A broken immutable HTTP-cache entry otherwise poisons every update attempt.
          if (!response && isBuildScript(entry) && request.cache !== 'reload') {
            response = await cacheable(await deps.fetch(new Request(request, { cache: 'reload' })), entry);
          }
          if (!response) throw new Error(`Resource changed during deployment: ${path}`);
          await cache.put(keyFor(entry), response);
        } finally { clearTimeout(timer); }
      }
      const paths = manifest.shell.filter(path => path !== 'index.html');
      // Wait for every writer before declaring failure; verified files stay for the next attempt.
      let failed = false;
      const jobs = await Promise.allSettled(Array.from({ length: Math.min(4, paths.length) }, async () => {
        while (paths.length && !failed) {
          try { await prepare(paths.shift()!); }
          catch (error) { failed = true; throw error; }
        }
      }));
      const failure = jobs.find((job): job is PromiseRejectedResult => job.status === 'rejected');
      if (failure) throw failure.reason;
      await prepare('index.html');
    } catch (error) {
      // The HTML is the completion marker. Keep verified dependencies across worker restarts
      // and retries, but never advertise an incomplete shell as ready for offline startup.
      const index = entries.get(absolute('index.html'));
      if (index) await cache.delete(keyFor(index)).catch(() => {});
      throw error;
    }
  }

  async function activate(inUseBuilds: string[] | null = []) {
    // Keep the latest partial shell for resuming downloads AND the previous complete shell.
    // A partial update must not displace the last offline-ready release. Older releases still
    // open in tabs are protected; defer cleanup if a legacy tab cannot identify its build.
    const old = (await caches.keys()).filter(name => name.startsWith(`${prefix}shell-`) && name !== shellName);
    if (inUseBuilds) {
      const protectedNames = new Set(inUseBuilds.map(build => `${prefix}shell-${build}`));
      if (old.length) protectedNames.add(old[old.length - 1]);
      for (const name of [...old].reverse()) {
        const keys = await (await caches.open(name)).keys();
        if (keys.some(key => {
          const url = new URL(key.url);
          return `${url.origin}${url.pathname}` === absolute('index.html');
        })) { protectedNames.add(name); break; }
      }
      for (const name of old) if (!protectedNames.has(name)) await caches.delete(name);
    }
    await serial(async () => prune(await caches.open(runtimeName)));
  }

  function handle(request: Request, waitUntil = deps.waitUntil): Promise<Response> | undefined {
    if (request.method !== 'GET' || request.headers.has('Authorization') || request.headers.has('Range') || request.cache === 'no-store') return;
    const url = new URL(request.url);
    const local = url.origin === scope.origin && url.pathname.startsWith(scope.pathname);
    const pathname = local ? url.pathname.slice(scope.pathname.length) : '';
    const isShell = local && (pathname === '' || pathname === 'index.html');
    // Arbitrary query strings can identify dynamic responses; only existing icon revision URLs are
    // normalized. The entry page is the same for any query, which the app itself reads (e.g. the
    // URL a notification opens).
    if (local && !isShell && [...url.searchParams.keys()].some(key => key !== 'v')) return;
    const canonical = `${url.origin}${url.pathname}`;
    const entry = entries.get(isShell ? absolute('index.html') : canonical);
    // A no-cors request only yields an opaque response, which is never stored.
    const external = !local && isPublicExternalAsset(url) && request.mode !== 'no-cors' && request.credentials !== 'include';
    const hashed = local && immutablePath(pathname);
    if (!entry && !external && !hashed) return;
    const key = entry ? keyFor(entry) : request.url;

    return (async () => {
      const shell = entry && shellPaths.has(absolute(entry.url));
      if (entry && !hashed && await isShellStale()) {
        // The release now on the server supplies the page and the files that keep their names
        // across releases; offline, the copies of this build below still start the app.
        try {
          const fresh = await deps.fetch(isShell ? request : new Request(request, { cache: 'no-cache' }));
          if (fresh.ok || fresh.type === 'opaqueredirect') return fresh;
        } catch { /* cached copy */ }
      }
      const stored = await safeMatch(shell ? shellName : runtimeName, key);
      let hit = stored;
      if (!hit && (shell || hashed)) {
        try { hit = await findOwned(key); } catch { /* network fallback */ }
      }
      const age = hit ? now() - Number(hit.headers.get(SAVED_HEADER)) : 0;
      if (hit && !shell && age > MAX_AGE) hit = undefined;
      let damaged = false;
      if (hit && entry && isBuildScript(entry)) {
        hit = await verifiedScript(hit, entry);
        if (!hit) { damaged = true; await discardDamaged(key); }
      }
      if (hit) {
        if (stored && !shell && age > REFRESH_MS && !refreshing.has(key)) {
          refreshing.add(key);
          waitUntil((external ? deps.fetch(request).then(response => remember(key, response)) : touch(key))
            .catch(() => {}).finally(() => refreshing.delete(key)));
        }
        return hit;
      }
      // A hashed name always has the same content, so the HTTP cache may answer. Other known
      // revisions are revalidated: an older HTTP force-cache response must not satisfy them.
      let response = await deps.fetch(damaged ? new Request(request, { cache: 'reload' })
        : entry && !hashed ? new Request(request, { cache: 'no-cache' }) : request);
      let reloaded = damaged || request.cache === 'reload';
      if (entry && hashed && missing(response)) {
        // An HTTP cache can hold a fallback page under this name; ask the server before deciding.
        if (!reloaded) {
          void response.body?.cancel().catch(() => {});
          response = await deps.fetch(new Request(request, { cache: 'reload' }));
        }
        reloaded = true;
        if (missing(response)) waitUntil(markShellStale());
      }
      if (entry && isBuildScript(entry) && response.ok && !missing(response)) {
        let verified = await verifiedScript(response, entry);
        if (!verified && !reloaded) {
          response = await deps.fetch(new Request(request, { cache: 'reload' }));
          if (missing(response)) { waitUntil(markShellStale()); return response; }
          verified = await verifiedScript(response, entry);
        }
        if (!verified) {
          waitUntil(markShellStale());
          return Response.error();
        }
        response = verified;
      }
      // A missing old shell must not be replaced by HTML from a different deployment.
      if (!isShell && (entry || external)) waitUntil(remember(key, response.clone(), entry));
      return response;
    })();
  }

  async function stats() {
    let shellBytes = 0, runtimeBytes = 0, runtimeEntries = 0;
    for (const name of (await caches.keys()).filter(name => name.startsWith(prefix))) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        const size = Number(response?.headers.get(SIZE_HEADER)) || 0;
        if (name === runtimeName) { runtimeBytes += size; runtimeEntries++; } else shellBytes += size;
      }
    }
    const index = entries.get(absolute('index.html'));
    return { buildId: manifest.buildId, appVersion: manifest.appVersion, shellBytes, runtimeBytes, runtimeEntries,
      offlineReady: Boolean(index && await safeMatch(shellName, keyFor(index))) };
  }

  const clearRuntime = () => serial(() => { runtimeIndex = undefined; return caches.delete(runtimeName); });
  return { install, activate, handle, stats, clearRuntime, markReplaced: markShellStale };
}
