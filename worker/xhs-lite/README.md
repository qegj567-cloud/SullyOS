# XHS Lite — 小红书 Lite 后端（已并入 worker/index.js）

让 SullyOS 角色**无浏览器、无隧道、无 Python、无扫码**地浏览 / 搜索 / 看详情 /
点赞 / 收藏 / 评论 / 发帖（带图），用户**只需粘贴一次 cookie**。

## 它在哪、怎么用

实现已**直接嵌入主 Worker** `worker/index.js`（即已部署的 `https://proxy.friedsully.com`），
作为隔离的 `XHSLite` 模块，对外暴露 `/api/<command>` 桥接接口，和
`scripts/xhs-bridge.mjs` 完全兼容，前端 bridge 模式直接复用。

**部署（运营方做一次）：** 像平时一样重新部署 `worker/index.js` 即可，URL 不变。

**用户侧（不需要电脑/部署）：** SullyOS → 设置 → 实时感知 → 小红书：
- 服务器 URL 已默认 `https://proxy.friedsully.com/api`，一般无需改。
- 粘贴浏览器登录 `xiaohongshu.com` 或 `rednote.com` 后的完整 cookie（含 `a1` 和
  `web_session`），点测试连接。Lite 会分别探测国内与全球后端并自动选择，不依赖
  `gid`、`bRequestId` 等可能随域名和灰度版本变化的字段。

cookie 存在本地，每次请求经 `X-Xhs-Cookie` 头发给 Worker；Worker 无状态，
一个部署服务所有用户。

国内小红书和全球 RedNote 是两套不共享会话的后端：前者请求
`edith.xiaohongshu.com`，后者请求 `webapi.rednote.com`。当前 RedNote 支持搜索、
浏览、详情、点赞、收藏和评论；图片发布仍只对已验证的国内后端开放。

## 卡片原帖链接

2026-11-13：前端聊天卡片使用原生链接，手机采用 `/discovery/item/<id>` 详情路径，桌面保留网页路径。搜索结果记录 `pc_search`，用户分享保留原链接的域名、token 和来源参数，详情补全不再覆盖已有搜索来源；RedNote 结果保留对应站点。卡片底部可长按复制链接，卡片其余部分仍使用消息长按菜单。缺少有效笔记 ID 时显示按标题搜索的提示。

这些修改只需发布前端。Lite 能搜索不等于手机小红书 App 已接收原帖跳转，程序不能确认外部 App 最后停在哪一页；旧卡片遗失的访问参数无法凭空补回，可重新搜索后分享。自动化验证覆盖参数、站点、手机路径和卡片链接渲染，不替代 iOS Safari 与小红书 App 的真机验收。

## 原理

- `x-s` / `x-s-common` / `x-t`：纯数学算法，移植自
  [Cloxl/xhshow](https://github.com/Cloxl/xhshow)（MIT），无 eval / 无 DOM。
- 图片上传签名 `getSignature`：HMAC-SHA1 + SHA1（来自 Spider_XHS），用 Web Crypto 实现。
- 发帖带图：Worker `fetch` 图床/CDN 图片字节 → 算上传签名 → `PUT` 到小红书 ROS →
  拿 `file_id` 发帖。

> ⚠️ `x-rap-param` 只在上游 RAP 白名单明确要求的链路启用；当前“我的笔记” (`user_posted`) 和评论/回复 (`comment/post`) 会携带，搜索/详情仍保留已验证的稳定请求形态。
> 签名随小红书改版会失效，到时同步上游 xhshow 更新 `worker/index.js` 里的 `XHSLite`。

## 验证签名（与 Python 原版逐字节比对）

```bash
git clone https://github.com/Cloxl/xhshow /tmp/xhshow
pip install pycryptodome
cd worker/xhs-lite/test
PYTHONPATH=/tmp/xhshow/src python3 oracle.py > vectors.json
node verify.mjs   # 期望 10 passed, 0 failed —— 直接测 worker/index.js 内嵌实现
```

| 文件 | 作用 |
|------|------|
| `worker/index.js` (XHSLite 段) | 部署用的签名 + API 实现（唯一真源） |
| `test/oracle.py` | Python 参考 oracle（确定性向量） |
| `test/vectors.json` | 参考输出 |
| `test/verify.mjs` | 导入 `worker/index.js` 内嵌实现并逐字节比对 |
## Spider Session v3 comments (default on)

This is an isolated, browserless experiment derived from the public protocol behavior in
`cv-cat/Spider_XHS` as of 2026-07-25. It does not replace the normal Lite detail path.
The Worker keeps no account or session database: the browser persists an opaque state containing
only an `a1` hash tag, `loadts`, counters, and a b1 seed. The raw Cookie remains in the existing
local SullyOS configuration.

Safety rules:

- The normal `/api/get-feed-detail` path never calls the protected comment endpoint.
- The experiment requires both `X-Xhs-Experiment-Ack: spider-v3-isolated-cookie` and
  `acknowledge_risk: true`.
- Each invocation makes at most one comment request. HTTP 406 opens a per-Cookie circuit breaker;
  there is no automatic retry or strategy rotation.
- The default `no-client-hints` strategy removes `sec-ch-ua*` and `x-mns`.
  `browser-hints` and `legacy-transport` are explicit one-shot A/B controls only.
- Responses use `Cache-Control: no-store`. Use a disposable test account first.

The client now enables this path by default whenever a Lite detail response has no comments.
Opening a note automatically patches its comment section; callers do not need a per-note `load_all_comments` flag or a separate API key.

Optional A/B strategy:

```js
localStorage.setItem('os_xhs_spider_v3_strategy', 'no-client-hints');
// Other explicit values: 'browser-hints', 'legacy-transport'
```

Reset the client-owned state and circuit breaker before another isolated trial:

```js
localStorage.removeItem('os_xhs_spider_v3_session');
localStorage.removeItem('os_xhs_spider_v3_circuit');
```
