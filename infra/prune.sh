#!/usr/bin/env bash
# /opt/umami/bin/prune.sh
# 原始明细的滚动清理：服务器上只留最近 RETENTION_DAYS 天，更早的按月归档到 Google Drive。
#
# 某个月的明细要删，必须先满足两个条件，缺一个就停手：
#   1. 这个月的快照已经生成（analytics_snapshot 里有这个 period）。长期历史靠它。
#   2. 这个月的完整明细已经归档到 gdrive:umami-archive/YYYY-MM/，
#      下载回来逐行数过、和库里行数一致，并写好了 manifest.json。
#
# 归档格式：每张表一个 gzip 压缩的 CSV，时间一律 UTC。DuckDB 可以直接查，例如
#   duckdb -c "select event_name, count(*) from 'website_event.csv.gz' group by 1 order by 2 desc"
#
# 为什么是 35 天：比最长的自然月多几天，每月 1 号跑快照时上个月的明细一定还完整；
# umami 面板上「最近 30 天」也一直有数。
#
# 归档同样遵守「明细最多留 12 个月」：月份 <= 当前月 - 12 的归档目录整个删掉。
#
# 用法：prune.sh [--dry-run]
set -Eeuo pipefail

RETENTION_DAYS="${RETENTION_DAYS:-35}"
ARCHIVE_MONTHS=12
REMOTE=gdrive:umami-archive
TABLES=(website_event event_data session session_data revenue)
DRY_RUN=0; [[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

COMPOSE_DIR=/opt/umami
PSQL=(docker compose -f "$COMPOSE_DIR/docker-compose.yml" exec -T db
      psql -U umami -d umami -v ON_ERROR_STOP=1 -qtAX)

# 同一时间只允许跑一个
exec 9>/run/umami-prune.lock
flock -n 9 || { echo "已有 prune 在跑，退出。"; exit 0; }

# 所有查询统一按 UTC 算，和 snapshot.sql 的自然月口径一致
q() { "${PSQL[@]}" -c "SET timezone TO 'UTC'" -c "$1"; }

# ——— 归档一个月：导出 → 下载回来逐行核对 → 最后写 manifest ———
archive_month() {
  local month="$1" ym="${1:0:7}" t n got manifest=""
  echo "### 归档 $ym -> $REMOTE/$ym/ ###"
  for t in "${TABLES[@]}"; do
    local where="created_at >= DATE '$month' AND created_at < DATE '$month' + interval '1 month'"
    n=$(q "SELECT count(*) FROM $t WHERE $where;")
    # 不加 ORDER BY：排序会在盘上落临时文件，这台机器没那个空间
    q "COPY (SELECT * FROM $t WHERE $where) TO STDOUT WITH (FORMAT csv, HEADER)" \
      | gzip -6 | rclone rcat "$REMOTE/$ym/$t.csv.gz"
    # 字段里可能有换行，不能用 wc -l，按 CSV 规则数
    got=$(rclone cat "$REMOTE/$ym/$t.csv.gz" | gunzip | python3 -c '
import csv, sys
csv.field_size_limit(sys.maxsize)
r = csv.reader(sys.stdin)
next(r, None)
print(sum(1 for _ in r))')
    if [[ "$got" != "$n" ]]; then
      echo "核对失败：$ym/$t 库里 $n 行，归档里 $got 行。不写 manifest，不删数据。" >&2
      return 1
    fi
    echo "  $t: $n 行，核对一致"
    manifest+="\"$t\": $n, "
  done
  printf '{"period": "%s", "timezone": "UTC", "archived_at": "%s", "rows": {%s}}\n' \
    "$ym" "$(date -u +%FT%TZ)" "${manifest%, }" | rclone rcat "$REMOTE/$ym/manifest.json"
  echo "  manifest 已写入"
}

# ——— 删一天：子表先删，session 只删已经没人引用的 ———
delete_day() {
  local day="$1"
  "${PSQL[@]}" <<SQL
SET timezone TO 'UTC';
BEGIN;
-- 一天的事件先按 1000 个 ID 分组，再走属性表的 website_event_id 索引。
-- 不把条件合回 IN (SELECT ...)：线上曾全扫属性表再逐行查事件，耗时数分钟。
-- 各批仍在同一个事务内，后面的事件 / session 删除失败时一起回滚。
DO \$delete_attributes\$
DECLARE
  event_ids uuid[];
BEGIN
  FOR event_ids IN
    SELECT array_agg(event_id)
    FROM (
      SELECT event_id, (row_number() OVER () - 1) / 1000 AS batch
      FROM website_event
      WHERE created_at >= DATE '$day' AND created_at < DATE '$day' + 1
    ) candidates
    GROUP BY batch
  LOOP
    -- 每批按实际 UUID 数组规划，避免多次循环后切成不合适的通用计划。
    EXECUTE 'DELETE FROM event_data WHERE website_event_id = ANY(\$1)' USING event_ids;
  END LOOP;
END
\$delete_attributes\$;
DELETE FROM website_event
 WHERE created_at >= DATE '$day' AND created_at < DATE '$day' + 1;
DELETE FROM session_data
 WHERE created_at >= DATE '$day' AND created_at < DATE '$day' + 1;
DELETE FROM revenue
 WHERE created_at >= DATE '$day' AND created_at < DATE '$day' + 1;
DELETE FROM session
 WHERE created_at >= DATE '$day' AND created_at < DATE '$day' + 1
   AND NOT EXISTS (SELECT 1 FROM website_event we WHERE we.session_id = session.session_id)
   AND NOT EXISTS (SELECT 1 FROM session_data sd WHERE sd.session_id = session.session_id)
   AND NOT EXISTS (SELECT 1 FROM revenue r      WHERE r.session_id  = session.session_id);
COMMIT;
SQL
}

cutoff=$(q "SELECT (now()::date - $RETENTION_DAYS);")
oldest=$(q "SELECT min(created_at)::date FROM website_event;")
echo "保留最近 $RETENTION_DAYS 天，清理 $cutoff 之前的明细。最早一条明细：${oldest:-无}"

deleted_days=0
if [[ -n "$oldest" && "$oldest" < "$cutoff" ]]; then
  month=$(date -u -d "${oldest:0:7}-01" +%F)
  while [[ "$month" < "$cutoff" ]]; do
    ym="${month:0:7}"
    next_month=$(date -u -d "$month + 1 month" +%F)

    snap=$(q "SELECT count(*) FROM analytics_snapshot WHERE period = DATE '$month';")
    if [[ "$snap" -eq 0 ]]; then
      echo "停手：$ym 还没有快照，先修好 snapshot.sh 再说（/opt/umami/bin/snapshot.sh $month）。" >&2
      exit 1
    fi

    if ! rclone lsf "$REMOTE/$ym/manifest.json" 2>/dev/null | grep -q manifest; then
      if (( DRY_RUN )); then
        echo "[dry-run] $ym 还没归档，正式运行时会先归档。"
      else
        archive_month "$month"
      fi
    else
      echo "$ym 已归档，跳过导出。"
    fi

    # 这个月里落在 cutoff 之前的天
    day="$month"; [[ "$oldest" > "$day" ]] && day="$oldest"
    end="$next_month"; [[ "$cutoff" < "$end" ]] && end="$cutoff"
    while [[ "$day" < "$end" ]]; do
      if (( DRY_RUN )); then
        echo "[dry-run] 会删除 $day"
      else
        echo "  -> 删除 $day"
        delete_day "$day"
        deleted_days=$((deleted_days + 1))
        # 删除也写 WAL，隔几天手动 checkpoint 一下，别让 pg_wal 在小盘上堆起来
        if (( deleted_days % 5 == 0 )); then q "CHECKPOINT;"; fi
      fi
      day=$(date -u -d "$day + 1 day" +%F)
    done
    month="$next_month"
  done
fi

if (( deleted_days > 0 )); then
  echo "### 删了 $deleted_days 天，VACUUM 让空间可复用 ###"
  q "CHECKPOINT;"
  q "VACUUM (ANALYZE) website_event, event_data, session, session_data, revenue;"
fi

# ——— 归档本身也只留 12 个月 ———
# 例：现在是 2026-09，则 2025-09 及更早的归档删掉
expire_upto=$(date -u -d "$(date -u +%Y-%m-01) - $ARCHIVE_MONTHS months" +%Y-%m)
for dir in $(rclone lsf "$REMOTE/" --dirs-only 2>/dev/null); do
  ym="${dir%/}"
  if [[ ! "$ym" > "$expire_upto" ]]; then
    if (( DRY_RUN )); then
      echo "[dry-run] 归档 $ym 超过 $ARCHIVE_MONTHS 个月，会删除"
    else
      echo "归档 $ym 超过 $ARCHIVE_MONTHS 个月，删除。"
      rclone purge "$REMOTE/$ym"
    fi
  fi
done

df -h / | tail -1
