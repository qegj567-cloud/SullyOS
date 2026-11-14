"""中转服务的回归测试。跑法：python3 -m unittest infra/amsg-relay/test_relay.py（需要 aiohttp）。

上游用本机一个假 Worker 代替：解析器把任何域名都指到 127.0.0.1，协议换成 http。
"""
import asyncio
import gzip
import os
import socket
import sys
import tempfile
import unittest
from datetime import timedelta
from unittest import mock

from aiohttp import ClientSession, web
from aiohttp.abc import AbstractResolver
from yarl import URL

sys.path.insert(0, os.path.dirname(__file__))
import relay as R  # noqa: E402

GUILD, ROLE = "100", "200"


class LocalResolver(AbstractResolver):
    def __init__(self, port):
        self.port = port

    async def resolve(self, host, port=0, family=socket.AF_INET):
        return [{"hostname": host, "host": "127.0.0.1", "port": self.port, "family": socket.AF_INET,
                 "proto": 0, "flags": 0}]

    async def close(self):
        pass


class RelayTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.seen = []

        async def fake_worker(req):
            if req.path == "/instant-chat":  # 流式回复：两段之间隔 0.5 秒
                resp = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
                await resp.prepare(req)
                await resp.write(b"data: first\n\n")
                await asyncio.sleep(0.5)
                await resp.write(b"data: second\n\n")
                await resp.write_eof()
                return resp
            body = await req.read()
            self.seen.append({"path": req.raw_path, "host": req.headers.get("Host"), "body": body,
                              "headers": dict(req.headers)})
            return web.Response(body=gzip.compress(b"z" * 3000), headers={
                "Content-Encoding": "gzip", "Content-Type": "application/json"})

        up_app = web.Application()
        up_app.router.add_route("*", "/{tail:.*}", fake_worker)
        self.up_runner = web.AppRunner(up_app, auto_decompress=False)
        await self.up_runner.setup()
        up_site = web.TCPSite(self.up_runner, "127.0.0.1", 0)
        await up_site.start()
        up_port = up_site._server.sockets[0].getsockname()[1]

        self.tmp = tempfile.TemporaryDirectory()
        self.relay = R.Relay(os.path.join(self.tmp.name, "r.db"), guild_id=GUILD, verified_role_id=ROLE,
                             upstream_scheme="http", upstream_resolver=LocalResolver(up_port))
        await self.relay.start()
        self.runner = self.relay.make_runner()
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        self.base = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"
        self.http = ClientSession(auto_decompress=False, headers={"Origin": "https://friedsully.com"})

    async def asyncTearDown(self):
        await self.http.close()
        await self.runner.cleanup()
        await self.up_runner.cleanup()
        await self.relay.close()
        self.tmp.cleanup()

    def command(self, name, user="1", roles=(ROLE,), permissions="0", options=None, guild=GUILD):
        return {"type": 2, "guild_id": guild, "data": {"name": name, "options": options or []},
                "member": {"user": {"id": user}, "roles": list(roles), "permissions": permissions}}

    def issue(self, user="1"):
        reply = self.relay.handle_command(self.command("中转令牌", user=user))
        return reply.split("```\n")[1].split("\n")[0]

    async def test_forwards_raw_bytes_and_counts_usage(self):
        token = self.issue()
        payload = gzip.compress(b"y" * 5000)
        # encoded=True：测试客户端自己别先把 %2F 规整成 /，才验得出中转原样转发查询串
        async with self.http.post(URL(f"{self.base}/t/{token}/a.b.workers.dev/client-state?x=1%2F2", encoded=True),
                                  data=payload,
                                  headers={"Content-Encoding": "gzip", "X-Forwarded-For": "1.2.3.4",
                                           "X-User-Id": "u"}) as r:
            body = await r.read()
            self.assertEqual(r.status, 200)
            self.assertEqual(r.headers["Content-Encoding"], "gzip")
        self.assertEqual(gzip.decompress(body), b"z" * 3000)
        got = self.seen[-1]
        self.assertEqual(got["path"], "/client-state?x=1%2F2")
        self.assertEqual(got["host"], "a.b.workers.dev")
        self.assertEqual(got["body"], payload)  # 请求体没被中途解压
        self.assertNotIn("X-Forwarded-For", got["headers"])
        self.assertEqual(got["headers"]["X-User-Id"], "u")
        usage = self.relay.usage_since("1", 1)
        self.assertEqual(usage, {"up": len(payload), "down": len(body), "requests": 1})

    async def test_custom_domain_allowed_but_ip_and_other_paths_rejected(self):
        token = self.issue()
        async with self.http.get(f"{self.base}/t/{token}/amsg.example.cc.cd/messages") as r:
            self.assertEqual(r.status, 200)
        for bad in ("1.2.3.4/messages", "a.b.workers.dev/", "a.b.workers.dev/v1/proxy",
                    "a.b.workers.dev/messages/extra", "localhost/messages"):
            async with self.http.get(f"{self.base}/t/{token}/{bad}") as r:
                self.assertEqual(r.status, 404, bad)
                self.assertEqual(r.headers["X-Amsg-Relay-Error"], "not_relayable")
        async with self.http.get(f"{self.base}/t/{token}/a.b.workers.dev/messages",
                                 headers={"Upgrade": "websocket", "Connection": "Upgrade"}) as r:
            self.assertEqual(r.status, 404)

    async def test_invalid_reset_and_idle_tokens_rejected(self):
        old = self.issue()
        new = self.issue()  # 重置：旧令牌立即作废
        async with self.http.get(f"{self.base}/t/{old}/a.b.workers.dev/messages") as r:
            self.assertEqual(r.status, 401)
            self.assertEqual(r.headers["Access-Control-Allow-Origin"], "*")
        async with self.http.get(f"{self.base}/t/{new}/_usage") as r:
            self.assertEqual(r.status, 200)
            self.assertIn("last30", await r.json())
        stale = (R.today() - timedelta(days=R.TOKEN_IDLE_DAYS + 1)).isoformat()
        self.relay.db.execute("UPDATE tokens SET last_used_day=?", (stale,))
        async with self.http.get(f"{self.base}/t/{new}/_usage") as r:
            self.assertEqual(r.status, 401)
        self.assertIsNone(self.relay.db.execute("SELECT 1 FROM tokens").fetchone())

    async def test_rate_limit_and_daily_quota(self):
        token = self.issue()
        with mock.patch.object(R, "RATE_BURST", 2), mock.patch.object(R, "RATE_PER_SEC", 0.001):
            self.relay.buckets.clear()
            codes = []
            for _ in range(3):
                async with self.http.get(f"{self.base}/t/{token}/a.b.workers.dev/outbox") as r:
                    codes.append(r.status)
            self.assertEqual(codes, [200, 200, 429])
        self.relay.buckets.clear()
        self.relay.record_usage("1", R.DAILY_BYTES_CAP, 0)
        async with self.http.get(f"{self.base}/t/{token}/a.b.workers.dev/outbox") as r:
            self.assertEqual(r.headers["X-Amsg-Relay-Error"], "quota_exceeded")

    async def test_unofficial_origin_rejected(self):
        token = self.issue()
        for origin in ({"Origin": "https://fork.github.io"}, {"Origin": "http://localhost:5173"}, {"Origin": ""}):
            async with self.http.get(f"{self.base}/t/{token}/a.b.workers.dev/messages", headers=origin) as r:
                self.assertEqual(r.status, 403, origin)
                self.assertEqual(r.headers["X-Amsg-Relay-Error"], "unofficial_client")
        self.assertEqual(self.seen, [])  # 一个都没转出去
        async with self.http.get(f"{self.base}/t/{token}/a.b.workers.dev/messages",
                                 headers={"Origin": "https://localhost"}) as r:
            self.assertEqual(r.status, 200)  # 官方 APK

    async def test_streaming_reply_is_not_buffered(self):
        token = self.issue()
        loop = asyncio.get_running_loop()
        start = loop.time()
        async with self.http.post(f"{self.base}/t/{token}/a.b.workers.dev/instant-chat", data=b"{}") as r:
            first = await r.content.readuntil(b"\n\n")
            first_at = loop.time() - start
            rest = await r.read()
        self.assertEqual(first, b"data: first\n\n")
        self.assertLess(first_at, 0.4)  # 第一段没等第二段就到了
        self.assertEqual(rest, b"data: second\n\n")

    async def test_commands(self):
        h = self.relay.handle_command
        self.assertIsNone(h({"type": 2, "guild_id": GUILD, "data": {"name": "判断有误"}}))  # 别的进程的命令不回
        self.assertIn("已验证", h(self.command("中转令牌", roles=())))
        self.assertIn("只能在", h(self.command("中转令牌", guild="999")))
        self.issue(user="7")
        self.assertIn("只有管理员", h(self.command("中转吊销", options=[{"name": "用户", "value": "7"}])))
        admin = str(R.ADMINISTRATOR)
        h(self.command("中转吊销", permissions=admin,
                       options=[{"name": "用户", "value": "7"}, {"name": "禁止重新领取", "value": True}]))
        self.assertIn("停用", h(self.command("中转令牌", user="7")))
        h(self.command("中转解封", permissions=admin, options=[{"name": "用户", "value": "7"}]))
        self.assertIn("```", h(self.command("中转令牌", user="7")))
        self.assertIn("近 30 天", h(self.command("中转流量", user="7")))

    async def test_member_recheck_revokes_when_left_or_role_lost(self):
        self.relay.bot_token = "x"
        for status, member in ((404, None), (200, {"roles": []})):
            self.issue()

            class Resp:
                def __init__(self):
                    self.status = status

                async def json(self):
                    return member

                async def __aenter__(self):
                    return self

                async def __aexit__(self, *a):
                    return False

            with mock.patch.object(self.relay.discord, "get", return_value=Resp()):
                await self.relay.recheck_member("1")
            self.assertIsNone(self.relay.db.execute("SELECT 1 FROM tokens WHERE user_id='1'").fetchone())


if __name__ == "__main__":
    unittest.main()
