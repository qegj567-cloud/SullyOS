# 网易云音乐后端 · 多上游扩容指南

1000 用户量级下，单一 Vercel 部署会卡在三个地方：
1. **Vercel Hobby 的 GB-Hours 配额**（约 72 万次请求/月会打满）
2. **Vercel Hobby 条款禁止商用**（1000 用户可能被判商用）
3. **NetEase 风控**（单 IP 请求过多会被封 `-460/-7`）

这份教程带你把后端扩容到 **2~3 个上游**，让 Worker 随机挑选 + 自动容灾。

---

## 效果

做完之后你会有：

```
📱 前端
 │
 ▼
☁️ Cloudflare Worker (带边缘缓存)
 │ 随机挑 + 容灾
 ├──▶ 🟢 Vercel 主站 (原有)
 ├──▶ 🦕 Deno Deploy (免费 100万 req/天)        ← 本教程新增
 └──▶ 🟢 Vercel 二站 (可选 · 双倍配额)           ← 本教程新增
```

**单项收益**：
- 边缘缓存：Vercel 调用量 ↓ **50~70%**
- Deno Deploy：另一条完全独立的国外线路 + 独立 IP
- 多 Vercel：总配额 ×2

---

## 方案 A · 加 Deno Deploy（强烈推荐，5 分钟）

Deno Deploy 是 Deno 官方托管，免费版就有 **100 万 req/天**，比 Vercel 爽 10 倍。

### 1. Fork api-enhanced

打开 <https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced>，右上角 **Fork**。

### 2. 确认仓库里有 Deno 入口

在 Fork 后的仓库里应该能找到 `app.mjs` 或 `server.mjs`。如果没有 Deno 专用入口，用下面这段代码创建一个文件 `deno.ts`：

```ts
// deno.ts — Deno Deploy 专用入口
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { serveNeteaseApi } from "./app.js";

serve(async (req) => {
  return await serveNeteaseApi(req);
});
```

> 💡 如果上面这段看不懂，跳过方案 A，直接看下面的**方案 B（第二个 Vercel）**，更简单。

### 3. 去 Deno Deploy 部署

1. 打开 <https://dash.deno.com/>（用 GitHub 登录）
2. 右上角 **New Project**
3. 选择 **Deploy from GitHub**，找到你刚 Fork 的 `api-enhanced`
4. **Entry point**：输入 `app.mjs`（或你创建的 `deno.ts`）
5. 点 **Deploy** ✅

拿到类似 `https://你的项目名-xxx.deno.dev` 的 URL。

### 4. 测试是否能用

在浏览器打开：
```
https://你的项目名-xxx.deno.dev/cloudsearch?keywords=晴天&limit=3
```

能返回一段包含"晴天"、"周杰伦"字样的 JSON 就是成功了 🎉

### 5. 加到 Worker 的多上游数组

编辑 `worker/index.js` 大约第 575 行：

```js
const NETEASE_UPSTREAMS = [
  "https://api-enhanced-ochre-kappa.vercel.app",
  "https://你的项目名-xxx.deno.dev",  // ← 把这行取消注释 + 粘贴你的 URL
];
```

重新部署 Worker（Cloudflare 控制台 → Edit Code → Deploy）。

---

## 方案 B · 再开一个 Vercel 部署（3 分钟，最简单）

如果 Deno 那套搞不定，退而求其次：**再部署一份 api-enhanced 到 Vercel**。配额立刻翻倍。

建议用**另一个 GitHub 账号**登录 Vercel 做二部署，这样两个 Vercel 的配额是分别计费的。但同一个账号也能部 —— 只是总配额不变，仅起到 IP 分流的作用（对抗 NetEase 风控依然有效）。

### 步骤

1. 登录 Vercel（可以开小号）
2. 点 **New Project** → 选择 **api-enhanced** 仓库
3. 一键 Deploy（不用改任何设置）
4. 拿到 `https://api-enhanced-mirror-xxx.vercel.app` 这样的 URL

### 加到 Worker

```js
const NETEASE_UPSTREAMS = [
  "https://api-enhanced-ochre-kappa.vercel.app",
  "https://api-enhanced-mirror-xxx.vercel.app",  // ← 粘贴你的 URL
];
```

重新部署 Worker。

---

## 方案 C · 自己的 VPS（最稳，月花 $3-5）

如果愿意花点小钱，买一台 VPS 自己跑 api-enhanced：

- **Oracle Cloud Free Tier** — 永久免费 (2 台 AMD/4 台 ARM)
- **Hetzner CX11** — €4/月 起
- **Bandwagon Host** — $18/年起

用 Docker 一把梭：
```bash
docker run -d --restart=always -p 3000:3000 --name netease-api \
  binaryify/netease_cloud_music_api:latest
```

然后给域名配反代（或直接用 `http://你的VPS-IP:3000`），加进 `NETEASE_UPSTREAMS`。

---

## 怎么验证缓存生效

浏览器 F12 → Network，找一个 `lyric` 或 `search` 请求，看 Response Headers：

- **第一次请求**：`X-Sully-Cache: MISS` + `X-Sully-Upstream: xxx.vercel.app`
- **第二次相同请求**：`X-Sully-Cache: HIT`（没有 `X-Sully-Upstream`，因为没打上游）

如果第二次还是 MISS，可能是：
- 请求带了 cookie（比如 `song/url` 会按 VIP 分桶）
- 查询参数里有动态值（比如每次不同的 timestamp）

---

## 缓存 TTL 参考

| 接口 | 缓存时长 | 理由 |
|---|---|---|
| `lyric` | 30 天 | 歌词几乎永远不变 |
| `song/detail`、`album`、`artists` | 1 小时 | 元数据稳定 |
| `search`、`toplist`、`banner` | 10~30 分 | 结果更新慢 |
| `playlist/detail`、`playlist/track/all` | 10 分 | 歌单偶尔更新 |
| `song/url`、`mv/url` | 3 分 | 签名 URL 5 分过期 |
| `user/*`、`likelist`、`login/*` | **不缓存** | 用户私有数据 |
| `personal_fm`、`recommend/songs` | **不缓存** | 个性化每次不同 |

要改 TTL 直接改 `worker/index.js` 里 `NETEASE_CACHE_TTL` 对象就行。

---

## 监控 & 观察

### Cloudflare Worker

<https://dash.cloudflare.com/> → Workers & Pages → 你的 worker → **Metrics** 标签。重点看：
- **Requests** / 天 —— 免费上限 **100,000**
- **CPU Time** —— 免费上限 10ms/请求

### Vercel

<https://vercel.com/dashboard> → 进入项目 → **Usage** 标签。重点看：
- **Serverless Function Execution** —— Hobby 上限 **100 GB-Hours/月**
- **Edge Middleware Invocations**
- **Bandwidth** —— Hobby 上限 **100 GB/月**

接近 80% 就该开第二个上游了。

### 网易风控告警

Worker 的 `fetchFromAnyUpstream` 已经自动识别 `code=-460/-7` 并切换上游。但如果**所有上游都被风控**，前端会收到：

```json
{ "error": "网易云接口触发风控，请稍后再试",
  "detail": "xxx.vercel.app risk-control (code=-460) | yyy.deno.dev risk-control (code=-460)",
  "tried": 2 }
```

出现这个就说明 NetEase 盯上你了，需要：
- 再加一个新上游（新 IP）
- 临时换一下 `NETEASE_REAL_IP` 常量里的 IP
- 给 Worker 加速率限制（防止单用户刷爆）

---

## 终极版建议（>1000 用户）

1. **Vercel 主站**（原有，2~3 倍 Pro 扩容 $20/月）
2. **Deno Deploy**（免费，国外流量主力）
3. **VPS 一台**（Oracle 免费 / Hetzner €4）承担国内慢线路
4. Worker 里加**按 cookie 限速**（1000 user 每人每秒不超过 2 req）
5. 监控 Vercel Usage，每月 1 号看一次

做完这些，百级到万级用户都能稳。
