import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const audit = readFileSync(new URL('../infra/assert-privacy.sh', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('../.github/workflows/privacy-audit.yml', import.meta.url), 'utf8');
const directories: string[] = [];
const eventIds = "'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'";

afterEach(() => directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function directory() {
  const path = mkdtempSync(join(tmpdir(), 'privacy-audit-test-'));
  directories.push(path);
  return path;
}

// 执行生产脚本的清理段；只替换数据库边界，不连接生产库。
function cleanup(mode = 'success') {
  const path = directory();
  const queries = join(path, 'queries.sql');
  writeFileSync(queries, '');
  const start = audit.indexOf('if [[ -n "$NONCE" && -n "$probe_sids" ]]');
  const end = audit.indexOf('\necho\nif (( ${#fails[@]} == 0 ))', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const result = spawnSync('bash', ['-c', `
set -uo pipefail
NONCE=12345
probe_sids="'33333333-3333-4333-8333-333333333333'"
fails=()
check() { if [[ "$2" != "$3" ]]; then fails+=("$1"); fi; }
Q() {
  printf '%s\\n' "$1" >> "$QUERIES"
  case "$1" in
    *string_agg*)
      [[ "$MODE" != lookup-error ]] || return 3
      [[ "$MODE" == empty ]] || printf '%s\\n' "$EVENT_IDS"
      ;;
    *BEGIN*)
      [[ "$MODE" != timeout ]] || { echo 'ERROR: canceling statement due to statement timeout' >&2; return 3; }
      ;;
    *) printf '0\\n'; [[ "$MODE" != verify-error ]] ;;
  esac
}
${audit.slice(start, end)}
printf '%s\\n' "\${fails[@]}"
(( \${#fails[@]} == 0 ))
`], { encoding: 'utf8', env: { ...process.env, QUERIES: queries, MODE: mode, EVENT_IDS: eventIds } });
  return { ...result, sql: readFileSync(queries, 'utf8') };
}

describe('隐私审计探针清理', () => {
  it('先取出探针 ID，再用现有索引精确删除事件及属性', () => {
    const result = cleanup();
    expect(result.status, result.stderr).toBe(0);
    expect(result.sql).toMatch(/SELECT[\s\S]*string_agg[\s\S]*event_id[\s\S]*event_name = 'ci_probe_12345'/);
    expect(result.sql).toContain(`DELETE FROM event_data WHERE website_event_id IN (${eventIds})`);
    expect(result.sql).toContain(`DELETE FROM website_event WHERE event_id IN (${eventIds})`);
    expect(result.sql).not.toMatch(/website_event_id IN\s*\(\s*SELECT/);
  });

  it('清理超时即使后续计数为零也必须失败，不能吞掉 SQL 错误', () => {
    const result = cleanup('timeout');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('statement timeout');
  });

  it.each(['lookup-error', 'empty'])('探针 ID 获取异常（%s）时不执行删除', (mode) => {
    const result = cleanup(mode);
    expect(result.status).toBe(1);
    expect(result.sql).not.toContain('DELETE FROM');
  });

  it('清理后的复核查询失败不能当作已清理', () => {
    const result = cleanup('verify-error');
    expect(result.status).toBe(1);
  });
});

describe('隐私审计 SSH 日志', () => {
  // 日志与 summary 各有一处展示自检正文，两个入口都执行真实命令。
  const printers = workflow.split('\n').filter((line) =>
    /^\s+(sed|awk) /.test(line) && line.includes('SCHEMA-BEGIN') && line.includes('/tmp/audit.out')
    && !line.includes('SCHEMA-END'),
  );

  it.each([
    ['断线时没有 schema 标记', 'checks passed\nConnection reset by peer\n', 'checks passed\nConnection reset by peer\n'],
    ['正常运行隐藏 schema 正文', 'checks passed\n===== SCHEMA-BEGIN =====\nCREATE TABLE secret();\n===== SCHEMA-END =====\n', 'checks passed\n'],
  ])('%s', (_name, input, expected) => {
    expect(printers.length).toBe(2);
    const path = join(directory(), 'audit.out');
    writeFileSync(path, input);
    for (const command of printers) {
      const result = spawnSync('bash', ['-c', command.replace('/tmp/audit.out', '"$AUDIT_OUTPUT"')], {
        encoding: 'utf8', env: { ...process.env, AUDIT_OUTPUT: path },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(expected);
    }
  });
});
