# MCP CORS 代理（用户自部署）

浏览器直连远程 MCP 服务器时，如果对方没配好 CORS（最常见：缺
`Access-Control-Expose-Headers: Mcp-Session-Id`），MCP 握手会失败。
这个 Worker 部署到**你自己的 Cloudflare 账号**，做透明转发并补上 CORS 头。

> 三种接入方式任选其一，详见 [`docs/mcp-integration.md`](../../docs/mcp-integration.md)：
> 1. **直连**：MCP 服务器 CORS 配置正确时，代理 URL 留空即可，什么都不用部署
> 2. **本地代理**：`node scripts/mcp-proxy.mjs`，适合本地 MCP（如 xiaohongshu-mcp）
> 3. **自己的 Cloudflare Worker**：就是本目录，适合云端 MCP + 不想在电脑上跑东西

## 部署

方式 A（无需装任何工具）：Cloudflare Dashboard → Workers & Pages → Create →
Quick Edit，把 `worker.js` 内容粘贴进去 → Deploy。

方式 B（命令行）：

```bash
cd worker/mcp-proxy
wrangler deploy
```

部署完会得到一个地址，形如 `https://sullyos-mcp-proxy.<你的子域>.workers.dev`。

## 防白嫖（强烈建议）

Worker 地址一旦泄露，任何人都能用它中转流量。设置一个密钥：

```bash
wrangler secret put PROXY_KEY   # 或在 Dashboard 的 Settings → Variables 里加
```

然后在 SullyOS 设置里该 MCP 服务器的「代理密钥」填同一个值。

## 在 SullyOS 里使用

设置 → 扩展连接 → MCP 服务器 → 「代理 URL」填你的 Worker 地址（「代理密钥」按需填写）。
前端会自动把请求包装成 `<代理URL>?target=<MCP服务器URL>` 转发。

## 请求协议

- `POST/GET/DELETE <worker>/?target=<url-encoded MCP URL>`
- 透传头：`Content-Type` / `Accept` / `Authorization` / `Mcp-Session-Id` /
  `MCP-Protocol-Version` / `Last-Event-ID`，以及 SullyOS MCP 设置中填写的自定义请求头
- 鉴权头：`X-Proxy-Key`（设置了 `PROXY_KEY` 才校验）
- 拒绝内网/本机目标地址（SSRF 防护）
- SSE 流式响应原样透传
