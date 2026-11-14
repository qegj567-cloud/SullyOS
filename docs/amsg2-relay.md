# 主动消息 2.0 · 中转连接

设置里「主动消息 2.0 → 后端 Worker」下面有一个「大陆连接优化」开关（也就是中转连接）。打开并填好中转令牌后，浏览器发给用户自己 Worker 的请求先到 SullyOS 的中转服务器，再由它转给 Worker。给大陆网络下连不上 Worker 的用户用。

## 为什么需要它

大陆网络对 `*.workers.dev` 有两层封锁：域名解析被污染（解析出来的不是 Cloudflare 的 IP），换成正确 IP 后 TLS 握手也会因为 SNI 里的域名被重置。给 Worker 绑自己的域名能绕开前者，但部分网络下连 Cloudflare 本身也不稳定，所以绑了自定义域名的用户同样可以走中转。

## 链路

```
浏览器 → https://amsg-relay.friedsully.com/t/<令牌>/<worker 域名>/<接口路径>
       → Caddy（HTTPS、粗筛）→ 本机中转服务 → 固定的 Cloudflare IP（SNI = worker 域名）→ Worker
```

| 环节 | 说明 |
|---|---|
| 中转服务器 | 洛杉矶的 DMIT 机器，与统计服务（umami）同机。Caddy 配置副本在 [`infra/Caddyfile`](../infra/Caddyfile)，中转服务在 [`infra/amsg-relay/`](../infra/amsg-relay/) |
| 为什么不放在大陆 | 大陆机房用域名提供 HTTPS 需要备案，而且大陆机器同样连不上 `workers.dev`，还得再接一跳 |
| Discord 机器人 | 复用 Sully Connect，中转服务自己连 gateway 处理几条全局命令 |
| 推送 | 不经过中转。消息由 Worker 经推送服务（APNs / FCM 等）送到设备，跟这条连接无关 |

## 客户端怎么接

- 存盘的 `workerUrl` 始终是 Worker 本身的地址。它是客户端缓存、云端数据归属、Anthropic 能力探测等处的身份标识，换成中转地址会被当成换了一台后端。
- 只在发请求那一步换地址：`utils/amsgRelay.ts` 的 `resolveWorkerFetchBase`。用到它的只有三处：`ReiClient` 的 `baseUrl`、`fetchWithAuthRaw`、一键部署后等 Worker 生效的那次探测。Service Worker 不直接请求 Worker，推送里带的是数据的键而不是 URL，所以不需要另接。
- 开关打开、令牌格式对、地址也能走中转，三样都满足才走中转，否则直连，界面上有提示。能走中转的地址：https、域名（不是 IP）、不带端口和路径，`workers.dev` 和自定义域名都行。
- 令牌放在路径里而不是请求头里：自定义请求头会让浏览器先发预检请求，预检不带这个头，Worker 也不认识它。
- 客户端缓存的键里带着实际请求地址，切换开关或换令牌后会换一条新 client。
- 开关和令牌改了立即存盘：一键部署之后等 Worker 生效、连接建表都按存盘的配置发请求。
- 令牌和中转开关只留在本机：分享出去的默认备份会把它们摘掉（和 Worker 地址、共享密钥同一份名单），勾了「带上后端连接」的自用备份才带。中转开关跟着摘，是为了导入别人的备份时不会跳过打开前的那道提醒。

## 令牌

- 在 SullyOS 的 Discord 群里发 `/中转令牌`，有「已验证」身份组才能领。机器人回一条只有本人看得到的消息，令牌只显示这一次；再发一次就是重置，旧的立即作废。
- 不在应用里用 Discord 登录：大陆打不开 discord.com，用户在群里领最稳。
- 连续 30 天没用自动失效。
- 退群或者没了「已验证」：令牌被使用时，如果当天还没核对过，就顺手查一次这个人还在不在群里、身份组还在不在，不在就作废。用的是「查单个成员」接口，不需要 Server Members 权限，也不监听退群事件；每人每天最多查一次。查询失败不动令牌。
- 管理员命令：`/中转吊销`（可选「禁止重新领取」）、`/中转解封`，只有管理员看得到。
- 打开前的提醒里写明：中转只允许正常主动消息使用，恶意滥用会被禁止使用中转，严重的会被移出社区。令牌绑着 Discord 账号，这句话才执行得了。
- 数据库只存令牌的 sha256，拿到数据库也还原不出令牌。

### 为什么注册成全局命令

同一个机器人的 `/判断有误` 进程启动时会整份覆盖这个群的命令清单，中转命令要是也注册在群里就会被删掉。全局命令是另一份清单，碰不到。命令限定只能在服务器里用（`contexts: [0]`），机器人不公开、只在这一个群里，所以效果上等于群命令。两个进程都会收到所有命令，各自只回自己的。

没用「Discord 把命令发到我们的网址」那种接法：同一个应用设了网址后，所有命令都改走网址，`/判断有误` 的长连接就收不到了。

## 只给官方渠道用

二改版本里可能带着改过的主动消息逻辑，发出的流量没经过认证，在中转看来和滥用分不清。所以官方中转只给官方渠道用，判定复用首页二改提醒那套（`utils/deploymentSource.ts`：三个官方网址，加签名校验过的官方 APK）。

- **客户端**：不是官方渠道时，「大陆连接优化」开关不能点，下面写明原因；`resolveWorkerFetchBase` 也一律直连。本地开发（localhost）判不出来源，同样不能用。
- **中转服务**：按请求头 `Origin` 放行，名单是官方网址加 `https://localhost`（官方 APK 由 Capacitor 以这个来源加载；本地开发服务器带端口，进不来）。浏览器发出的 `Origin` 页面脚本改不了，二改版本只删客户端那道闸也过不来，会收到 403 `unofficial_client`。两边名单由 `utils/amsgRelay.test.ts` 对照。
- 自己重签的 APK 也是 `https://localhost`，服务端分不出来，靠客户端的签名校验挡；非浏览器的脚本能伪造 `Origin`，这类归到「恶意滥用」，靠令牌追到账号再吊销。

## 只转发 2.0 的边界

中转如果对任意目标、任意路径放行，就会变成一个公共跳板。令牌把使用者限定在群成员之内，下面几道限制再把能做的事限定在 2.0 的接口上：

1. **只连得到 Cloudflare**：不按域名查 IP，固定连几个 Cloudflare 的公共 IP，握手时报目标域名。CF 托管的域名都能转；不在 CF 上的站点在握手阶段就失败。只认 `workers.dev` 挡不住什么：谁都能免费开一个。
2. **路径白名单**：只放行 2.0 的接口（`relay.py` 里的 `PATH_ALLOWLIST`）。
3. 带 `Upgrade` 头的请求一律拒绝（翻墙 Worker 最常见的走法），方法只放行 GET / POST / PUT / DELETE / OPTIONS。
4. **按账号限流**：每个账号一个令牌桶（容量 120 次，每秒回填 2 次），每天上下行合计 1 GB。数值是先放宽的初值，有了真实用量再收紧。

请求体上限 10MB（最大的 client-state 同步实测约 800KB）。中转自己的报错带 `X-Amsg-Relay-Error` 头（`unofficial_client` / `invalid_token` / `not_relayable` / `rate_limited` / `quota_exceeded` / `upstream_unreachable`）。

**新增 Worker 接口时要同步改白名单。** [`utils/amsgRelay.test.ts`](../utils/amsgRelay.test.ts) 会从客户端 SDK、`activeMsgClient.ts`、`worker/amsg/src/index.ts` 和 `amsg-server` 里把实际用到的路径提取出来，逐个对照 `PATH_ALLOWLIST`；漏了哪一个，它就会报哪一个。改完还要部署到线上（见「运维」）。

## 流量记录

- 每个 Discord 账号每天一行：上行字节数、下行字节数、请求次数。按北京时间切日，保留 90 天。
- 不记路径、目标 Worker、来源 IP，也不记几点几分。按账号而不是按令牌记，重置令牌后历史还在。
- 用户自己查：群里发 `/中转流量`（今天 / 近 7 天 / 近 30 天），或者在应用的中转设置里看近 30 天那一行（应用用自己的令牌请求 `/t/<令牌>/_usage`）。

## 隐私

- 中转要在中间解开 TLS 才能转发，而 2.0 的加密密钥本身也是经这条连接从 `/get-user-key` 下发的，所以中转技术上能看到经过的全部内容：消息、提示词、API Key、用户 ID 和共享密钥。中转服务不保存这些内容。
- 有了令牌，中转知道某个请求属于哪个 Discord 账号。落盘的只有上面那张流量表和令牌表（令牌哈希、领取日、最后使用日、最后核对日，都只到日期）。
- 开关在界面上叫「大陆连接优化」，旁边只留一句用途。从关到开会先弹确认窗（正文比共用弹窗默认的字大一档、颜色深一档，重点加粗），讲清以上几点、需要在群里领令牌、中转是维护者自费搭的（不保证一直能用、会尽力维护），确认按钮倒数 5 秒后才能点，确认后才存盘。关掉不弹窗，直接恢复直连。这个顺序由 `utils/activeMsgSettingsModal.test.ts` 里的用例守着。
- 用户 IP 在 Caddy 转给中转服务那一跳就去掉了，中转服务和 Worker 都拿不到。
- Caddy 的中转站点不写日志指令（Caddy 默认不记访问日志，运行时日志由全局块统一丢弃），中转服务关掉了访问日志，服务日志只有启动、gateway 状态和不带用户信息的错误类型。

## 运维

- `amsg-relay.friedsully.com` 在 Cloudflare 上必须是灰云（DNS only）。走橙云的话流量又绕回 Cloudflare，中转就白做了。
- 中转服务：`/opt/amsg-relay/relay.py`，systemd 单元 `amsg-relay`（副本 [`infra/amsg-relay/amsg-relay.service`](../infra/amsg-relay/amsg-relay.service)），只听 `127.0.0.1:8787`。依赖用发行版的 `python3-aiohttp`。机器人令牌、群 ID、「已验证」身份组 ID 在 `/etc/amsg-relay/env`（root 600，不进仓库），数据库在 `/var/lib/amsg-relay/relay.db`。内存约 40 MB，上限 150 MB。
- 改了 `relay.py`：先跑 `python3 -m unittest infra/amsg-relay/test_relay.py`，再 `scp` 到 `/opt/amsg-relay/`，`systemctl restart amsg-relay`。重启时命令会重新 upsert 一遍。
- 线上 Caddy 开着 `admin off`，`systemctl reload caddy` 会失败（旧配置照常运行），改完 Caddyfile 要 `caddy validate` 后 `systemctl restart caddy`，所有站点会断一两秒。
- 线上 `/etc/caddy/Caddyfile` 与仓库 `infra/Caddyfile` 每天由隐私审计 CI 比对指纹，改了一边要在同一天同步另一边并合进 master，否则 CI 会红。`relay.py` 不在指纹清单里。
- Caddy 中转站点里不要写日志指令，也别在注释里写出那个字面量：`assert-privacy.sh` 靠数这一行的出现次数来判断日志有没有被打开，多一处就会误判。
- 固定连的 Cloudflare IP 列在 `relay.py` 的 `CF_IPS`。不是所有 CF 的 IP 都通用（比如 `104.16.132.229` 对所有域名都回 403），换之前在 dmit 上用 `curl --resolve <worker 域名>:443:<IP>` 实测一遍。
- dmit 的网络会阵发性丢包（几分钟一阵，严重时丢一半以上），DNS 也直连 1.1.1.1、跟着一起丢。中转偶发 502、机器人偶发「应用程序没有响应」时先在机器上 `ping -c 40 -i 0.25 1.1.1.1` 看是不是这个。为此机器人对 Discord 的 DNS 缓存了 6 小时（`DISCORD_DNS_TTL`）：回复 interaction 只有 3 秒，不能每次现查 DNS。
- 中转和统计服务、以及机器上其他服务共用一个 IP。这个 IP 或 `friedsully.com` 被封的话会一起受影响。

## 不在范围内

- 一键部署、更新 Worker 时调用 Cloudflare API 的那个代理，不经过这个中转。
- 中转本身连不上时，报错里写的仍是 Worker 的域名，排查时先想到中转这一层。
