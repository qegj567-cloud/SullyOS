#!/usr/bin/env bash
# /opt/umami/bin/assert-privacy.sh
#
# 把公开承诺变成可执行断言。任何一条不成立就退出码非零，并在
# /opt/umami/ALERT.txt 留下现场 + 往 journal 打 err 级日志。
#
# 被 backup.sh（每天）和 snapshot.sh（每月）无参调用 —— 每天跑意味着
# 触发器哪天被 prisma 迁移冲掉，24 小时内就会暴露，而不是等下次快照。
#
# 也被 audit-entry.sh 带一个 nonce 调用（GitHub Actions 每日外部审计）。
# 带 nonce 时多跑一组「脏头探针」断言：CI 事先用伪造的 XFF / CF-IPCity 发了
# 一个事件，这里验证它确实落库了（管道是活的）、而伪造值一个都没渗进去
# （Caddy 清头 + CLIENT_IP_HEADER 在行为上真的成立，不只是配置文件长得对）。
#
# 这份文件在仓库里有一份副本 infra/assert-privacy.sh，CI 每天比对两者的
# sha256。注意下面自己输出的 CONFIG-SHA256 不是防篡改措施 —— 能改这个脚本的人
# 当然也能改那几行。真正的防线是「判定发生在仓库那侧」：服务器只负责报事实，
# 基线存在 GitHub 上，谁也没法只动一边。

set -Euo pipefail

COMPOSE=/opt/umami/docker-compose.yml
ALERT=/opt/umami/ALERT.txt
BASE_URL=https://stats.friedsully.com
RETENTION_MONTHS=12

# `< /dev/null` 不能省：docker compose exec 会读 stdin，脚本一旦经 `bash -s`
# 之类的方式从标准输入喂进来，psql 会把后半截脚本当查询吞掉。
# 只约束审计连接，不修改业务库的全局参数。超时或 SQL 出错必须返回非零。
Q() {
  docker compose -f "$COMPOSE" exec -T \
    -e PGOPTIONS='-c statement_timeout=120000 -c lock_timeout=10000' db \
    psql -X -v ON_ERROR_STOP=1 -U umami -d umami -qtAX -c "$1" < /dev/null
}

NONCE="${1:-}"

fails=()

check() { # check <描述> <期望值> <实际值>
  if [[ "$2" == "$3" ]]; then
    printf '  ✅ %-46s %s\n' "$1" "$3"
  else
    printf '  ❌ %-46s 期望 %s，实际 %s\n' "$1" "$2" "$3"
    fails+=("$1（期望 $2，实际 $3）")
  fi
}

echo "隐私不变量自检 $(date -u +%FT%TZ)"
[[ -n "$NONCE" ]] && echo "（带脏头探针，nonce=$NONCE）"

# 1. geo 触发器还在吗（prisma 迁移最可能冲掉的就是它）
check "geo 触发器存在" "1" \
  "$(Q "SELECT count(*) FROM pg_trigger WHERE tgname='trg_umami_strip_geo' AND NOT tgisinternal;")"

# 2. 触发器真的在生效吗 —— 这是承诺本身，不是承诺的实现细节
check "session.city 全为 NULL" "0" \
  "$(Q "SELECT count(*) FROM session WHERE city IS NOT NULL;")"
check "session.region 全为 NULL" "0" \
  "$(Q "SELECT count(*) FROM session WHERE region IS NOT NULL;")"

# 3. 有没有谁加了 IP 列
check "全库无 IP 类字段" "0" \
  "$(Q "SELECT count(*) FROM information_schema.columns
     WHERE table_schema='public' AND table_name <> 'analytics_snapshot'
       AND (column_name ~* '(^|_)ip(_|\$)' OR column_name ILIKE '%ip_address%' OR column_name ILIKE '%remote_addr%');")"

# 4. 约束 #6：录制 / 热图 / pixel
check "无 website 开启录制" "0" \
  "$(Q "SELECT count(*) FROM website WHERE recorder_enabled;")"
check "session_replay 为空" "0" "$(Q "SELECT count(*) FROM session_replay;")"
check "heatmap_event 为空"  "0" "$(Q "SELECT count(*) FROM heatmap_event;")"
check "pixel 为空"          "0" "$(Q "SELECT count(*) FROM pixel;")"

# 5. 约束 #3：登录没被关掉
check "后台未登录访问被拒" "401" \
  "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$BASE_URL/api/websites" || echo ERR)"

# 6. 约束 #2：断外联的开关还在
cfg=$(curl -sS --max-time 10 "$BASE_URL/api/config" || echo '{}')
for k in privateMode telemetryDisabled updatesDisabled; do
  val=$(printf '%s' "$cfg" | python3 -c "import sys,json;print(str(json.load(sys.stdin).get(sys.argv[1],False)).lower())" "$k" 2>/dev/null || echo ERR)
  check "$k" "true" "$val"
done
check "tracker 脚本名未被改动" "null" \
  "$(printf '%s' "$cfg" | python3 -c "import sys,json;print(json.dumps(json.load(sys.stdin).get('trackerScriptName')))" 2>/dev/null || echo ERR)"

# 7. IP 头处理：CLIENT_IP_HEADER 还指向 Caddy 注入的那个头
check "CLIENT_IP_HEADER=X-Anon-IP" "X-Anon-IP" \
  "$(docker exec umami sh -c 'printf %s "$CLIENT_IP_HEADER"' 2>/dev/null || echo ERR)"

# 8. 约束 #4：5432 不对公网
check "宿主机无 5432 监听" "0" "$(ss -lntH 2>/dev/null | grep -c ':5432 ' || true)"
check "compose 中 db 无 ports" "0" \
  "$(docker compose -f "$COMPOSE" config | awk '/^  db:/,/^  [a-z]+:$/' | grep -c 'ports:' || true)"

# 9. 反代不记 IP
check "Caddy 无 access log 文件" "0" \
  "$(find /var/log/caddy -type f 2>/dev/null | wc -l)"
check "Caddyfile 仍 discard 日志" "2" \
  "$(grep -c 'output discard' /etc/caddy/Caddyfile || true)"
check "Caddyfile 仍做 IP 截断" "1" \
  "$(grep -c 'header_up X-Anon-IP' /etc/caddy/Caddyfile || true)"

# 10. 约束：原始明细只留 12 个月
#
# 这条以前是漏的 —— 承诺写在 docs/analytics.md 里，执行它的 prune.sh 至今
# 还是草稿状态（没装 timer），中间没有任何东西在看着。现在它到期会自己红。
oldest_over=$(Q "SELECT count(*) FROM website_event
                 WHERE created_at < now() - interval '$RETENTION_MONTHS months';")
check "无超过 ${RETENTION_MONTHS} 个月的原始明细" "0" "$oldest_over"
echo "     （最早一条明细：$(Q "SELECT coalesce(min(created_at)::date::text,'（无数据）') FROM website_event;")）"

# ───────────────────────────────────────────────────────────────────
# 11. 脏头探针（只在带 nonce 时跑）
#
# CI 在 SSH 进来之前，已经用一个浏览器 UA + 故意伪造的
# X-Forwarded-For / X-Real-IP / CF-IPCity / CF-IPCountry 发了一个事件。
# 这一组断言回答的是「承诺在行为上成立吗」，而不是「配置文件长得对吗」：
#
#   a. 事件落库      → 从公网到数据库这条管道是活的，前面那些断言查的是同一个库
#   b. city/region 空 → 触发器在真实写入路径上生效
#   c. country 不是伪造值、也不为空
#      → 伪造的 CF-IPCountry 没被采信；且 country 能解析出来说明用的是
#        Caddy 截断后的真实 IP。如果 XFF 被采信了，203.0.113.7 是 RFC5737
#        文档地址，没有地理归属，country 会是空 —— 空反而是出问题的信号。
# ───────────────────────────────────────────────────────────────────
probe_sids=""
if [[ -n "$NONCE" ]]; then
  ev="ci_probe_${NONCE}"
  echo
  echo "### 脏头探针 $ev ###"

  # umami 的写入不是同步的，给它一点时间，别把 CI 做成 flaky 的。
  n=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    n=$(Q "SELECT count(*) FROM website_event WHERE event_name = '$ev';")
    [[ "$n" =~ ^[0-9]+$ ]] && (( n > 0 )) && break
    sleep 2
  done

  check "探针事件已落库" "1" "$( (( ${n:-0} > 0 )) && echo 1 || echo 0 )"

  if (( ${n:-0} > 0 )); then
    probe_sids=$(Q "SELECT string_agg(DISTINCT quote_literal(session_id), ',')
                    FROM website_event WHERE event_name = '$ev';")

    check "探针 session 的 city/region 为空" "0" \
      "$(Q "SELECT count(*) FROM session
            WHERE session_id IN ($probe_sids) AND (city IS NOT NULL OR region IS NOT NULL);")"

    check "伪造的地理头未被采信" "0" \
      "$(Q "SELECT count(*) FROM session
            WHERE session_id IN ($probe_sids)
              AND (country = 'XX' OR country IS NULL OR country = '');")"

    check "探针未夹带伪造 IP 串" "0" \
      "$(Q "SELECT count(*) FROM event_data
            WHERE string_value ILIKE '%203.0.113%' OR string_value ILIKE '%198.51.100%'
               OR string_value ILIKE '%Mordor%'    OR string_value ILIKE '%Shire%';")"

    echo "     （探针 session 实况：$(Q "SELECT 'country=' || coalesce(country,'∅') || ' city=' || coalesce(city,'∅') || ' region=' || coalesce(region,'∅') FROM session WHERE session_id IN ($probe_sids);" | paste -sd' ' -)）"
  fi
fi

# ───────────────────────────────────────────────────────────────────
# 12. 配置指纹。判定不在这里 —— CI 拿仓库 infra/ 里的副本比对这几行。
# ───────────────────────────────────────────────────────────────────
echo
echo "### 配置指纹 ###"
fp() { printf 'CONFIG-SHA256 %s %s\n' "$1" "$(sha256sum "$2" 2>/dev/null | awk '{print $1}')"; }
fp Caddyfile          /etc/caddy/Caddyfile
fp docker-compose.yml /opt/umami/docker-compose.yml
fp assert-privacy.sh  /opt/umami/bin/assert-privacy.sh
# audit-entry.sh 也必须钉住：它是 CI 那把钥匙唯一能触达的入口，
# 谁能改它谁就能让下面这一切变成演出。
fp audit-entry.sh     /opt/umami/bin/audit-entry.sh
printf 'CONFIG-SHA256 %s %s\n' umami-privacy-trigger.expected.txt \
  "$({ Q "SELECT pg_get_functiondef('umami_strip_geo'::regproc);"
       Q "SELECT pg_get_triggerdef(oid) FROM pg_trigger
          WHERE tgname = 'trg_umami_strip_geo' AND NOT tgisinternal;"; } \
     | sed '/^$/d' | sha256sum | awk '{print $1}')"

# ───────────────────────────────────────────────────────────────────
# 13. 清理探针 —— 无论前面成败都要清，别把审计产生的数据留在生产库里。
# ───────────────────────────────────────────────────────────────────
if [[ -n "$NONCE" && -n "$probe_sids" ]]; then
  ev="ci_probe_${NONCE}"
  echo
  echo "### 清理探针 ${ev}（单条 SQL 最多 120 秒，锁等待最多 10 秒）###"
  cleanup_started=$SECONDS
  # 先把少量 UUID 取出来，再按现有索引删。不要合并回 IN (SELECT ...)：
  # 线上曾因此扫描数百万行 event_data，再逐行查询 website_event，耗时数分钟。
  if probe_eids=$(Q "SELECT string_agg(quote_literal(event_id), ',')
                    FROM website_event WHERE event_name = '$ev';") && [[ -n "$probe_eids" ]]; then
    if Q "BEGIN;
       DELETE FROM event_data WHERE website_event_id IN ($probe_eids);
       DELETE FROM website_event WHERE event_id IN ($probe_eids) AND event_name = '$ev';
       DELETE FROM session_data WHERE session_id IN ($probe_sids);
       DELETE FROM session WHERE session_id IN ($probe_sids)
         AND NOT EXISTS (SELECT 1 FROM website_event we WHERE we.session_id = session.session_id);
       COMMIT;" > /dev/null; then
      if left=$(Q "SELECT count(*) FROM website_event WHERE event_name = '$ev';"); then
        check "探针数据已清理" "0" "$left"
      else
        check "探针清理复核成功" "yes" "no（查询失败，见上方错误）"
      fi
    else
      check "探针清理事务成功" "yes" "no（SQL 失败或超时，见上方错误）"
    fi
  else
    check "取得待清理探针 ID" "yes" "no（查询失败或探针已不存在）"
  fi
  echo "     （清理耗时 $(( SECONDS - cleanup_started )) 秒）"
fi

echo
if (( ${#fails[@]} == 0 )); then
  echo "全部通过。"
  rm -f "$ALERT"
  exit 0
fi
{
  echo "===== 隐私不变量自检失败 $(date -u +%FT%TZ) ====="
  printf '%s\n' "${fails[@]}"
  echo
  echo "在修好之前，不要对外声称这些承诺仍然成立。"
} | tee "$ALERT"
logger -t umami-privacy -p user.err "隐私自检失败：${fails[*]}"
exit 1
