/**
 * Memory Palace — Supabase pgvector 远程向量存储
 *
 * 用户在自己的 Supabase 项目里存储向量，本地保留完整记忆。
 * 使用原生 fetch 调用 PostgREST API，无需额外依赖。
 *
 * 数据归属：100% 在用户自己的 Supabase 项目，我们不碰不存。
 */

import type { RemoteVectorConfig, MemoryNode, MemoryVector } from './types';

import { MEMORY_NODES_CHANGED } from './nodeChanges';
import INIT_SQL from '../../docs/supabase-memory-vectors.sql?raw';
export { INIT_SQL };

// ─── Supabase REST helpers ───────────────────────────

function headers(config: RemoteVectorConfig): Record<string, string> {
    return {
        'apikey': config.supabaseAnonKey,
        'Authorization': `Bearer ${config.supabaseAnonKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
    };
}

function restUrl(config: RemoteVectorConfig, path: string): string {
    return `${config.supabaseUrl.replace(/\/+$/, '')}/rest/v1${path}`;
}

function rpcUrl(config: RemoteVectorConfig, fn: string): string {
    return `${config.supabaseUrl.replace(/\/+$/, '')}/rest/v1/rpc/${fn}`;
}

// ─── 公共 API ────────────────────────────────────────

const LEGACY_NODE_COLUMNS = 'memory_id,char_id,content,room,importance,tags,mood,valence,arousal,created_at,last_accessed_at,access_count,pinned_until,source_id,origin,archived,is_summary,event_box_id';
const EXTRA_COLUMNS = ['entities', 'relative_time_anchor', 'group_id', 'group_name', 'digested_at'] as const;
const NODE_COLUMNS = LEGACY_NODE_COLUMNS + ',' + EXTRA_COLUMNS.join(',');
const LEGACY_MODEL_PREFIX = 'sully-vector-meta-v1:';
type Layout = 'native' | 'legacy';
const layouts = new Map<string, Promise<Layout>>();
function layoutHint(config: RemoteVectorConfig): Layout | null {
    try {
        const hint = localStorage.getItem('palace_vector_layout_v1:' + projectKey(config));
        return hint === 'legacy' || hint === 'native' ? hint : null;
    } catch { return null; }
}

async function missingColumn(res: Response) {
    if (res.status !== 400) return false;
    const body = await res.clone().json().catch(() => null);
    return body?.code === '42703' || body?.code === 'PGRST204';
}

// The original table has a model text column. Preserve the model name inside
// a versioned envelope; older clients still see ordinary tags, text and vectors.
function unpackExtra(model: unknown): Record<string, unknown> {
    if (typeof model !== 'string' || !model.startsWith(LEGACY_MODEL_PREFIX)) return {};
    try {
        const data = JSON.parse(model.slice(LEGACY_MODEL_PREFIX.length)).extra;
        return Object.fromEntries(EXTRA_COLUMNS.filter(k => data?.[k] != null).map(k => [k, data[k]]));
    } catch { return {}; }
}

function compatibleRow(row: ReturnType<typeof uploadRow>, layout: Layout) {
    if (layout === 'native') return row;
    const { entities, relative_time_anchor, group_id, group_name, digested_at, ...legacy } = row;
    const extra = { entities, relative_time_anchor, group_id, group_name, digested_at };
    if (EXTRA_COLUMNS.some(k => extra[k] != null)) {
        legacy.model = LEGACY_MODEL_PREFIX + JSON.stringify({ model: row.model, extra });
    }
    return legacy;
}

async function detectLayout(config: RemoteVectorConfig): Promise<Layout> {
    for (const layout of ['native', 'legacy'] as const) {
        const columns = layout === 'native' ? NODE_COLUMNS : LEGACY_NODE_COLUMNS;
        const res = await fetch(restUrl(config, `/memory_vectors?select=${columns},dimensions,model,vector&limit=0`), {
            headers: headers(config),
            signal: AbortSignal.timeout(15000),
        });
        if (res.ok) return layout;
        if (layout === 'legacy' || !await missingColumn(res)) throw new Error(await failureMessage(res));
    }
    throw new Error('无法识别云表结构');
}

function getLayout(config: RemoteVectorConfig, refresh = false): Promise<Layout> {
    const key = ownerKey(config, '');
    let pending = layouts.get(key);
    if (!pending || refresh) {
        const hint = !refresh && layoutHint(config);
        pending = hint ? Promise.resolve(hint) : detectLayout(config).then(layout => {
            try { localStorage.setItem('palace_vector_layout_v1:' + projectKey(config), layout); } catch { /* cache only */ }
            return layout;
        });
        layouts.set(key, pending);
        pending.catch(() => { if (layouts.get(key) === pending) layouts.delete(key); });
    }
    return pending;
}

function idFilter(ids: string[]) {
    return 'in.(' + ids.map(id => JSON.stringify(id)).join(',') + ')';
}

async function failureMessage(res: Response): Promise<string> {
    const error = await res.json().catch(() => null);
    const code = typeof error?.code === 'string' && /^[A-Z0-9]{5,9}$/.test(error.code) ? error.code : '';
    const prefix = `HTTP ${res.status}${code ? ' · ' + code : ''}`;
    if (['PGRST202', 'PGRST204', 'PGRST205', '42703', '42P01', '42883'].includes(code) || res.status === 404)
        return `${prefix}：云表或检索函数不可用，请检查项目是否已完成初次配置`;
    if (res.status === 401 || res.status === 403 || code === '42501') return `${prefix}：请检查项目密钥和表的读写权限`;
    if (/dimension/i.test(error?.message || '')) return `${prefix}：向量实际维度与云表不符，请核对模型和云表维度`;
    if (res.status === 429) return `${prefix}：服务限流，请稍后重试`;
    if (res.status >= 500) return `${prefix}：云端服务暂时不可用`;
    return `${prefix}：云端拒绝请求，请查看 Supabase API 日志`;
}

function networkFailure(error: unknown): string {
    return error instanceof Error && /Timeout|Abort/.test(error.name)
        ? '请求超时，未收到云端确认' : '连接失败或响应被浏览器拦截，请检查网络后重试';
}

export async function testConnection(config: RemoteVectorConfig) {
    try {
        const layout = await getLayout(config, true);
        const probe = await fetch(rpcUrl(config, 'match_vectors') + '?select=memory_id,similarity', {
            method: 'POST', headers: headers(config), signal: AbortSignal.timeout(15000),
            body: JSON.stringify({ query_embedding: null, match_char_id: '', match_count: 0 }),
        });
        if (!probe.ok) return { ok: false, tableExists: true, message: await failureMessage(probe) };
        return { ok: true, tableExists: true, message: layout === 'legacy' ? '原有云表可直接使用，已启用兼容同步' : '云表与检索函数已就绪，写入结果见同步进度' };
    } catch (error) {
        return { ok: false, tableExists: false, message: error instanceof Error && error.message.startsWith('HTTP ') ? error.message : networkFailure(error) };
    }
}

/**
 * Decode local-vector storage forms safely for the wire format. After we
 * switched IndexedDB to Uint8Array(Float32 raw bytes), `instanceof Float32Array`
 * checks alone would silently miss Uint8Array and fall through to `.join`,
 * which would stringify the BYTES instead of the floats — corrupting every
 * remote upsert for hybrid (local+remote) users.
 */
function vectorToWireArray(vec: number[] | Float32Array | Uint8Array): number[] {
    if (vec instanceof Float32Array) return Array.from(vec);
    if (vec instanceof Uint8Array) {
        if (vec.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) throw new Error('本地向量字节不完整');
        const f32 = new Float32Array(vec.buffer, vec.byteOffset, vec.byteLength >>> 2);
        return Array.from(f32);
    }
    return vec;
}

export type VectorUpload = MemoryVector & { node: MemoryNode };

function uploadRow({ memoryId, charId, vector, node, model }: VectorUpload) {
    const vecArray = vectorToWireArray(vector);
    if (!vecArray.length || !vecArray.every(Number.isFinite)) throw new Error('本地向量无效');
    return {
        memory_id: memoryId,
        char_id: charId,
        content: node.content,
        vector: `[${vecArray.join(',')}]`,
        dimensions: vecArray.length,
        model: model || null,
        room: node.room,
        importance: node.importance,
        tags: node.tags,
        mood: node.mood,
        valence: typeof node.valence === 'number' ? node.valence : null,
        arousal: typeof node.arousal === 'number' ? node.arousal : null,
        created_at: node.createdAt,
        last_accessed_at: node.lastAccessedAt || node.createdAt,
        access_count: node.accessCount || 0,
        pinned_until: node.pinnedUntil ?? null,
        source_id: node.sourceId ?? null,
        origin: node.origin ?? null,
        entities: node.entities ?? null,
        relative_time_anchor: node.relativeTimeAnchor ?? null,
        group_id: node.groupId ?? null,
        group_name: node.groupName ?? null,
        digested_at: node.digestedAt ?? null,
        archived: !!node.archived,
        is_summary: !!node.isBoxSummary,
        event_box_id: node.eventBoxId ?? null,
    };
}

async function writeBatch(config: RemoteVectorConfig, items: VectorUpload[], insertOnly = false): Promise<string | null> {
    let rows: ReturnType<typeof uploadRow>[];
    try { rows = items.map(uploadRow); } catch { return '本地向量数据无效，无法上传'; }
    const send = (layout: Layout) => fetch(restUrl(config, '/memory_vectors'), {
        method: 'POST', signal: AbortSignal.timeout(30000),
        headers: { ...headers(config), 'Prefer': `resolution=${insertOnly ? 'ignore' : 'merge'}-duplicates,return=minimal` },
        body: JSON.stringify(rows.map(row => compatibleRow(row, layout))),
    });
    try {
        const layout = await (layouts.get(ownerKey(config, '')) ?? layoutHint(config) ?? 'native');
        let res = await send(layout);
        if (layout === 'native' && await missingColumn(res)) {
            const detected = await getLayout(config, true);
            if (detected === 'legacy') res = await send(detected);
        }
        return res.ok ? null : await failureMessage(res);
    } catch (error) {
        return error instanceof Error && error.message.startsWith('HTTP ') ? error.message : networkFailure(error);
    }
}

// An automatic edit can arrive while a manual page is uploading. Serialize only
// overlapping IDs, and read a manual page after earlier writes for those IDs settle.
const pendingWrites = new Map<string, Promise<void>>();
async function withWriteOrder<T>(config: RemoteVectorConfig, ids: IDBValidKey[], action: () => Promise<T>): Promise<T> {
    const keys = ids.map(id => JSON.stringify([projectKey(config), id]));
    const prior = keys.map(key => pendingWrites.get(key));
    const run = Promise.all(prior).then(action);
    const settled = run.then(() => {}, () => {});
    for (const key of keys) pendingWrites.set(key, settled);
    try { return await run; } finally {
        for (const key of keys) if (pendingWrites.get(key) === settled) pendingWrites.delete(key);
    }
}

export async function upsertVector(
    config: RemoteVectorConfig, memoryId: string, charId: string,
    vector: MemoryVector['vector'], node: MemoryNode, dimensions: number, model?: string,
): Promise<boolean> {
    return upsertVectorBatch(config, [{ memoryId, charId, vector, node, dimensions, model }]);
}

export async function upsertVectorBatch(config: RemoteVectorConfig, items: VectorUpload[]): Promise<boolean> {
    if (!items.length) return true;
    return withWriteOrder(config, items.map(item => item.memoryId), async () => {
        const error = await writeBatch(config, items);
        recordRemoteWrite(config, items, error);
        return !error;
    });
}

/**
 * 向量相似度搜索（调用 match_vectors RPC 函数）
 *
 * ⚠️ 错误传播：网络错误（CORS / fetch 抛 TypeError）/ HTTP 非 2xx 都会向上 throw，
 * 不再静默返回空数组。这样上层（vectorSearch.ts）才能分辨"远程挂了→禁用本会话远程路径"
 * 和"远程正常但这次没命中→返回空"。之前的 catch{ return [] } 导致每次查询都
 * 踩一遍 CORS + 回退到本地 getAllByCharId，造成迁移批量查询时 15 次重复加载全量向量。
 */
export async function searchVectors(
    config: RemoteVectorConfig,
    queryVector: number[] | Float32Array | Uint8Array,
    charId: string,
    threshold: number = 0.3,
    topK: number = 20,
): Promise<{ node: MemoryNode; similarity: number }[]> {
    const vecArray = vectorToWireArray(queryVector);

    const res = await fetch(rpcUrl(config, 'match_vectors'), {
        method: 'POST', signal: AbortSignal.timeout(15000),
        headers: headers(config),
        body: JSON.stringify({
            query_embedding: `[${vecArray.join(',')}]`,
            match_char_id: charId,
            match_threshold: threshold,
            match_count: topK,
        }),
    });

    if (!res.ok) {
        throw new Error(`match_vectors ${await failureMessage(res)}`);
    }

    const data = await res.json();
    if (!Array.isArray(data) || !data.length) return [];
    // A historical matcher ranks the same vectors but doesn't return the extra fields.
    if (data.some(row => !('entities' in row) || (!('model' in row) && EXTRA_COLUMNS.every(k => row[k] == null)))) {
        const layout = await getLayout(config);
        const params = new URLSearchParams({
            select: (layout === 'legacy' ? 'memory_id' : 'memory_id,' + EXTRA_COLUMNS.join(',')) + ',model',
            memory_id: idFilter(data.map(row => row.memory_id)), char_id: 'eq.' + charId,
        });
        const meta = await fetch(restUrl(config, '/memory_vectors?' + params), {
            headers: headers(config), signal: AbortSignal.timeout(15000),
        });
        if (!meta.ok) throw new Error(await failureMessage(meta));
        const extras = new Map<string, object>((await meta.json()).map((row: any) => [row.memory_id, row]));
        for (const row of data) Object.assign(row, extras.get(row.memory_id));
    }
    return data.map((row: any) => ({ node: remoteNode(row), similarity: row.similarity }));
}

function remoteNode(row: any): MemoryNode {
    for (const [key, value] of Object.entries(unpackExtra(row.model))) row[key] ??= value;
    return {
        id: row.memory_id,
        charId: row.char_id,
        content: row.content || '',
        room: row.room,
        tags: row.tags || [],
        importance: row.importance ?? 5,
        mood: row.mood || '',
        valence: typeof row.valence === 'number' ? row.valence : undefined,
        arousal: typeof row.arousal === 'number' ? row.arousal : undefined,
        entities: Array.isArray(row.entities) ? row.entities : undefined,
        relativeTimeAnchor: row.relative_time_anchor ?? undefined,
        groupId: row.group_id ?? undefined,
        groupName: row.group_name ?? undefined,
        digestedAt: row.digested_at == null ? undefined : Number(row.digested_at),
        embedded: true, // 远程就是向量表，默认视为已 embedded
        createdAt: Number(row.created_at) || 0,
        lastAccessedAt: Number(row.last_accessed_at) || 0,
        accessCount: Number(row.access_count) || 0,
        pinnedUntil: row.pinned_until != null ? Number(row.pinned_until) : null,
        sourceId: row.source_id ?? null,
        origin: row.origin ?? undefined,
        archived: !!row.archived,
        isBoxSummary: !!row.is_summary,
        eventBoxId: row.event_box_id ?? null,
    };
}

/**
 * 按房间直接拉取远程记忆（PostgREST 过滤，不跑向量相似度）。
 * 用于"本地没有向量记忆但远程有"的场景，比如记忆潜行要在客厅/卧室里
 * 展示该脑区有哪些记忆时，直接按 room 列查远端就够了。
 *
 * 返回 MemoryNode 形状，方便调用方与本地结果合并/去重。
 */
export async function fetchRemoteByRoom(
    config: RemoteVectorConfig,
    charId: string,
    room: string,
    limit: number = 50,
): Promise<MemoryNode[]> {
    try {
        const known = layoutHint(config);
        const params = new URLSearchParams({
            select: (known === 'legacy' ? LEGACY_NODE_COLUMNS : NODE_COLUMNS) + ',model',
            char_id: `eq.${charId}`,
            room: `eq.${room}`,
            archived: 'eq.false',
            order: 'importance.desc,last_accessed_at.desc',
            limit: String(limit),
        });
        const readRoom = () => fetch(restUrl(config, `/memory_vectors?${params}`), {
            headers: headers(config), signal: AbortSignal.timeout(15000),
        });
        let res = await readRoom();
        if (res.status === 400) {
            const error = await res.json().catch(() => null);
            if (error?.code !== '42703' && error?.code !== 'PGRST204') return [];
            params.set('select', LEGACY_NODE_COLUMNS + ',model');
            res = await readRoom();
        }
        if (!res.ok) return [];
        const rows = await res.json();
        return (rows || []).map(remoteNode);
    } catch {
        return [];
    }
}

/**
 * 批量把一组向量标记为 archived（EventBox 压缩时用）
 * 通过 PATCH 单发多 ID，避免 N 次 upsert
 */
export async function bulkSetArchived(
    config: RemoteVectorConfig,
    memoryIds: string[],
    archived: boolean,
): Promise<boolean> {
    if (memoryIds.length === 0) return true;
    try {
        // PostgREST `in.(...)` filter
        const idList = memoryIds.map(id => encodeURIComponent(id)).join(',');
        const res = await fetch(restUrl(config, `/memory_vectors?memory_id=in.(${idList})`), {
            method: 'PATCH',
            headers: {
                ...headers(config),
                'Prefer': 'return=minimal',
            },
            body: JSON.stringify({ archived }),
        });
        return res.ok;
    } catch {
        return false;
    }
}

/**
 * 批量把一组向量的 room 字段改成同一个值（consolidation 晋升/驱逐时用）
 * promotion 全部 → bedroom，eviction 全部 → attic，所以只需两次 PATCH。
 *
 * 注意：只改 memory_vectors.room，content / importance / 向量本身都不动。
 * 所以即便 memory_id 在远端不存在（用户后启用云同步，老节点只在本地），
 * PATCH 也只是 no-op 更新 0 行，不会造成数据污染。
 */
export async function bulkSetRoom(
    config: RemoteVectorConfig,
    memoryIds: string[],
    room: string,
): Promise<boolean> {
    if (memoryIds.length === 0) return true;
    try {
        const idList = memoryIds.map(id => encodeURIComponent(id)).join(',');
        const res = await fetch(restUrl(config, `/memory_vectors?memory_id=in.(${idList})`), {
            method: 'PATCH',
            headers: {
                ...headers(config),
                'Prefer': 'return=minimal',
            },
            body: JSON.stringify({ room }),
        });
        return res.ok;
    } catch {
        return false;
    }
}

/**
 * 删除向量
 */
/** Account deletion must never use the whole-table wipe on a shared remote database. */
export async function deleteCharacterVectors(config: RemoteVectorConfig, charId: string): Promise<void> {
    if (!charId) throw new Error('缺少远程记忆归属');
    const params = new URLSearchParams({ char_id: `eq.${charId}` });
    const response = await fetch(restUrl(config, `/memory_vectors?${params}`), {
        method: 'DELETE', headers: headers(config), signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`远程记忆清理失败（${response.status}），本地存档已保留，请重试`);
}

export async function deleteVector(config: RemoteVectorConfig, memoryId: string): Promise<boolean> {
    try {
        const res = await fetch(restUrl(config, `/memory_vectors?memory_id=eq.${encodeURIComponent(memoryId)}`), {
            method: 'DELETE',
            headers: headers(config),
        });
        return res.ok;
    } catch {
        return false;
    }
}

/**
 * 获取远程向量数量（用于 UI 显示）
 */
export async function getVectorCount(config: RemoteVectorConfig, charId?: string): Promise<number | null> {
    try {
        const filter = charId ? `&char_id=eq.${encodeURIComponent(charId)}` : '';
        const res = await fetch(restUrl(config, `/memory_vectors?select=memory_id${filter}`), {
            method: 'HEAD', signal: AbortSignal.timeout(15000),
            headers: {
                ...headers(config),
                'Prefer': 'count=exact',
            },
        });
        if (!res.ok) return null;
        const range = res.headers.get('content-range');
        if (range) {
            const match = range.match(/^(?:\*|\d+-\d+)\/(\d+)$/);
            if (match) return parseInt(match[1], 10);
        }
        return null;
    } catch {
        return null;
    }
}

type CoverageCheck = { confirmed?: boolean; charId: string; until: number; ready: Promise<boolean> };
const coverage = new Map<string, CoverageCheck>();
const projectKey = (config: RemoteVectorConfig) => config.supabaseUrl.replace(/\/+$/, '');
const ownerKey = (config: RemoteVectorConfig, charId: string) => JSON.stringify([projectKey(config), config.supabaseAnonKey, charId]);

// localStorage already belongs to the session's user space. Credentials stay in memory.
const incompleteKey = (config: RemoteVectorConfig) => 'palace_vector_backfill:' + projectKey(config);
const incomplete = new Map<string, string>();
function setIncomplete(config: RemoteVectorConfig): string {
    const key = incompleteKey(config);
    const token = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    try { localStorage.setItem(key, token); incomplete.delete(key); } catch { incomplete.set(key, token); }
    return token;
}
function incompleteToken(config: RemoteVectorConfig): string | null {
    const key = incompleteKey(config);
    try { return incomplete.get(key) ?? localStorage.getItem(key); } catch { return incomplete.get(key) ?? null; }
}
function recordRemoteWrite(config: RemoteVectorConfig, items: VectorUpload[], error: string | null) {
    for (const item of items) {
        const key = ownerKey(config, item.charId);
        if (!coverage.get(key)?.confirmed) coverage.delete(key);
    }
    if (error) {
        setIncomplete(config);
        invalidateRemoteCoverage();
    }
}

async function checkCoverage(config: RemoteVectorConfig, charId: string): Promise<boolean> {
    const { MemoryNodeDB } = await import('./db');
    const nodes = await MemoryNodeDB.getByCharId(charId);
    const missing = new Set(nodes.filter(n => n.embedded).map(n => n.id));
    if (!missing.size) return true; // A remote-only character still needs cloud recall.
    if (incompleteToken(config)) return false;
    const params = new URLSearchParams({ select: 'memory_id', char_id: 'eq.' + charId, order: 'memory_id.asc', limit: '1000' });
    let after: string | undefined;
    while (missing.size) {
        if (after) params.set('memory_id', 'gt.' + after);
        const res = await fetch(restUrl(config, '/memory_vectors?' + params), {
            headers: headers(config), signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return false;
        const rows = await res.json();
        if (!Array.isArray(rows) || !rows.length) return false;
        const last = rows[rows.length - 1]?.memory_id;
        if (typeof last !== 'string' || !last || last === after) return false;
        after = last;
        for (const row of rows) missing.delete(row.memory_id);
    }
    return !incompleteToken(config);
}

export async function remoteCoversLocal(config: RemoteVectorConfig, charId: string): Promise<boolean> {
    const key = ownerKey(config, charId);
    let check = coverage.get(key);
    if (!check || check.until <= Date.now()) {
        check = { charId, ready: checkCoverage(config, charId).catch(() => false), until: Date.now() + 60000 };
        coverage.set(key, check);
    }
    check.confirmed = await check.ready;
    return check.confirmed && coverage.get(key) === check;
}

export function invalidateRemoteCoverage(charId?: string) {
    for (const [key, entry] of coverage) {
        if (!charId || entry.charId === charId) coverage.delete(key);
    }
}

if (typeof window !== 'undefined') {
    window.addEventListener(MEMORY_NODES_CHANGED, event => invalidateRemoteCoverage((event as CustomEvent).detail?.charId));
    window.addEventListener('storage', event => {
        if (!event.key || event.key.includes('palace_vector_backfill:')) invalidateRemoteCoverage();
    });
}

function clearIncomplete(config: RemoteVectorConfig, token: string) {
    if (incompleteToken(config) !== token) return;
    incomplete.delete(incompleteKey(config));
    try { localStorage.removeItem(incompleteKey(config)); } catch { /* unavailable */ }
}

export interface VectorSyncProgress {
    running: boolean;
    total: number;
    synced: number;
    failed: number;
    uploading: number;
    reason: string;
}
const syncResults = new Map<string, VectorSyncProgress>();
const syncListeners = new Set<() => void>();
export function subscribeVectorSync(listener: () => void) {
    syncListeners.add(listener);
    return () => { syncListeners.delete(listener); };
}
export function getVectorSyncProgress(config: RemoteVectorConfig) {
    return syncResults.get(ownerKey(config, ''));
}

export async function syncLocalToRemote(config: RemoteVectorConfig): Promise<VectorSyncProgress> {
    const key = ownerKey(config, '');
    if (syncResults.get(key)?.running) throw new Error('正在同步本地向量');
    const progress: VectorSyncProgress = { running: true, total: 0, synced: 0, failed: 0, uploading: 0, reason: '' };
    function publish() {
        syncResults.set(key, { ...progress });
        for (const listener of syncListeners) listener();
    }
    const token = setIncomplete(config);
    invalidateRemoteCoverage();
    publish();
    try {
        const { getUploadKeys, getUploadPage } = await import('./db');
        const keys = await getUploadKeys();
        progress.total = keys.length;
        publish();
        for (let i = 0; i < keys.length; i += 50) {
            const pageKeys = keys.slice(i, i + 50);
            const error = await withWriteOrder(config, pageKeys, async () => {
                const items = await getUploadPage(pageKeys);
                const missing = pageKeys.length - items.length;
                progress.failed += missing;
                if (missing) progress.reason = '部分向量缺少匹配的本地正文或归属，已跳过';
                if (!items.length) return null;
                progress.uploading = items.length;
                publish();
                const failure = await writeBatch(config, items);
                progress.uploading = 0;
                if (failure) progress.failed += items.length;
                else progress.synced += items.length;
                return failure;
            });
            if (error) {
                progress.reason = error;
                break;
            }
            publish();
        }
        if (!progress.failed) {
            clearIncomplete(config, token);
            try { localStorage.setItem(upgradeKey(config), '{"done":true}'); } catch { /* optional receipt */ }
        }
    } catch {
        progress.reason = '读取本地向量失败，本次同步已停止';
    } finally {
        invalidateRemoteCoverage();
        progress.uploading = 0;
        progress.running = false;
        publish();
    }
    return progress;
}

/** One release migration per project in the device's current user space.
 * Resume only confirmed pages. Manual sync remains the explicit overwrite path. */
export const upgradeKey = (config: RemoteVectorConfig) => 'palace_vector_upgrade_v1:' + projectKey(config);
export interface UpgradeReceipt { last?: string; done?: boolean; divergent?: boolean }
export function readUpgrade(config: RemoteVectorConfig): UpgradeReceipt {
    try { return JSON.parse(localStorage.getItem(upgradeKey(config)) || '{}') || {}; } catch { return {}; }
}

async function upgradePage(config: RemoteVectorConfig, items: VectorUpload[], layout: Layout, signal: AbortSignal) {
    if (!items.length) return false;
    signal.throwIfAborted();
    const select = 'memory_id,char_id,content,model,dimensions,created_at' + (layout === 'native' ? ',' + EXTRA_COLUMNS.join(',') : '');
    const params = new URLSearchParams({ select, memory_id: idFilter(items.map(i => i.memoryId)) });
    const res = await fetch(restUrl(config, '/memory_vectors?' + params), { headers: headers(config), signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(await failureMessage(res));
    const existing = new Map<string, any>((await res.json()).map((r: any) => [r.memory_id, r]));
    const absent = items.filter(item => !existing.has(item.memoryId));
    if (absent.length) {
        signal.throwIfAborted();
        const failure = await writeBatch(config, absent, true);
        if (failure) throw new Error(failure);
    }

    let divergent = false;
    for (const item of items) {
        signal.throwIfAborted();
        const row = existing.get(item.memoryId);
        if (!row) continue;
        if (row.char_id !== item.charId || row.content !== item.node.content) { divergent = true; continue; }
        const extra = {
            entities: item.node.entities, relative_time_anchor: item.node.relativeTimeAnchor,
            group_id: item.node.groupId, group_name: item.node.groupName, digested_at: item.node.digestedAt,
        };
        const stored = unpackExtra(row.model);
        const missing = EXTRA_COLUMNS.filter(k => extra[k] != null && row[k] == null && stored[k] == null);
        if (!missing.length) continue;
        const patch = Object.fromEntries(missing.map(k => [k, extra[k]]));
        const where = new URLSearchParams({ select: 'memory_id', memory_id: 'eq.' + item.memoryId, char_id: 'eq.' + item.charId });
        // Never replace existing remote content, vector, model choice or another client's metadata.
        let body: object = patch;
        if (layout === 'legacy') {
            // An existing envelope already belongs to another writer. Never put its private payload in a URL.
            if (typeof row.model === 'string' && row.model.startsWith(LEGACY_MODEL_PREFIX)) { divergent = true; continue; }
            where.set('model', row.model == null ? 'is.null' : 'eq.' + row.model);
            body = { model: LEGACY_MODEL_PREFIX + JSON.stringify({ model: row.model, extra: patch }) };
        } else {
            for (const field of missing) where.set(field, 'is.null');
        }
        const patched = await fetch(restUrl(config, '/memory_vectors?' + where), {
            method: 'PATCH', headers: { ...headers(config), Prefer: 'return=representation' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
        });
        if (!patched.ok) throw new Error(await failureMessage(patched));
        if (!(await patched.json()).some((r: any) => r.memory_id === item.memoryId)) {
            throw new Error('云端未确认元数据更新，请检查写入权限或稍后重试');
        }
    }
    return divergent;
}

export async function upgradeRemoteVectors(config: RemoteVectorConfig, signal: AbortSignal,
    onProgress: (checked: number, total: number) => void) {
    if (!config.enabled || !config.initialized || !config.supabaseUrl || !config.supabaseAnonKey) return;
    const receipt = readUpgrade(config);
    if (receipt.done) return;
    const { getUploadKeys, getUploadPage } = await import('./db');
    const keys = await getUploadKeys();
    signal.throwIfAborted();
    if (keys.length) {
        const token = setIncomplete(config);
        invalidateRemoteCoverage();
        let i = receipt.last ? keys.findIndex(k => indexedDB.cmp(k, receipt.last!) > 0) : 0;
        if (i < 0) i = keys.length;
        onProgress(i, keys.length);
        const layout = await getLayout(config);
        while (i < keys.length) {
            signal.throwIfAborted();
            const page = keys.slice(i, i + 50);
            const divergent = await withWriteOrder(config, page, async () =>
                upgradePage(config, await getUploadPage(page), layout, signal));
            signal.throwIfAborted();
            receipt.divergent ||= divergent;
            receipt.last = String(page[page.length - 1]);
            localStorage.setItem(upgradeKey(config), JSON.stringify(receipt));
            i += page.length;
            onProgress(i, keys.length);
        }
        if (!receipt.divergent) clearIncomplete(config, token);
        invalidateRemoteCoverage();
    }
    localStorage.setItem(upgradeKey(config), JSON.stringify({ done: true, divergent: receipt.divergent }));
}
