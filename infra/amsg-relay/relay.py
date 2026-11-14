#!/usr/bin/env python3
"""SullyOS 主动消息 2.0 中转服务。

一个进程干两件事：
1. 在 127.0.0.1 上收 Caddy 转来的 `/t/<令牌>/<worker 域名>/<接口>`，核对令牌、路径白名单、频率和每日流量，
   再固定连 Cloudflare 的 IP 转给用户自己的 Worker，顺手按账号按天记上下行字节数。
2. 以 Sully Connect 机器人的身份连 Discord gateway，处理 /中转令牌 等几条全局命令。
   同一个机器人还有别的进程在处理群命令（/判断有误），这里只认自己的命令，别的一律不回。

不记录请求内容、路径、目标 Worker、来源 IP 和时间点；设计与取舍见 docs/amsg2-relay.md。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import random
import re
import secrets
import socket
import sqlite3
import time
from datetime import date, datetime, timedelta, timezone

import aiohttp
from aiohttp import web
from aiohttp.abc import AbstractResolver
from yarl import URL

log = logging.getLogger("amsg-relay")

# 2.0 的接口路径白名单。utils/amsgRelay.test.ts 会按 `PATH_ALLOWLIST = re.compile(r"...")` 这一行原样提取，
# 拿客户端 SDK、activeMsgClient.ts、worker 路由里实际用到的路径逐个对照；格式别改成多行。
PATH_ALLOWLIST = re.compile(r"^/(?:cloud-data/[A-Za-z0-9/_.:-]+|init-tenant|get-user-key|schedule-message|messages|message|update-message|cancel-message|capabilities|client-state|client-state/namespaces|llm-credentials|outbox|outbox/ack|push-subscription|vapid-public-key|config-check|debug|self-update|self-update/check|cron-trigger|tick-report|instant-chat|test-push)/?$")

TOKEN_PATH = re.compile(r"^/t/([A-Za-z0-9_-]{20,64})/(.*)$")
# 只收域名，不收 IP 字面量（顶级域必须是字母）
HOST_RE = re.compile(r"^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")
ALLOWED_METHODS = {"GET", "POST", "PUT", "DELETE", "OPTIONS"}
# 只放行官方渠道发来的请求：浏览器自己填的 Origin 页面脚本改不了，二改版本部署在别的网址就过不来。
# 名单对应 utils/deploymentSource.ts 的 OFFICIAL_HOSTS（utils/amsgRelay.test.ts 对照两边）；
# https://localhost 是官方 APK（Capacitor，androidScheme=https）的来源，本地开发服务器带端口，进不来。
ALLOWED_ORIGINS = {"https://qegj567-cloud.github.io", "https://sully-os-nu.vercel.app", "https://friedsully.com",
                   "https://localhost"}

# 实测能按 SNI 转发任意 CF 托管域名的公共 IP。不在 CF 上的域名连上来会在握手阶段失败，
# 所以中转只到得了 Cloudflare，不会变成通往任意网站的开放代理。
CF_IPS = ["104.16.0.1", "104.17.0.1", "104.18.0.1", "104.19.0.1", "104.20.0.1", "104.21.0.1"]

TOKEN_IDLE_DAYS = 30
USAGE_KEEP_DAYS = 90
RATE_BURST = 120          # 每个账号的令牌桶容量（次）
RATE_PER_SEC = 2.0        # 每秒回填
DAILY_BYTES_CAP = 1024 ** 3  # 每个账号每天上下行合计
MAX_BODY = 10 * 1024 * 1024
# 按北京时间切日：用户几乎都在 UTC+8，「今天用了多少」要和他们的日历对得上
DAY_TZ = timezone(timedelta(hours=8))

# 不往 Worker 带的头：逐跳头，以及任何可能带出用户 IP 的头
DROP_REQUEST_HEADERS = {
    "host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
    "transfer-encoding", "upgrade", "content-length", "x-forwarded-for", "x-forwarded-proto",
    "x-forwarded-host", "x-forwarded-port", "x-real-ip", "forwarded", "via", "cf-connecting-ip",
    "true-client-ip",
}
DROP_RESPONSE_HEADERS = {"connection", "keep-alive", "transfer-encoding", "upgrade", "trailer"}

API = "https://discord.com/api/v10"
GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json"
USER_AGENT = "DiscordBot (https://sullyos.invalid, 1.0)"
ADMINISTRATOR = 1 << 3
FATAL_GATEWAY_CLOSE = {4004, 4010, 4011, 4012, 4013, 4014}

_GUILD_ONLY = {"type": 1, "contexts": [0], "integration_types": [0]}
COMMANDS = [
    {**_GUILD_ONLY, "name": "中转令牌", "description": "领取或重置主动消息 2.0 的中转令牌（旧令牌立即作废）"},
    {**_GUILD_ONLY, "name": "中转流量", "description": "查看自己最近经中转用了多少流量"},
    {**_GUILD_ONLY, "name": "中转吊销", "description": "（管理员）吊销某人的中转令牌",
     "default_member_permissions": str(ADMINISTRATOR), "options": [
         {"type": 6, "name": "用户", "description": "要吊销的人", "required": True},
         {"type": 5, "name": "禁止重新领取", "description": "打开后此人不能再领令牌", "required": False},
     ]},
    {**_GUILD_ONLY, "name": "中转解封", "description": "（管理员）允许被禁止的人重新领取中转令牌",
     "default_member_permissions": str(ADMINISTRATOR), "options": [
         {"type": 6, "name": "用户", "description": "要解封的人", "required": True},
     ]},
]
COMMAND_NAMES = {c["name"] for c in COMMANDS}


def today() -> date:
    return datetime.now(DAY_TZ).date()


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def format_bytes(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} GB"


class PinnedCloudflareResolver(AbstractResolver):
    """不管目标是哪个域名，都解析成 CF 公共 IP。打乱顺序后全部交给 aiohttp，连不上会自动试下一个。"""

    def __init__(self, ips: list[str]):
        self.ips = ips

    async def resolve(self, host, port=0, family=socket.AF_INET):
        ips = self.ips[:]
        random.shuffle(ips)
        return [{"hostname": host, "host": ip, "port": port, "family": socket.AF_INET, "proto": 0,
                 "flags": socket.AI_NUMERICHOST} for ip in ips]

    async def close(self):
        pass


class Relay:
    def __init__(self, db_path: str, *, guild_id: str, verified_role_id: str, bot_token: str = "",
                 upstream_scheme: str = "https", upstream_resolver: AbstractResolver | None = None):
        self.guild_id = guild_id
        self.verified_role_id = verified_role_id
        self.bot_token = bot_token
        self.upstream_scheme = upstream_scheme
        self._upstream_resolver = upstream_resolver
        self.buckets: dict[str, tuple[float, float]] = {}
        self.checking: set[str] = set()
        self.db = sqlite3.connect(db_path, isolation_level=None)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS tokens(
                user_id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL,
                issued_day TEXT NOT NULL, last_used_day TEXT NOT NULL, checked_day TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS usage(
                user_id TEXT NOT NULL, day TEXT NOT NULL, up INTEGER NOT NULL, down INTEGER NOT NULL,
                requests INTEGER NOT NULL, PRIMARY KEY(user_id, day));
            CREATE TABLE IF NOT EXISTS banned(user_id TEXT PRIMARY KEY);
        """)
        self.upstream: aiohttp.ClientSession | None = None
        self.discord: aiohttp.ClientSession | None = None

    async def start(self):
        connector = aiohttp.TCPConnector(resolver=self._upstream_resolver or PinnedCloudflareResolver(CF_IPS),
                                         use_dns_cache=False, limit=200)
        # 原样转发字节：不解压 Worker 的响应，Content-Encoding 和长度都保持一致
        self.upstream = aiohttp.ClientSession(
            connector=connector, auto_decompress=False, trust_env=False,
            timeout=aiohttp.ClientTimeout(total=None, connect=10, sock_read=300))
        self.discord = aiohttp.ClientSession(
            headers={"User-Agent": USER_AGENT}, timeout=aiohttp.ClientTimeout(total=20))

    async def close(self):
        for s in (self.upstream, self.discord):
            if s:
                await s.close()
        self.db.close()

    # ---------- 令牌与流量 ----------

    def issue_token(self, user_id: str) -> str:
        token = secrets.token_urlsafe(32)
        d = today().isoformat()
        self.db.execute(
            "INSERT INTO tokens(user_id, token_hash, issued_day, last_used_day, checked_day) VALUES(?,?,?,?,?) "
            "ON CONFLICT(user_id) DO UPDATE SET token_hash=excluded.token_hash, issued_day=excluded.issued_day, "
            "last_used_day=excluded.last_used_day, checked_day=excluded.checked_day",
            (user_id, hash_token(token), d, d, d))
        return token

    def revoke(self, user_id: str) -> bool:
        return self.db.execute("DELETE FROM tokens WHERE user_id=?", (user_id,)).rowcount > 0

    def is_banned(self, user_id: str) -> bool:
        return self.db.execute("SELECT 1 FROM banned WHERE user_id=?", (user_id,)).fetchone() is not None

    def authenticate(self, token: str) -> tuple[str, str] | None:
        """返回 (user_id, checked_day)；令牌不存在或闲置超期返回 None（超期的顺手删掉）。"""
        row = self.db.execute("SELECT user_id, last_used_day, checked_day FROM tokens WHERE token_hash=?",
                              (hash_token(token),)).fetchone()
        if not row:
            return None
        user_id, last_used, checked = row
        t = today()
        if date.fromisoformat(last_used) < t - timedelta(days=TOKEN_IDLE_DAYS):
            self.revoke(user_id)
            return None
        if last_used != t.isoformat():
            self.db.execute("UPDATE tokens SET last_used_day=? WHERE user_id=?", (t.isoformat(), user_id))
        return user_id, checked

    def take_rate(self, user_id: str) -> float:
        """令牌桶。放行返回 0，否则返回要等的秒数。"""
        now = time.monotonic()
        level, at = self.buckets.get(user_id, (RATE_BURST, now))
        level = min(RATE_BURST, level + (now - at) * RATE_PER_SEC)
        if level < 1:
            self.buckets[user_id] = (level, now)
            return (1 - level) / RATE_PER_SEC
        self.buckets[user_id] = (level - 1, now)
        return 0

    def record_usage(self, user_id: str, up: int, down: int):
        self.db.execute(
            "INSERT INTO usage(user_id, day, up, down, requests) VALUES(?,?,?,?,1) "
            "ON CONFLICT(user_id, day) DO UPDATE SET up=up+excluded.up, down=down+excluded.down, requests=requests+1",
            (user_id, today().isoformat(), up, down))

    def usage_since(self, user_id: str, days: int) -> dict:
        since = (today() - timedelta(days=days - 1)).isoformat()
        up, down, req = self.db.execute(
            "SELECT COALESCE(SUM(up),0), COALESCE(SUM(down),0), COALESCE(SUM(requests),0) FROM usage "
            "WHERE user_id=? AND day>=?", (user_id, since)).fetchone()
        return {"up": up, "down": down, "requests": req}

    def usage_summary(self, user_id: str) -> dict:
        row = self.db.execute("SELECT issued_day, last_used_day FROM tokens WHERE user_id=?", (user_id,)).fetchone()
        return {"today": self.usage_since(user_id, 1), "last7": self.usage_since(user_id, 7),
                "last30": self.usage_since(user_id, 30),
                "issuedDay": row[0] if row else None, "lastUsedDay": row[1] if row else None}

    def prune(self):
        t = today()
        self.db.execute("DELETE FROM tokens WHERE last_used_day<?",
                        ((t - timedelta(days=TOKEN_IDLE_DAYS)).isoformat(),))
        self.db.execute("DELETE FROM usage WHERE day<?", ((t - timedelta(days=USAGE_KEEP_DAYS - 1)).isoformat(),))

    async def recheck_member(self, user_id: str):
        """每个账号每天最多查一次：退群或没了「已验证」身份组就作废令牌。查询失败不动令牌，下次再查。"""
        if user_id in self.checking or not self.bot_token:
            return
        self.checking.add(user_id)
        try:
            async with self.discord.get(f"{API}/guilds/{self.guild_id}/members/{user_id}",
                                        headers={"Authorization": f"Bot {self.bot_token}"}) as r:
                if r.status == 404:
                    self.revoke(user_id)
                    return
                if r.status != 200:
                    return
                member = await r.json()
            if self.verified_role_id not in member.get("roles", []):
                self.revoke(user_id)
                return
            self.db.execute("UPDATE tokens SET checked_day=? WHERE user_id=?", (today().isoformat(), user_id))
        except Exception as e:  # 网络问题不影响转发
            log.warning("member recheck failed: %s", type(e).__name__)
        finally:
            self.checking.discard(user_id)

    # ---------- HTTP ----------

    @staticmethod
    def relay_error(status: int, code: str, message: str, **headers) -> web.Response:
        return web.json_response({"error": code, "message": message}, status=status, headers={
            "X-Amsg-Relay-Error": code, "Access-Control-Allow-Origin": "*",
            "Access-Control-Expose-Headers": "X-Amsg-Relay-Error, Retry-After", **headers})

    async def handle(self, req: web.Request) -> web.StreamResponse:
        m = TOKEN_PATH.match(req.rel_url.raw_path)
        if not m:
            return self.relay_error(404, "not_relayable", "不是中转支持的地址")
        token, rest = m.groups()
        if req.headers.get("Origin") not in ALLOWED_ORIGINS:
            return self.relay_error(403, "unofficial_client",
                                    "为防止二改中修改过的主动消息逻辑产生未经认证的流量，非官方版本不能使用官方中转")

        if rest == "_usage" and req.method == "GET":
            auth = self.authenticate(token)
            if not auth:
                return self.relay_error(401, "invalid_token", "令牌无效或已过期，请在 Discord 群里重新发 /中转令牌")
            return web.json_response(self.usage_summary(auth[0]), headers={"Access-Control-Allow-Origin": "*"})

        host, _, tail = rest.partition("/")
        path = "/" + tail
        if (req.method not in ALLOWED_METHODS or "Upgrade" in req.headers
                or not HOST_RE.match(host) or not PATH_ALLOWLIST.match(path)):
            return self.relay_error(404, "not_relayable", "中转只转发主动消息 2.0 的接口")

        auth = self.authenticate(token)
        if not auth:
            return self.relay_error(401, "invalid_token", "令牌无效或已过期，请在 Discord 群里重新发 /中转令牌")
        user_id, checked_day = auth
        if checked_day != today().isoformat():
            asyncio.create_task(self.recheck_member(user_id))

        wait = self.take_rate(user_id)
        if wait:
            return self.relay_error(429, "rate_limited", "请求太频繁，稍后再试", **{"Retry-After": str(int(wait) + 1)})
        used = self.usage_since(user_id, 1)
        if used["up"] + used["down"] >= DAILY_BYTES_CAP:
            return self.relay_error(429, "quota_exceeded", "今天的中转流量用完了，明天恢复；急用可以先关掉中转直连")

        body = await req.read()
        headers = [(k, v) for k, v in req.headers.items() if k.lower() not in DROP_REQUEST_HEADERS]
        url = URL.build(scheme=self.upstream_scheme, host=host, path=path,
                        query_string=req.rel_url.raw_query_string, encoded=True)
        down = 0
        try:
            try:
                upstream = await self.upstream.request(req.method, url, headers=headers, data=body or None,
                                                       allow_redirects=False, skip_auto_headers=("User-Agent",))
            except (aiohttp.ClientError, asyncio.TimeoutError):
                return self.relay_error(502, "upstream_unreachable", "中转连不上你的 Worker")
            async with upstream:
                resp = web.StreamResponse(status=upstream.status, reason=upstream.reason)
                for k, v in upstream.headers.items():
                    if k.lower() not in DROP_RESPONSE_HEADERS:
                        resp.headers.add(k, v)
                await resp.prepare(req)
                async for chunk in upstream.content.iter_any():
                    down += len(chunk)
                    await resp.write(chunk)
                await resp.write_eof()
                return resp
        finally:
            self.record_usage(user_id, len(body), down)

    def make_runner(self) -> web.AppRunner:
        app = web.Application(client_max_size=MAX_BODY)
        app.router.add_route("*", "/{tail:.*}", self.handle)
        # 不写访问日志；auto_decompress=False 让 gzip 请求体原样转给 Worker（默认会被 aiohttp 解压，Worker 再解一次就坏了）
        return web.AppRunner(app, access_log=None, auto_decompress=False)

    # ---------- Discord ----------

    async def reply(self, it: dict, content: str):
        async with self.discord.post(f"{API}/interactions/{it['id']}/{it['token']}/callback",
                                     json={"type": 4, "data": {"content": content, "flags": 64}}) as r:
            if r.status >= 300:
                log.warning("interaction reply failed: %s", r.status)

    def handle_command(self, it: dict) -> str | None:
        """返回要回给用户的话；不是本服务的命令返回 None（留给同一机器人的其他进程处理）。"""
        if it.get("type") != 2 or it.get("data", {}).get("name") not in COMMAND_NAMES:
            return None
        name = it["data"]["name"]
        member = it.get("member")
        if it.get("guild_id") != self.guild_id or not member:
            return "这个命令只能在 SullyOS 的群里用。"
        user_id = member["user"]["id"]

        if name == "中转令牌":
            if self.is_banned(user_id):
                return "你的中转权限已被管理员停用。"
            if self.verified_role_id not in member.get("roles", []):
                return "要先完成群里的验证（拿到「已验证」身份组）才能领中转令牌。"
            token = self.issue_token(user_id)
            return ("你的中转令牌（只显示这一次，之前的令牌已作废）：\n"
                    f"```\n{token}\n```\n"
                    "复制到 SullyOS → 设置 → 主动消息 2.0 → 中转令牌。"
                    f"连续 {TOKEN_IDLE_DAYS} 天没用会自动失效；不小心泄露了就再发一次 /中转令牌 重置。")

        if name == "中转流量":
            s = self.usage_summary(user_id)
            lines = [f"{label}：上传 {format_bytes(v['up'])} · 下载 {format_bytes(v['down'])} · {v['requests']} 次请求"
                     for label, v in (("今天", s["today"]), ("近 7 天", s["last7"]), ("近 30 天", s["last30"]))]
            status = (f"令牌领取于 {s['issuedDay']}，最近使用 {s['lastUsedDay']}。" if s["issuedDay"]
                      else "你现在没有有效的中转令牌，发 /中转令牌 领一个。")
            return "\n".join(lines + [status, f"按北京时间切日，记录保留 {USAGE_KEEP_DAYS} 天。"])

        if not int(member.get("permissions", "0")) & ADMINISTRATOR:
            return "只有管理员能用这个命令。"
        options = {o["name"]: o["value"] for o in it["data"].get("options", [])}
        target = options["用户"]
        if name == "中转吊销":
            removed = self.revoke(target)
            if options.get("禁止重新领取"):
                self.db.execute("INSERT OR IGNORE INTO banned(user_id) VALUES(?)", (target,))
            return (f"<@{target}> 的令牌已吊销。" if removed else f"<@{target}> 本来就没有令牌。") + \
                ("此人之后不能再领。" if options.get("禁止重新领取") else "")
        if name == "中转解封":
            self.db.execute("DELETE FROM banned WHERE user_id=?", (target,))
            return f"<@{target}> 可以重新领取中转令牌了。"
        return None

    async def on_interaction(self, it: dict):
        try:
            content = self.handle_command(it)
            if content is not None:
                await self.reply(it, content)
        except Exception as e:
            log.error("interaction failed: %s", type(e).__name__)

    async def register_commands(self):
        auth = {"Authorization": f"Bot {self.bot_token}"}
        async with self.discord.get(f"{API}/applications/@me", headers=auth) as r:
            r.raise_for_status()
            app_id = (await r.json())["id"]
        # 全局命令逐条 upsert：同一机器人的另一个进程会整份覆盖「群命令」清单，碰不到这里
        for cmd in COMMANDS:
            async with self.discord.post(f"{API}/applications/{app_id}/commands", headers=auth, json=cmd) as r:
                if r.status >= 300:
                    log.error("register %s failed: %s %s", cmd["name"], r.status, (await r.text())[:200])

    async def gateway_loop(self):
        backoff = 1
        while True:
            try:
                async with self.discord.ws_connect(GATEWAY, max_msg_size=0) as ws:
                    hello = await ws.receive_json()
                    interval = hello["d"]["heartbeat_interval"] / 1000
                    state = {"seq": None, "acked": True}

                    async def heartbeat():
                        await asyncio.sleep(interval * random.random())
                        while True:
                            if not state["acked"]:  # 上一跳没回音，连接已经僵死
                                await ws.close(code=4000)
                                return
                            state["acked"] = False
                            await ws.send_json({"op": 1, "d": state["seq"]})
                            await asyncio.sleep(interval)

                    beat = asyncio.create_task(heartbeat())
                    try:
                        await ws.send_json({"op": 2, "d": {"token": self.bot_token, "intents": 0, "properties": {
                            "os": "linux", "browser": "sullyos-relay", "device": "sullyos-relay"}}})
                        async for msg in ws:
                            if msg.type != aiohttp.WSMsgType.TEXT:
                                break
                            p = json.loads(msg.data)
                            if p.get("s") is not None:
                                state["seq"] = p["s"]
                            op = p.get("op")
                            if op == 0 and p.get("t") == "READY":
                                backoff = 1
                                log.info("gateway ready")
                            elif op == 0 and p.get("t") == "INTERACTION_CREATE":
                                asyncio.create_task(self.on_interaction(p["d"]))
                            elif op == 1:
                                await ws.send_json({"op": 1, "d": state["seq"]})
                            elif op == 11:
                                state["acked"] = True
                            elif op in (7, 9):
                                break
                    finally:
                        beat.cancel()
                    if ws.close_code in FATAL_GATEWAY_CLOSE:
                        log.error("gateway closed with fatal code %s, giving up", ws.close_code)
                        return
            except Exception as e:
                log.warning("gateway error: %s", type(e).__name__)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60)

    async def maintenance_loop(self):
        while True:
            try:
                self.prune()
            except Exception as e:
                log.error("prune failed: %s", type(e).__name__)
            await asyncio.sleep(3600)


async def main():
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    relay = Relay(os.environ.get("RELAY_DB", "/var/lib/amsg-relay/relay.db"),
                  guild_id=os.environ["DISCORD_GUILD_ID"], verified_role_id=os.environ["DISCORD_VERIFIED_ROLE_ID"],
                  bot_token=os.environ["DISCORD_TOKEN"])
    await relay.start()
    # 服务日志只有启动、gateway 状态和不带用户信息的错误类型
    runner = relay.make_runner()
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", int(os.environ.get("RELAY_PORT", "8787"))).start()
    try:
        await relay.register_commands()
    except Exception as e:
        log.error("command registration failed: %s", type(e).__name__)
    await asyncio.gather(relay.gateway_loop(), relay.maintenance_loop())


if __name__ == "__main__":
    asyncio.run(main())
