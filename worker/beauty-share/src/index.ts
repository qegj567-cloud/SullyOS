import { BEAUTY_MAX_BYTES, isRecord, validateBeautyMetadata, validateBeautyPackage, validateBeautyPassword, validateBeautyRepo } from '../../../utils/beautyShareContract';
import { equal, identity, newSession, passwordHash, randomHex, sha256 } from './auth';
import type { Env } from './types';
import { validateCatalogCover, CATALOG_COVER_MAX } from '../../../utils/beautyCatalogContract';
import { dirtyCatalog } from './catalog';
import { catalogMutation, catalogJob } from './catalogRefresh';
export { CatalogRefresh } from './catalogRefresh';

class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
function fail(status: number, message: string): never { throw new HttpError(status, message); }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const now = () => Date.now();
const positiveLimit = (raw: string | undefined, fallback: number) => Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : fallback;

async function readJson(request: Request, maxBytes: number): Promise<any> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) fail(415, '请使用 JSON 请求');
  if (Number(request.headers.get('content-length')) > maxBytes) fail(413, '文件过大，分享包最多 20 MB');
  const reader = request.body?.getReader();
  if (!reader) fail(400, '请求内容为空');
  const decoder = new TextDecoder(); let size = 0; let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); fail(413, '文件过大，分享包最多 20 MB'); }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  try { const value = JSON.parse(text); if (!isRecord(value)) throw Error(); return value; } catch { return fail(400, 'JSON 文件格式不正确'); }
}

async function limit(env: Env, key: string, max: number, duration: number, amount = 1) {
  const window = Math.floor(now() / duration);
  const result = await env.DB.prepare(`INSERT INTO limits(key,value,expires_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=value+excluded.value WHERE value+excluded.value<=?
    RETURNING value`).bind(`${key}:${window}`, amount, (window + 1) * duration, max).first();
  if (!result || amount > max) fail(429, '操作过于频繁或今日上传额度已满，请稍后再试');
}
async function principal(request: Request, env: Env, role: 'author' | 'admin') {
  const who = await identity(request, env);
  if (!who) fail(401, '登录已过期，请重新登录');
  if (who.role !== role) fail(403, '没有此操作权限');
  return who;
}
const toSubmission = (row: any, admin = false) => ({
  id: row.id, kind: row.kind, shareCode: row.share_code, publishedRevision: row.published_revision,
  pendingRevision: row.pending_revision, latestRevision: row.latest_revision, status: row.status,
  metadata: JSON.parse(row.metadata), reviewNote: row.review_note, updatedAt: row.updated_at,
  catalogHidden: !!row.catalog_hidden,
  catalogPublic: !row.catalog_hidden && !!row.catalog_public,
  ...(admin ? { authorCode: row.author_code } : {}),
});
const selectSubmission = `SELECT s.*,r.status,r.metadata,r.review_note,
  EXISTS(SELECT 1 FROM revisions pub WHERE pub.id=s.published_revision AND pub.status='approved' AND json_extract(pub.metadata,'$.allowPublicListing')=1) AS catalog_public
  FROM submissions s JOIN revisions r ON r.id=s.latest_revision`;
const PAGE_SIZE = 12;
function pageOffset(url: URL) { return Math.min(100000, Math.max(0, Math.floor(Number(url.searchParams.get('offset')) || 0))); }
async function listSubmissions(env: Env, url: URL, author?: string) {
  const status = url.searchParams.get('status') || (author ? 'all' : 'pending');
  if (!['pending', 'approved', 'rejected', 'all'].includes(status)) fail(400, '状态无效');
  const search = (url.searchParams.get('q') || '').trim().slice(0, 80);
  const clauses = ['s.deleted_at IS NULL']; const args: unknown[] = [];
  if (author) { clauses.push('s.author_code=?'); args.push(author); }
  if (status !== 'all') { clauses.push('r.status=?'); args.push(status); }
  if (search) { clauses.push("(instr(lower(json_extract(r.metadata,'$.name')),lower(?))>0 OR instr(lower(s.author_code),lower(?))>0 OR instr(lower(COALESCE(s.share_code,'')),lower(?))>0)"); args.push(search, search, search); }
  const where = ' WHERE ' + clauses.join(' AND ');
  const count = await env.DB.prepare('SELECT count(*) AS n FROM submissions s JOIN revisions r ON r.id=s.latest_revision' + where).bind(...args).first();
  const total = Number(count?.n || 0);
  const offset = Math.min(pageOffset(url), Math.max(0, Math.ceil(total / PAGE_SIZE) - 1) * PAGE_SIZE);
  const { results } = await env.DB.prepare(selectSubmission + where + ' ORDER BY s.updated_at DESC,s.id DESC LIMIT ? OFFSET ?').bind(...args, PAGE_SIZE, offset).all();
  return json({ submissions: results.map(row => toSubmission(row, !author)), total, offset, pageSize: PAGE_SIZE, nextOffset: offset + PAGE_SIZE < total ? offset + PAGE_SIZE : null });
}

async function submit(request: Request, env: Env, author: string, id?: string, termsOnly = false) {
  if (env.UPLOADS_ENABLED !== 'true') fail(503, '投稿暂未开放，请稍后再试');
  await limit(env, `${termsOnly?'terms':'upload'}:${author}`, termsOnly?50:6, 3600_000);
  const body = await readJson(request, BEAUTY_MAX_BYTES + 16384 + CATALOG_COVER_MAX * 2);
  let metadata, pack;
  try { metadata = validateBeautyMetadata(body.metadata); pack = validateBeautyPackage(body.package); }
  catch (error) { return fail(400, (error as Error).message); }
  let catalogCover='';
  if(metadata.allowPublicListing){
    if(!env.CATALOG)fail(503,'装扮库正在准备中，请稍后公开投稿，或取消公开展示后使用分享码');
    try { catalogCover=validateCatalogCover(body.catalogCover); } catch(error){fail(400,(error as Error).message);}
  }
  const content = JSON.stringify(pack.data);
  const bytes = new TextEncoder().encode(content).byteLength;
  if (bytes > BEAUTY_MAX_BYTES) fail(413, '分享包最多 20 MB');
  const workId = id || randomHex();
  if (id) {
    const work = await env.DB.prepare('SELECT * FROM submissions WHERE id=? AND author_code=? AND deleted_at IS NULL').bind(id, author).first();
    if (!work) fail(404, '作品不存在');
    if (work.kind !== pack.kind) fail(400, '更新必须与原作品类型相同');
    if (work.pending_revision) fail(409, '已有待审版本，请等待审核后再更新');
    if (body.expectedRevision !== work.latest_revision) fail(409, '作品状态已变化，请刷新后重试');
    if (termsOnly && body.expectedCatalogHidden !== work.catalog_hidden) fail(409, '公开设置已变化，请刷新后重试');
  } else {
    const count = await env.DB.prepare('SELECT count(*) AS n FROM submissions WHERE author_code=? AND deleted_at IS NULL').bind(author).first();
    if (Number(count?.n) >= 200) fail(429, '每位作者最多保留 200 份作品');
  }
  await limit(env, 'upload-bytes', positiveLimit(env.DAILY_UPLOAD_BYTES, 256 * 1024 * 1024), 86400_000, bytes);
  const capacity = positiveLimit(env.TOTAL_STORAGE_BYTES, 8 * 1024 ** 3);
  if (bytes > capacity) fail(507, '存储额度已满，请联系管理员');
  const reserved = await env.DB.prepare(`INSERT INTO limits(key,value,expires_at) VALUES('storage',?,0)
    ON CONFLICT(key) DO UPDATE SET value=value+excluded.value WHERE value+excluded.value<=? RETURNING value`)
    .bind(bytes, capacity).first();
  if (!reserved) fail(507, '存储额度已满，请联系管理员');
  const revision = randomHex(); const blobKey = `packages/${workId}/${revision}.json`;
  const hash = await sha256(content);
  try {
    await env.FILES.put(blobKey, content, { httpMetadata: { contentType: 'application/json' } });
    if (!id) {
      await env.DB.prepare('INSERT INTO submissions(id,author_code,kind,created_at,updated_at) VALUES(?,?,?,?,?)').bind(workId, author, pack.kind, now(), now()).run();
    }
    // Conditional INSERT plus pointer update in a single D1 transaction prevents concurrent
    // uploads and a simultaneous delete from resurrecting or replacing an unreviewed revision.
    const results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO revisions(id,submission_id,metadata,blob_key,bytes,sha256,status,created_at,catalog_cover)
        SELECT ?,id,?,?,?,?,'pending',?,? FROM submissions WHERE id=? AND author_code=? AND deleted_at IS NULL
        AND pending_revision IS NULL AND COALESCE(latest_revision,'')=? AND (?=0 OR catalog_hidden=?)`)
        .bind(revision, JSON.stringify(metadata), blobKey, bytes, hash, now(), catalogCover, workId, author, id ? body.expectedRevision : '', termsOnly?1:0, termsOnly?body.expectedCatalogHidden:0),
      env.DB.prepare(`UPDATE submissions SET pending_revision=?,latest_revision=?,updated_at=?
        WHERE id=? AND EXISTS(SELECT 1 FROM revisions WHERE id=?)`).bind(revision, revision, now(), workId, revision),
    ]);
    if (!results[0].meta.changes) fail(409, '作品状态已变化，请刷新后重试');
  } catch (error) {
    await env.FILES.delete(blobKey);
    await env.DB.prepare("UPDATE limits SET value=MAX(0,value-?) WHERE key='storage'").bind(bytes).run();
    if (!id) await env.DB.prepare('DELETE FROM submissions WHERE id=? AND latest_revision IS NULL').bind(workId).run();
    throw error;
  }
  return json({ id: workId, revision, status: 'pending' }, 201);
}

async function remove(env: Env, id: string, author?: string) {
  const row = await env.DB.prepare(`SELECT id FROM submissions WHERE id=? AND deleted_at IS NULL${author ? ' AND author_code=?' : ''}`)
    .bind(...(author ? [id, author] : [id])).first();
  if (!row) fail(404, '作品不存在');
  // Revoke access first, then cleanup. A cleanup failure must never keep a share usable.
  await catalogMutation(env, () => env.DB.batch([
    env.DB.prepare('UPDATE submissions SET deleted_at=?,updated_at=?,pending_revision=NULL,published_revision=NULL WHERE id=?').bind(now(), now(), id),
    env.DB.prepare("UPDATE revisions SET status='withdrawn' WHERE submission_id=? AND status='pending'").bind(id),
    dirtyCatalog(env),
  ]));
  // Access is already revoked. Scheduled cleanup retries storage failures.
  try { await cleanup(env); } catch { /* Keep the successful deletion visible to the author. */ }
  return json({ deleted: true });
}

export async function cleanup(env: Env) {
  const { results } = await env.DB.prepare(`SELECT r.id,r.blob_key,r.bytes FROM revisions r JOIN submissions s ON s.id=r.submission_id
    WHERE r.blob_key!='' AND (s.deleted_at IS NOT NULL OR (r.id!=COALESCE(s.published_revision,'')
    AND r.id!=COALESCE(s.pending_revision,'') AND r.id!=COALESCE(s.latest_revision,''))) LIMIT 100`).all();
  for (const row of results) {
    await env.FILES.delete(row.blob_key);
    // Atomic claim + accounting: overlapping cron/delete cleanup cannot double-subtract.
    await env.DB.batch([
      env.DB.prepare("UPDATE limits SET value=MAX(0,value-?) WHERE key='storage' AND EXISTS(SELECT 1 FROM revisions WHERE id=? AND blob_key!='')").bind(row.bytes, row.id),
      env.DB.prepare("UPDATE revisions SET blob_key='' WHERE id=?").bind(row.id),
    ]);
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(now()),
    env.DB.prepare('DELETE FROM limits WHERE expires_at>0 AND expires_at<?').bind(now()),
  ]);
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url); const path = url.pathname; const method = request.method;
  if (path === '/health') return json({ ok: true, uploadsEnabled: env.UPLOADS_ENABLED === 'true' });
  if (path === '/admin' || path.startsWith('/admin/')) {
    const assetPath = path === '/admin' || path === '/admin/' ? '/' : path.slice('/admin'.length);
    return env.ASSETS.fetch(new Request(new URL(assetPath, request.url), request));
  }
  if (path === '/') return new Response('SullyOS 美化分享服务。请在糯米机中输入美化码。');
  if (!path.startsWith('/api/')) fail(404, '不存在的接口');
  if (!env.AUTH_PEPPER || env.AUTH_PEPPER.length < 32) fail(503, '服务尚未完成配置');
  if (path.startsWith('/api/admin/') && request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) fail(403, '请从管理员页面操作');
  const ip = await sha256(env.AUTH_PEPPER + ':' + (request.headers.get('CF-Connecting-IP') || 'local'));
  await limit(env, `requests:${ip}`, 180, 60_000);

  if (method === 'POST' && path === '/api/admin/reset-password') {
    await limit(env, `admin-reset:${ip}`, 10, 3600_000);
    const body = await readJson(request, 4096);
    if (typeof body.token !== 'string' || !/^[a-f0-9]{64}$/.test(body.token)) fail(403, '重置链接无效或已过期');
    let password: string;
    try { password = validateBeautyPassword(body.password); } catch (error) { return fail(400, (error as Error).message); }
    if (body.passwordConfirm !== password) fail(400, '两次输入的密码不一致');
    const key = `admin-reset:${await sha256(body.token)}`;
    const grant = await env.DB.prepare('SELECT key FROM limits WHERE key=? AND expires_at>?').bind(key, now()).first();
    if (!grant) fail(403, '重置链接无效或已过期');
    const hash = await passwordHash(password, env.AUTH_PEPPER);
    // D1 batch is transactional; conditional UPDATE makes concurrent token replay fail.
    const results = await env.DB.batch([
      env.DB.prepare("UPDATE authors SET password_hash=? WHERE role='admin' AND EXISTS(SELECT 1 FROM limits WHERE key=? AND expires_at>?)").bind(hash, key, now()),
      env.DB.prepare("DELETE FROM sessions WHERE author_code IN (SELECT code FROM authors WHERE role='admin' AND password_hash=?)").bind(hash),
      env.DB.prepare('DELETE FROM limits WHERE key=?').bind(key),
    ]);
    if (results[0].meta.changes !== 1) fail(403, '重置链接无效或已过期');
    const admin = await env.DB.prepare("SELECT code FROM authors WHERE role='admin'").first<{ code: string }>();
    return json({ username: admin!.code.slice('admin:'.length) });
  }
  if (method === 'POST' && path === '/api/admin/setup') {
    const body = await readJson(request, 4096);
    if (!env.BOOTSTRAP_HASH || typeof body.token !== 'string' || !equal(await sha256(body.token), env.BOOTSTRAP_HASH)) fail(403, '初始化凭据无效');
    if (await env.DB.prepare("SELECT code FROM authors WHERE role='admin'").first()) fail(409, '管理员已建立，请直接登录');
    if (typeof body.username !== 'string' || !/^[a-zA-Z0-9_-]{3,40}$/.test(body.username)) fail(400, '管理员账号需为 3–40 位字母、数字、下划线或短横线');
    let password: string;
    try { password = validateBeautyPassword(body.password); } catch (error) { return fail(400, (error as Error).message); }
    const code = 'admin:' + body.username;
    await env.DB.prepare('INSERT INTO authors(code,role,password_hash,created_at) VALUES(?,?,?,?)')
      .bind(code, 'admin', await passwordHash(password, env.AUTH_PEPPER), now()).run();
    return json(await newSession(env, code, true));
  }
  if (method === 'POST' && path === '/api/auth/register') {
    if (env.UPLOADS_ENABLED !== 'true') fail(503, '投稿暂未开放');
    await limit(env, `register:${ip}`, 3, 86400_000);
    const body = await readJson(request, 4096);
    let password: string;
    try { password = validateBeautyPassword(body.password); } catch (error) { return fail(400, (error as Error).message); }
    const code = 'A-' + randomHex(8).toUpperCase();
    await env.DB.prepare('INSERT INTO authors(code,role,password_hash,created_at) VALUES(?,?,?,?)')
      .bind(code, 'author', await passwordHash(password, env.AUTH_PEPPER), now()).run();
    return json(await newSession(env, code), 201);
  }
  if (method === 'POST' && (path === '/api/auth/login' || path === '/api/admin/login')) {
    await limit(env, `login:${ip}`, 12, 600_000);
    const body = await readJson(request, 4096);
    const admin = path === '/api/admin/login';
    const code = admin ? 'admin:' + String(body.username || '') : String(body.authorCode || '').trim().toUpperCase();
    if (code.length > 80 || typeof body.password !== 'string' || body.password.length > 128) fail(401, '账号或密码不正确');
    await limit(env, `login-code:${await sha256(code)}`, 25, 600_000);
    const row = await env.DB.prepare('SELECT * FROM authors WHERE code=? AND role=?').bind(code, admin ? 'admin' : 'author').first();
    const hash = await passwordHash(body.password, env.AUTH_PEPPER, row?.password_hash.split(':')[0] || '00000000000000000000000000000000');
    if (!row || !equal(hash, row.password_hash)) fail(401, '账号或密码不正确');
    return json(await newSession(env, code, admin));
  }
  if (method === 'POST' && path === '/api/auth/logout') {
    const token = request.headers.get('Authorization')?.replace(/^Bearer /, '') || '';
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256(token)).run();
    return json({ ok: true });
  }

  if (path === '/api/submissions') {
    const who = await principal(request, env, 'author');
    if (method === 'POST') return submit(request, env, who.code);
    if (method === 'GET') {
      return listSubmissions(env, url, who.code);
    }
  }
  const workMatch = path.match(/^\/api\/submissions\/([a-f0-9]{32})$/);
  if (workMatch) {
    const who = await principal(request, env, 'author');
    if (method === 'POST') return submit(request, env, who.code, workMatch[1]);
    if (method === 'DELETE') return remove(env, workMatch[1], who.code);
  }
  const fileMatch = path.match(/^\/api\/revisions\/([a-f0-9]{32})\/file$/);
  if (fileMatch && method === 'GET') {
    const who = await identity(request, env);
    if (!who) fail(401, '请先登录');
    const row = await env.DB.prepare(`SELECT r.* FROM revisions r JOIN submissions s ON s.id=r.submission_id
      WHERE r.id=? AND s.deleted_at IS NULL AND (s.author_code=? OR ?='admin') AND r.blob_key!=''`)
      .bind(fileMatch[1], who.code, who.role).first();
    if (!row) fail(404, '文件不存在');
    return download(env, row);
  }
  const coverMatch=path.match(/^\/api\/revisions\/([a-f0-9]{32})\/cover$/);
  if(coverMatch&&method==='GET'){
    await principal(request,env,'admin');
    const row=await env.DB.prepare('SELECT r.catalog_cover FROM revisions r JOIN submissions s ON s.id=r.submission_id WHERE r.id=? AND s.deleted_at IS NULL').bind(coverMatch[1]).first();
    if(!row?.catalog_cover)fail(404,'此版本没有公开封面');
    const cover=validateCatalogCover(row.catalog_cover);
    return new Response(Uint8Array.from(atob(cover.split(',')[1]),c=>c.charCodeAt(0)),{headers:{'Content-Type':cover.startsWith('data:image/png;')?'image/png':'image/webp'}});
  }
  const termsMatch=path.match(/^\/api\/submissions\/([a-f0-9]{32})\/terms$/);
  if(termsMatch&&method==='POST'){
    const who=await principal(request,env,'author'),body=await readJson(request,16384);
    // Metadata-only revisions always use this author's last APPROVED immutable file.
    // Never substitute a rejected/latest file, or accept a client-supplied public consent.
    const row=await env.DB.prepare(`SELECT s.latest_revision,s.pending_revision,s.catalog_hidden,r.* FROM submissions s
      JOIN revisions r ON r.id=s.published_revision
      WHERE s.id=? AND s.author_code=? AND s.deleted_at IS NULL AND r.status='approved'`).bind(termsMatch[1],who.code).first();
    if(!row)fail(404,'没有可修改协议的已发布作品');
    if(row.pending_revision||body.expectedRevision!==row.latest_revision)fail(409,'作品状态已变化或正在审核，请刷新后重试');
    if(!isRecord(body.terms)||Object.keys(body.terms).some(key=>!['allowRemix','allowRedistribute','bugFeedback','message'].includes(key)))fail(400,'只能修改二改、传播及反馈约定，公开展示请另行提交');
    let metadata;
    try{metadata=validateBeautyMetadata({...JSON.parse(row.metadata),...body.terms,...(row.catalog_hidden?{allowPublicListing:false}:{})});}catch(e){fail(400,(e as Error).message);}
    if(JSON.stringify(metadata)===JSON.stringify(validateBeautyMetadata(JSON.parse(row.metadata))))return json({id:termsMatch[1],revision:row.latest_revision,unchanged:true});
    const source=await env.FILES.get(row.blob_key);if(!source)fail(404,'原作品文件暂不可用，请稍后重试');
    const content=await new Response(source.body).text();
    if(new TextEncoder().encode(content).length!==row.bytes||await sha256(content)!==row.sha256)fail(409,'原作品文件校验失败，请联系管理员');
    const forwarded=new Request(request.url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({metadata,package:JSON.parse(content),catalogCover:row.catalog_cover,expectedRevision:body.expectedRevision,expectedCatalogHidden:row.catalog_hidden})});
    return submit(forwarded,env,who.code,termsMatch[1],true);
  }
  const visibility=path.match(/^\/api\/submissions\/([a-f0-9]{32})\/hide-catalog$/);
  if(visibility&&method==='POST'){
    const who=await principal(request,env,'author');
    const results=await catalogMutation(env, () => env.DB.batch([
      env.DB.prepare('UPDATE submissions SET catalog_hidden=1,updated_at=? WHERE id=? AND author_code=? AND deleted_at IS NULL').bind(now(),visibility[1],who.code),
      env.DB.prepare("UPDATE revisions SET metadata=json_set(metadata,'$.allowPublicListing',json('false')),catalog_cover='' WHERE id=(SELECT pending_revision FROM submissions WHERE id=? AND author_code=? AND deleted_at IS NULL) AND status='pending'").bind(visibility[1],who.code),
      dirtyCatalog(env),
    ]));
    if(!results[0].meta.changes)fail(404,'作品不存在');
    return json({ok:true});
  }
  if (path === '/api/admin/catalog' && (method === 'GET' || method === 'POST')) {
    await principal(request, env, 'admin');
    if (method === 'POST') {
      await catalogMutation(env, () => dirtyCatalog(env).run());
      return json({ queued: true });
    }
    return catalogJob(env, new Request('https://catalog.internal/status'));
  }
  if (path === '/api/admin/submissions' && method === 'GET') {
    await principal(request, env, 'admin');
    return listSubmissions(env, url);
  }
  if (path === '/api/repos' && method === 'POST') {
    let body;
    try { body = validateBeautyRepo(await readJson(request, 8192)); } catch (error) { if (error instanceof HttpError) throw error; return fail(400, (error as Error).message); }
    const requestKey = await sha256(env.AUTH_PEPPER + ':' + body.deviceId + ':' + body.requestId);
    const existing = await env.DB.prepare('SELECT id FROM beauty_repos WHERE request_key=?').bind(requestKey).first();
    if (existing) return json({ id: existing.id, received: true });
    const work = await env.DB.prepare(`SELECT s.id,r.metadata FROM submissions s JOIN revisions r ON r.submission_id=s.id
      WHERE s.share_code=? AND s.deleted_at IS NULL AND s.published_revision IS NOT NULL AND r.id=? AND r.status='approved'`).bind(body.code, body.revision).first();
    if (!work) fail(404, '这份美化已停止分享，暂不能代收 Repo');
    await limit(env, `repo-ip:${ip}`, 5, 86400_000);
    await limit(env, `repo-device:${await sha256(env.AUTH_PEPPER + body.deviceId)}`, 3, 86400_000);
    await limit(env, 'repo-global', 1000, 86400_000);
    const id = randomHex();
    await env.DB.prepare(`INSERT INTO beauty_repos(id,request_key,submission_id,revision_id,metadata,signature,message,created_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(request_key) DO NOTHING`).bind(id, requestKey, work.id, body.revision, work.metadata, body.signature, body.message, now()).run();
    const saved = await env.DB.prepare('SELECT id FROM beauty_repos WHERE request_key=?').bind(requestKey).first();
    return json({ id: saved?.id, received: true }, 201);
  }
  if (path === '/api/repo-inbox' && method === 'GET') {
    const author = await principal(request, env, 'author');
    const from = ` FROM submissions s JOIN beauty_repos f ON f.submission_id=s.id
      WHERE s.author_code=? AND f.inbox_delivered_at IS NOT NULL AND f.status='sent'`;
    const count = await env.DB.prepare('SELECT count(*) AS n' + from).bind(author.code).first();
    const total = Number(count?.n || 0);
    const offset = Math.min(pageOffset(url), Math.max(0, Math.ceil(total / PAGE_SIZE) - 1) * PAGE_SIZE);
    const { results } = await env.DB.prepare(`SELECT f.id, f.signature, f.message,
      json_extract(f.metadata,'$.name') AS workName, f.created_at AS writtenAt` + from +
      ' ORDER BY f.inbox_delivered_at DESC, f.created_at DESC, f.id DESC LIMIT ? OFFSET ?').bind(author.code, PAGE_SIZE, offset).all();
    return json({ repos: results, total, offset, pageSize: PAGE_SIZE, nextOffset: offset + PAGE_SIZE < total ? offset + PAGE_SIZE : null });
  }
  if (path === '/api/admin/repos' && method === 'GET') {
    await principal(request, env, 'admin');
    const status = url.searchParams.get('status') || 'pending';
    if (!['pending', 'sent', 'archived', 'all'].includes(status)) fail(400, '状态无效');
    const search = (url.searchParams.get('q') || '').trim().slice(0, 80);
    const clauses = ['1=1']; const args: unknown[] = [];
    if (status !== 'all') { clauses.push('f.status=?'); args.push(status); }
    if (search) { clauses.push("(instr(lower(s.author_code),lower(?))>0 OR instr(lower(s.share_code),lower(?))>0 OR instr(lower(json_extract(f.metadata,'$.name')),lower(?))>0)"); args.push(search, search, search); }
    const from = ' FROM beauty_repos f JOIN submissions s ON s.id=f.submission_id WHERE ' + clauses.join(' AND ');
    const count = await env.DB.prepare('SELECT count(*) AS n' + from).bind(...args).first();
    const total = Number(count?.n || 0); const offset = Math.min(pageOffset(url), Math.max(0, Math.ceil(total / PAGE_SIZE) - 1) * PAGE_SIZE);
    const { results } = await env.DB.prepare('SELECT f.id,f.signature,f.message,f.status,f.created_at,f.inbox_delivered_at,f.metadata,s.author_code,s.share_code' + from + ' ORDER BY f.created_at DESC,f.id DESC LIMIT ? OFFSET ?').bind(...args, PAGE_SIZE, offset).all();
    return json({ repos: results.map(row => ({ ...row, metadata: JSON.parse(row.metadata) })), total, offset, pageSize: PAGE_SIZE, nextOffset: offset + PAGE_SIZE < total ? offset + PAGE_SIZE : null });
  }
  const repoStatus = path.match(/^\/api\/admin\/repos\/([a-f0-9]{32})$/);
  if (repoStatus && method === 'POST') {
    await principal(request, env, 'admin'); const body = await readJson(request, 1024);
    if (body.action === 'deliver') {
      const deliveredAt = now();
      const updated = await env.DB.prepare(`UPDATE beauty_repos SET status='sent', handled_at=?, inbox_delivered_at=?
        WHERE id=? AND status='pending'`).bind(deliveredAt, deliveredAt, repoStatus[1]).run();
      if (!updated.meta.changes) {
        const row = await env.DB.prepare('SELECT inbox_delivered_at FROM beauty_repos WHERE id=?').bind(repoStatus[1]).first();
        if (!row) fail(404, 'Repo 不存在');
        if (!row.inbox_delivered_at) fail(409, '请先将这份 Repo 恢复为待审核，再投递');
      }
      return json({ ok: true });
    }
    if (!['pending', 'sent', 'archived'].includes(body.status)) fail(400, '状态无效');
    const result = await env.DB.prepare(`UPDATE beauty_repos SET status=?,handled_at=?,
      inbox_delivered_at=CASE WHEN ?='sent' THEN inbox_delivered_at ELSE NULL END WHERE id=?`)
      .bind(body.status, body.status === 'pending' ? null : now(), body.status, repoStatus[1]).run();
    if (!result.meta.changes) fail(404, 'Repo 不存在');
    return json({ ok: true });
  }
  const review = path.match(/^\/api\/admin\/revisions\/([a-f0-9]{32})\/review$/);
  if (review && method === 'POST') {
    await principal(request, env, 'admin');
    const body = await readJson(request, 4096);
    if (!['approved', 'rejected'].includes(body.decision) || typeof body.note !== 'string' || body.note.length > 1000 || (body.decision === 'rejected' && !body.note.trim())) fail(400, '请选择审核结果；退回需要填写原因（最多 1000 字）');
    const revision = review[1]; const code = 'S-' + randomHex(6).toUpperCase();
    const results = await catalogMutation(env, () => env.DB.batch([
      env.DB.prepare(`UPDATE revisions SET status=?,review_note=?,reviewed_at=? WHERE id=? AND status='pending'
        AND EXISTS(SELECT 1 FROM submissions WHERE pending_revision=? AND deleted_at IS NULL)`)
        .bind(body.decision, body.note.trim(), now(), revision, revision),
      env.DB.prepare(`UPDATE submissions SET pending_revision=NULL,updated_at=?,
        catalog_hidden=CASE WHEN ?='approved' THEN 0 ELSE catalog_hidden END,
        published_revision=CASE WHEN ?='approved' THEN ? ELSE published_revision END,
        share_code=CASE WHEN ?='approved' THEN COALESCE(share_code,?) ELSE share_code END
        WHERE pending_revision=? AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM revisions WHERE id=? AND status=?)`)
        .bind(now(), body.decision, body.decision, revision, body.decision, code, revision, revision, body.decision),
      dirtyCatalog(env),
    ]));
    if (!results[0].meta.changes) fail(409, '这份提交已处理或被删除，请刷新列表');
    return json({ ok: true });
  }
  const adminDelete = path.match(/^\/api\/admin\/submissions\/([a-f0-9]{32})$/);
  if (adminDelete && method === 'DELETE') { await principal(request, env, 'admin'); return remove(env, adminDelete[1]); }

  const share = path.match(/^\/api\/shares\/(S-[A-F0-9]{12})(\/file)?$/);
  if (share && method === 'GET') {
    const row = await env.DB.prepare(`SELECT r.*,s.kind,s.share_code FROM submissions s JOIN revisions r ON r.id=s.published_revision
      WHERE s.share_code=? AND s.deleted_at IS NULL AND r.status='approved'`).bind(share[1]).first();
    if (!row) fail(404, '美化码不存在或已停止分享');
    if (share[2]) {
      if (url.searchParams.get('revision') !== row.id) fail(409, '作者刚刚更新了作品，请重新查看说明后领取');
      return download(env, row);
    }
    return json({ code: row.share_code, kind: row.kind, revision: row.id, metadata: JSON.parse(row.metadata), bytes: row.bytes, sha256: row.sha256 });
  }
  return fail(404, '不存在的接口');
}

async function download(env: Env, row: any) {
  const object = await env.FILES.get(row.blob_key);
  if (!object) fail(404, '文件暂不可用，请联系管理员');
  return new Response(object.body, { headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="beauty-${row.id}.json"`,
    'Content-Length': String(object.size), 'X-Content-SHA256': row.sha256,
  } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let response: Response;
    try {
      response = request.method === 'OPTIONS' ? new Response(null, { status: 204 }) : await route(request, env);
    } catch (error) {
      response = json({ error: error instanceof HttpError ? error.message : '服务暂时不可用，请稍后重试' }, error instanceof HttpError ? error.status : 500);
    }
    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    headers.set('Access-Control-Expose-Headers', 'X-Content-SHA256');
    headers.set('Cache-Control', 'no-store');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    return new Response(response.body, { status: response.status, headers });
  },
  async scheduled(event: {cron?:string}, env: Env) {
    if(event.cron==='17 19 * * *')await cleanup(env);

  },
};
