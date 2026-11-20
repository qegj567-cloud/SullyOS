# 网易云音乐代理与播放直链

入口：音乐 App（`apps/MusicApp.tsx`）、全局播放上下文（`context/MusicContext.tsx`）、中心代理 Worker `/netease/*`（`worker/index.js`）。多上游扩容步骤见 [`notes/music-scaling.md`](../notes/music-scaling.md)。

## 链路分工

- 浏览器将请求发往当前生效的代理 Worker（`POST /netease/<action>`，登录凭据放请求头 `X-Netease-Cookie`），由 Worker 转成 GET 参数转发给部署在 Vercel / Deno Deploy 等平台上的 `api-enhanced` 实例。
- 音频流本身不经过 Worker：拿到 `*.music.126.net` 签名直链后，全局 `<audio>` 元素（不设 `crossOrigin`，避免缺 CORS 头静默失败）由用户浏览器直连网易云 CDN 播放。

## 播放直链通道选择与风控兜底

`api-enhanced` 的 `/song/url/v1` 默认走网易云客户端加密通道（`eapi` / `xeapi`）。在海外 Serverless 机房（如 Vercel 美东节点）上，冷启动实例缺少持久化设备 Cookie `NMTID`，叠加机房共享出口 IP 时，客户端通道极易触发网易云 `-460`（`"检测到您的网络环境存在风险，请稍后再试"`，HTTP 400 或 200）；同一实例上的网页端加密通道（`crypto=weapi`）会自动补齐临时设备标识，风控阈值显著宽松。

因此 Worker 按请求的音质档位分两路处理 `song/url`：

| 档位 | 首轮通道 | 失败兜底 | 取舍说明 |
| --- | --- | --- | --- |
| `standard` / `higher` / `exhigh`（默认 320 kbps） | 直接附带 `crypto=weapi` | 多上游轮询 | 320 kbps 及以下网页端通道与客户端通道音质一致，一次请求即可避开 `-460` |
| `lossless` / `hires` | 先走 `api-enhanced` 默认通道 | 全部上游失败时自动改挂 `crypto=weapi` 重试一轮 | 正常情况下保留无损与 24bit Hi-Res；遇到风控时自动退回网页端通道保住可播放性（部分 Hi-Res 曲目兜底时会降为无损或 320 kbps） |

风控判定规则：

- 无论 `NETEASE_UPSTREAMS` 配置了 1 个还是多个上游，也无论上游 HTTP 状态码是 200 还是 400，只要响应 JSON 的 `code` 为 `-460` 或 `-7`，`fetchFromAnyUpstream` 一律按风控失败处理，继续尝试下一个上游或触发 `weapi` 兜底；全部失败时返回 502 与可读提示，防止风控报文被当作成功结果透传或写入缓存。
- 客户端 `playSong` 用 `Promise.allSettled` 独立结算播放直链与歌词请求：即便某首歌因版权或风控拿不到播放直链，已拉回的歌词仍正常显示，不会连带落成 `no lyrics`。

## 缓存隔离与防污染

音乐请求经过两层短期缓存：Cloudflare Worker 边缘缓存（`NETEASE_CACHE_TTL`）与浏览器本地缓存（`utils/musicCache.ts`）。为避免跨账号串桶或把瞬时异常锁进缓存窗口，两层共同遵守以下约束：

- **账号级边缘分桶**：`song/url` 的返回内容取决于具体账号是否开通黑胶 VIP。无 Cookie 请求归入 `anon` 桶；带 Cookie 请求对去空白后的凭据做 SHA-256 摘要，取前 16 位十六进制（`u_<hash>`）作为缓存桶标识。这样既不在缓存键里出现明文 `MUSIC_U`，也不会让普通登录账号拿到的试听版污染同边缘节点下的会员账号。
- **有效结果才入缓存**：
  - 边缘缓存仅在 JSON `code === 200` 时写入；对 `song/url` 额外要求每首都有非空 `url` 且 `freeTrialInfo` 为空（排除空直链与 30～45 秒试听片段），对 `mv/url` 要求 `data.url` 非空。用户刚登录或刚续费会员后再次点播可立即回源拿到完整版。
  - 客户端 `musicCache` 同样拒绝缓存 `code !== 200` 的响应以及 `url` 为空的 `/song/url` 结果，避免单次异常把歌词（24 小时 TTL）或直链（90 秒 TTL）锁死在失败状态。

## Cookie 规范化与诊断

- `normalizeCookie`：裸填令牌值时自动补 `MUSIC_U=` 前缀；若用户从浏览器开发者工具整段复制了含多字段的 Cookie 串（如 `NMTID=...; MUSIC_U=...; __csrf=...`），识别到 `MUSIC_U=` 键值对后原样保留整串，不重复叠加前缀，同时让上游能一并利用其中的 `NMTID` 与 `__csrf`。
- 音乐 App「设置 → 诊断（搜索晴天）」同时探测 `/netease/search` 与 `/netease/song/url`，防止出现「搜歌通但拿播放直链被风控」时诊断面板误报一切正常。
