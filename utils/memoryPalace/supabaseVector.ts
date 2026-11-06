/**
 * Memory Palace — Supabase pgvector 远程向量存储
 *
 * 用户在自己的 Supabase 项目里存储向量，本地只做缓存。
 * 使用原生 fetch 调用 PostgREST API，无需额外依赖。
 *
 * 数据归属：100% 在用户自己的 Supabase 项目，我们不碰不存。
 */

import type { RemoteVectorConfig, MemoryNode } from './types';

// ─── 初始化 SQL（用户需在 Supabase SQL Editor 运行一次） ──

export const INIT_SQL = `
-- 1. 启用 pgvector 扩展
create extension if not exists vector;

-- 2. 创建向量表
create table if not exists memory_vectors (
  memory_id text primary key,
  char_id text not null,
  content text not null default '',
  vector vector(1024),
  dimensions int default 1024,
  model text,
  room text,
  importance int default 5,
  tags text[] default '{}',
  mood text default '',
  -- Russell 情感空间（可空；老数据由本地 MOOD_TO_VA 查表兜底）
  valence real default null,
  arousal real default null,
  created_at bigint default (extract(epoch from now()) * 1000)::bigint,
  last_accessed_at bigint default 0,
  access_count int default 0,
  -- 便利贴置顶截止（ms timestamp，null = 不置顶）
  pinned_until bigint default null,
  -- 消化衍生记忆的源 + 来源标签
  source_id text default null,
  origin text default null,
  -- EventBox 扩展列
  archived boolean default false,       -- 被压入 box summary 的活节点打标，搜索时过滤
  is_summary boolean default false,     -- 此行本身是 box summary（参与搜索，但展开逻辑不同）
  event_box_id text default null        -- 所属 EventBox.id；null = 独立记忆
);

-- 2b. 兼容升级：已有表添加新列（幂等，不影响新表）
alter table memory_vectors add column if not exists last_accessed_at bigint default 0;
alter table memory_vectors add column if not exists access_count int default 0;
alter table memory_vectors add column if not exists archived boolean default false;
alter table memory_vectors add column if not exists is_summary boolean default false;
alter table memory_vectors add column if not exists event_box_id text default null;
alter table memory_vectors add column if not exists valence real default null;
alter table memory_vectors add column if not exists arousal real default null;
alter table memory_vectors add column if not exists pinned_until bigint default null;
alter table memory_vectors add column if not exists source_id text default null;
alter table memory_vectors add column if not exists origin text default null;

-- 3. 创建索引
create index if not exists idx_mv_char_id on memory_vectors(char_id);
create index if not exists idx_mv_hnsw on memory_vectors
  using hnsw (vector vector_cosine_ops);
create index if not exists idx_mv_event_box_id on memory_vectors(event_box_id)
  where event_box_id is not null;
create index if not exists idx_mv_archived on memory_vectors(archived);

-- 4. 相似度搜索函数（先 drop 旧版，因为返回类型变更时 replace 不允许）
drop function if exists match_vectors(vector, text, float, int);
create or replace function match_vectors(
  query_embedding vector(1024),
  match_char_id text,
  match_threshold float default 0.3,
  match_count int default 20
)
returns table (
  memory_id text,
  char_id text,
  content text,
  similarity float,
  room text,
  importance int,
  tags text[],
  mood text,
  valence real,
  arousal real,
  created_at bigint,
  last_accessed_at bigint,
  access_count int,
  pinned_until bigint,
  source_id text,
  origin text,
  archived boolean,
  is_summary boolean,
  event_box_id text
)
language sql stable
as $$
  select
    mv.memory_id,
    mv.char_id,
    mv.content,
    1 - (mv.vector <=> query_embedding) as similarity,
    mv.room,
    mv.importance,
    mv.tags,
    mv.mood,
    mv.valence,
    mv.arousal,
    mv.created_at,
    mv.last_accessed_at,
    mv.access_count,
    mv.pinned_until,
    mv.source_id,
    mv.origin,
    mv.archived,
    mv.is_summary,
    mv.event_box_id
  from memory_vectors mv
  where mv.char_id = match_char_id
    and coalesce(mv.archived, false) = false  -- 过滤已归档节点
    and 1 - (mv.vector <=> query_embedding) > match_threshold
  order by mv.vector <=> query_embedding
  limit match_count;
$$;

-- 5. 行级安全（允许 anon key 完全访问 — 这是用户自己的数据库）
alter table memory_vectors enable row level security;
drop policy if exists "Allow all access" on memory_vectors;
create policy "Allow all access" on memory_vectors
  for all using (true) with check (true);
`.trim();

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

/**
 * 测试连接 + 检测表是否存在
 */
export async function testConnection(config: RemoteVectorConfig): Promise<{
    ok: boolean;
    tableExists: boolean;
    message: string;
}> {
    try {
        const res = await fetch(restUrl(config, '/memory_vectors?select=memory_id&limit=1'), {
            headers: headers(config),
        });

        if (res.status === 200) {
            return { ok: true, tableExists: true, message: '连接成功，表已就绪' };
        }
        if (res.status === 404 || res.status === 406) {
            // Table doesn't exist — PostgREST returns 404 or specific error
            return { ok: true, tableExists: false, message: '连接成功，但表尚未创建（请运行初始化 SQL）' };
        }
        if (res.status === 401) {
            return { ok: false, tableExists: false, message: '认证失败：请检查 anon key' };
        }
        const body = await res.text().catch(() => '');
        // Check for "relation does not exist" error
        if (body.includes('does not exist') || body.includes('relation')) {
            return { ok: true, tableExists: false, message: '连接成功，但表尚未创建（请运行初始化 SQL）' };
        }
        return { ok: false, tableExists: false, message: `服务器返回 ${res.status}: ${body.slice(0, 100)}` };
    } catch (e: any) {
        return { ok: false, tableExists: false, message: `连接失败: ${e.message}` };
    }
}

/**
 * 插入或更新向量（upsert）
 */
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
        const f32 = new Float32Array(vec.buffer, vec.byteOffset, vec.byteLength >>> 2);
        return Array.from(f32);
    }
    return vec;
}

export async function upsertVector(
    config: RemoteVectorConfig,
    memoryId: string,
    charId: string,
    vector: number[] | Float32Array | Uint8Array,
    node: MemoryNode,
    dimensions: number,
    model?: string,
): Promise<boolean> {
    try {
        const vecArray = vectorToWireArray(vector);
        const body = {
            memory_id: memoryId,
            char_id: charId,
            content: node.content,
            vector: `[${vecArray.join(',')}]`,
            dimensions,
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
            archived: !!node.archived,
            is_summary: !!node.isBoxSummary,
            event_box_id: node.eventBoxId ?? null,
        };

        const res = await fetch(restUrl(config, '/memory_vectors'), {
            method: 'POST',
            headers: {
                ...headers(config),
                'Prefer': 'resolution=merge-duplicates,return=minimal',
            },
            body: JSON.stringify(body),
        });

        return res.ok;
    } catch {
        return false;
    }
}

/**
 * 批量插入向量
 */
export async function upsertVectorBatch(
    config: RemoteVectorConfig,
    items: {
        memoryId: string;
        charId: string;
        vector: number[] | Float32Array | Uint8Array;
        node: MemoryNode;
        dimensions: number;
        model?: string;
    }[],
): Promise<boolean> {
    if (items.length === 0) return true;
    try {
        const body = items.map(item => {
            const vecArray = vectorToWireArray(item.vector);
            return {
                memory_id: item.memoryId,
                char_id: item.charId,
                content: item.node.content,
                vector: `[${vecArray.join(',')}]`,
                dimensions: item.dimensions,
                model: item.model || null,
                room: item.node.room,
                importance: item.node.importance,
                tags: item.node.tags,
                mood: item.node.mood,
                valence: typeof item.node.valence === 'number' ? item.node.valence : null,
                arousal: typeof item.node.arousal === 'number' ? item.node.arousal : null,
                created_at: item.node.createdAt,
                last_accessed_at: item.node.lastAccessedAt || item.node.createdAt,
                access_count: item.node.accessCount || 0,
                pinned_until: item.node.pinnedUntil ?? null,
                source_id: item.node.sourceId ?? null,
                origin: item.node.origin ?? null,
                archived: !!item.node.archived,
                is_summary: !!item.node.isBoxSummary,
                event_box_id: item.node.eventBoxId ?? null,
            };
        });

        const res = await fetch(restUrl(config, '/memory_vectors'), {
            method: 'POST',
            headers: {
                ...headers(config),
                'Prefer': 'resolution=merge-duplicates,return=minimal',
            },
            body: JSON.stringify(body),
        });

        return res.ok;
    } catch {
        return false;
    }
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
): Promise<{
    memoryId: string;
    content: string;
    similarity: number;
    room: string;
    importance: number;
    tags: string[];
    mood: string;
    valence: number | null;
    arousal: number | null;
    createdAt: number;
    lastAccessedAt: number;
    accessCount: number;
    pinnedUntil: number | null;
    sourceId: string | null;
    origin: string | null;
    archived: boolean;
    isSummary: boolean;
    eventBoxId: string | null;
}[]> {
    const vecArray = vectorToWireArray(queryVector);

    const res = await fetch(rpcUrl(config, 'match_vectors'), {
        method: 'POST',
        headers: headers(config),
        body: JSON.stringify({
            query_embedding: `[${vecArray.join(',')}]`,
            match_char_id: charId,
            match_threshold: threshold,
            match_count: topK,
        }),
    });

    if (!res.ok) {
        throw new Error(`match_vectors HTTP ${res.status}`);
    }

    const data = await res.json();
    return (data || []).map((row: any) => ({
        memoryId: row.memory_id,
        content: row.content,
        similarity: row.similarity,
        room: row.room,
        importance: row.importance,
        tags: row.tags || [],
        mood: row.mood || '',
        valence: typeof row.valence === 'number' ? row.valence : null,
        arousal: typeof row.arousal === 'number' ? row.arousal : null,
        createdAt: Number(row.created_at) || 0,
        lastAccessedAt: Number(row.last_accessed_at) || 0,
        accessCount: Number(row.access_count) || 0,
        pinnedUntil: row.pinned_until != null ? Number(row.pinned_until) : null,
        sourceId: row.source_id ?? null,
        origin: row.origin ?? null,
        archived: !!row.archived,
        isSummary: !!row.is_summary,
        eventBoxId: row.event_box_id ?? null,
    }));
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
        const params = new URLSearchParams({
            select: 'memory_id,char_id,content,room,importance,tags,mood,valence,arousal,created_at,last_accessed_at,access_count,pinned_until,source_id,origin,archived,is_summary,event_box_id',
            char_id: `eq.${charId}`,
            room: `eq.${room}`,
            archived: 'eq.false',
            order: 'importance.desc,last_accessed_at.desc',
            limit: String(limit),
        });
        const res = await fetch(restUrl(config, `/memory_vectors?${params.toString()}`), {
            headers: headers(config),
        });
        if (!res.ok) return [];
        const rows = await res.json();
        return (rows || []).map((row: any): MemoryNode => ({
            id: row.memory_id,
            charId: row.char_id,
            content: row.content || '',
            room: row.room,
            tags: row.tags || [],
            importance: row.importance ?? 5,
            mood: row.mood || '',
            valence: typeof row.valence === 'number' ? row.valence : undefined,
            arousal: typeof row.arousal === 'number' ? row.arousal : undefined,
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
        }));
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
export async function getVectorCount(config: RemoteVectorConfig, charId?: string): Promise<number> {
    try {
        const filter = charId ? `&char_id=eq.${encodeURIComponent(charId)}` : '';
        const res = await fetch(restUrl(config, `/memory_vectors?select=memory_id${filter}`), {
            method: 'HEAD',
            headers: {
                ...headers(config),
                'Prefer': 'count=exact',
            },
        });
        const range = res.headers.get('content-range');
        if (range) {
            const match = range.match(/\/(\d+)/);
            if (match) return parseInt(match[1], 10);
        }
        return 0;
    } catch {
        return 0;
    }
}

/**
 * 将本地向量同步到远程（一次性迁移）
 */
export async function syncLocalToRemote(
    config: RemoteVectorConfig,
    getLocalVectors: () => Promise<{ memoryId: string; charId: string; vector: number[] | Float32Array | Uint8Array; node: MemoryNode; dimensions: number; model?: string }[]>,
    onProgress?: (done: number, total: number) => void,
): Promise<{ synced: number; failed: number }> {
    const locals = await getLocalVectors();
    if (locals.length === 0) return { synced: 0, failed: 0 };

    let synced = 0, failed = 0;
    const BATCH = 50;

    for (let i = 0; i < locals.length; i += BATCH) {
        const batch = locals.slice(i, i + BATCH);
        const ok = await upsertVectorBatch(config, batch);
        if (ok) {
            synced += batch.length;
        } else {
            failed += batch.length;
        }
        onProgress?.(Math.min(i + BATCH, locals.length), locals.length);
    }

    return { synced, failed };
}
