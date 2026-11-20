-- SullyOS 记忆宫殿：在 Supabase SQL Editor 中整份运行，可重复运行。
-- 首次建库或选择原生扩展列时使用。已配置的历史项目由客户端自动兼容。
begin;
set local search_path = public, extensions;

-- 1. 启用 pgvector 扩展
create extension if not exists vector;

-- 2. 创建向量表
do $init$
begin
  if to_regclass('public.memory_vectors') is null then
    create table memory_vectors (
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
    alter table memory_vectors enable row level security;
    if exists (select 1 from pg_roles where rolname = 'anon') then
      grant select, insert, update, delete on memory_vectors to anon;
    end if;
    create policy "Allow all access" on memory_vectors for all using (true) with check (true);
  end if;
end
$init$;

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

alter table memory_vectors add column if not exists entities jsonb;
alter table memory_vectors add column if not exists relative_time_anchor jsonb;
alter table memory_vectors add column if not exists group_id text;
alter table memory_vectors add column if not exists group_name text;
alter table memory_vectors add column if not exists digested_at bigint;

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
  event_box_id text,
  entities jsonb,
  relative_time_anchor jsonb,
  group_id text,
  group_name text,
  digested_at bigint,
  model text
)
language sql stable
set search_path = public, extensions
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
    mv.event_box_id,
    mv.entities,
    mv.relative_time_anchor,
    mv.group_id,
    mv.group_name,
    mv.digested_at,
    mv.model
  from memory_vectors mv
  where mv.char_id = match_char_id
    and coalesce(mv.archived, false) = false  -- 过滤已归档节点
    and 1 - (mv.vector <=> query_embedding) > match_threshold
  order by mv.vector <=> query_embedding
  limit match_count;
$$;

notify pgrst, 'reload schema';
commit;
