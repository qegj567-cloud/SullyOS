import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// 显式指定测试主机才执行。所有数据均在本连接的临时表，public 不在 search_path。
// PRIVACY_TEST_SSH=dmit pnpm vitest run scripts/privacy-maintenance.integration.test.ts
const host = process.env.PRIVACY_TEST_SSH;
const audit = readFileSync(new URL('../infra/assert-privacy.sh', import.meta.url), 'utf8');
const prune = readFileSync(new URL('../infra/prune.sh', import.meta.url), 'utf8');
const probeLookup = audit.match(/n=\$\(Q "([^"]*)"\)/)![1]
  .replaceAll('$ev', 'ci_probe_12345');
const deleteDayFunction = prune.slice(prune.indexOf('delete_day() {'), prune.indexOf('\ncutoff='));
const pruneDay = spawnSync('bash', ['-c', `PSQL=(cat)\n${deleteDayFunction}\ndelete_day 2026-09-10`], {
  encoding: 'utf8',
}).stdout;

function sql(input: string) {
  const result = spawnSync('ssh', ['-o', 'BatchMode=yes', host!,
    'docker compose -f /opt/umami/docker-compose.yml exec -T db psql -X -U umami -d umami -v ON_ERROR_STOP=1 -qtAX'], {
    encoding: 'utf8', input: `SET statement_timeout='20s';\nSET search_path=pg_temp;\n${input}`,
    timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
  });
  return result;
}

const probeFixture = `
CREATE TEMP TABLE website_event (event_id uuid PRIMARY KEY, event_name text, created_at timestamp);
CREATE INDEX ON website_event(created_at);
INSERT INTO website_event SELECT md5(i::text)::uuid, 'ordinary', now() - interval '30 days'
FROM generate_series(1, 30000) i;
`;

const pruneFixture = `
CREATE TEMP TABLE website_event (event_id uuid PRIMARY KEY, session_id uuid, created_at timestamp);
CREATE TEMP TABLE event_data (event_data_id uuid PRIMARY KEY, website_event_id uuid, created_at timestamp);
CREATE INDEX ON event_data(website_event_id);
CREATE TEMP TABLE session (session_id uuid PRIMARY KEY, created_at timestamp);
CREATE TEMP TABLE session_data (session_data_id uuid PRIMARY KEY, session_id uuid, created_at timestamp);
CREATE TEMP TABLE revenue (revenue_id uuid PRIMARY KEY, session_id uuid, created_at timestamp);
INSERT INTO session SELECT md5(i::text)::uuid, '2026-09-10'::timestamp FROM generate_series(1, 2505) i;
INSERT INTO website_event SELECT md5(i::text)::uuid, md5(i::text)::uuid, '2026-09-10'::timestamp
FROM generate_series(1, 2501) i;
-- 上下界及跨日引用：10 日事件的属性即便日期不同也必须删除。
INSERT INTO website_event VALUES
  (md5('before')::uuid, md5('2502')::uuid, '2026-09-09 23:59:59'),
  (md5('after')::uuid, md5('2503')::uuid, '2026-09-11'),
  (md5('shared')::uuid, md5('1')::uuid, '2026-09-11');
INSERT INTO event_data SELECT event_id, event_id, '2026-09-09' FROM website_event;
INSERT INTO session_data VALUES
  (md5('sd-old')::uuid, md5('2504')::uuid, '2026-09-10'),
  (md5('sd-keep')::uuid, md5('2504')::uuid, '2026-09-11');
INSERT INTO revenue VALUES
  (md5('r-old')::uuid, md5('2505')::uuid, '2026-09-10'),
  (md5('r-keep')::uuid, md5('2505')::uuid, '2026-09-11');
CREATE TEMP TABLE deletion_batches (events integer);
CREATE FUNCTION pg_temp.record_batch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO deletion_batches SELECT count(DISTINCT website_event_id) FROM deleted_attributes;
  RETURN NULL;
END $$;
CREATE TRIGGER record_batch AFTER DELETE ON event_data
REFERENCING OLD TABLE AS deleted_attributes FOR EACH STATEMENT EXECUTE FUNCTION pg_temp.record_batch();
`;

// 执行生产 SQL 的删除，检验临时夹具的最终状态；不会触及正式表。
describe.skipIf(!host)('隐私维护 PostgreSQL 行为与执行计划', () => {
  it('新探针落库检查不扫描整段历史', () => {
    const result = sql(`${probeFixture}
INSERT INTO website_event VALUES (md5('probe')::uuid, 'ci_probe_12345', now());
ANALYZE website_event;
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${probeLookup}`);
    expect(result.status, result.stderr).toBe(0);
    const plan = JSON.parse(result.stdout)[0].Plan;
    const visited = (node: any): number => ((node['Actual Rows'] || 0) + (node['Rows Removed by Filter'] || 0))
      * (node['Actual Loops'] || 0) + (node.Plans || []).reduce((n: number, child: any) => n + visited(child), 0);
    expect(visited(plan)).toBeLessThan(100);
  });

  it.each([
    ['旧探针仍可查到', "INSERT INTO website_event VALUES (md5('probe')::uuid, 'ci_probe_12345', now() - interval '10 days');", '1'],
    ['没有探针仍报告未落库', '', '0'],
  ])('%s', (_name, insertion, expected) => {
    const result = sql(`${probeFixture}\n${insertion}\n${probeLookup}`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
  });

  it('一天的删除分批执行，保留原日期边界、属性归属和会话引用条件', () => {
    const result = sql(`${pruneFixture}\n${pruneDay}
SELECT count(*) FROM website_event;
SELECT count(*) FROM event_data;
SELECT string_agg(i::text, ',' ORDER BY i) FROM generate_series(1,2505) i
WHERE EXISTS (SELECT 1 FROM session WHERE session_id=md5(i::text)::uuid);
SELECT count(*) FROM session_data;
SELECT count(*) FROM revenue;
SELECT max(events) <= 1000 AND sum(events) = 2501 FROM deletion_batches;`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(['3', '3', '1,2502,2503,2504,2505', '1', '1', 't']);
  });

  it('中途失败回滚整天的所有批次', () => {
    const result = sql(`${pruneFixture}
CREATE FUNCTION pg_temp.fail_late() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'deliberate rollback test'; END $$;
CREATE TRIGGER fail_late BEFORE DELETE ON website_event FOR EACH STATEMENT EXECUTE FUNCTION pg_temp.fail_late();
\\set ON_ERROR_STOP off
${pruneDay}
\\set ON_ERROR_STOP on
SELECT count(*) FROM website_event;
SELECT count(*) FROM event_data;
SELECT count(*) FROM session;`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('deliberate rollback test');
    expect(result.stdout.trim().split('\n')).toEqual(['2504', '2504', '2505']);
  });
});
