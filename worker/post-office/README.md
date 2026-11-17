# 彼方虚拟邮局 · 后端 Worker

> 正式公共服务已迁往 [`../bifang/`](../bifang/)，Worker / D1 名称为 `bifang`，入口 `https://bifang.friedsully.com/po`。本目录保留共用邮局实现和旧部署模板；当前迁移与诗句归属恢复见 [bifang 说明](../../docs/bifang-migration.md)。

跨用户漂流信的**共享后端**（Cloudflare Worker + D1）。所有用户共用同一个实例，
其他用户无需任何配置。匿名：客户端只带一个随机 `deviceId`（owner_id），无登录、无 PII。

## 部署

```bash
cd worker/post-office
wrangler d1 create sullyos-post-office          # 拿到 database_id
# 把 database_id 填到 wrangler.toml 的 [[d1_databases]]
wrangler secret put ADMIN_TOKEN                 # 管理员令牌（删信用）
wrangler secret put PO_IP_SALT                  # 限流哈希盐（随便一串长随机值）
wrangler deploy
```

表结构由 Worker 自动建，**加性升级、不破坏老数据**（老库会自动补 `likes/dislikes/views` 列、
新建 `po_devices/po_votes/po_ratelimit`），不必手动跑 `schema.sql`。

### 挂到统一域名（如 noir2.cc.cd/po）

二选一：

- **A. 单独部署 + 路由**：部署本 worker，然后在 Cloudflare 给 `noir2.cc.cd/po/*`
  加一条 Route 指向它。客户端默认就是 `https://noir2.cc.cd/po`。
- **B. 合并进现有 worker**：把 `src/index.ts` 的 `fetch` 逻辑并进你现有的 noir2
  worker（按 path 结尾匹配，和现有 push 路由不冲突），并绑定 D1 `DB`。

客户端后端地址可在「彼方 → 邮局 → ⚙」里改（默认 `https://noir2.cc.cd/po`）。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET  | `/health` | 健康检查（含是否配置了管理员） |
| POST | `/letters` | `{device, letters:[{pen,content,lang?}]}` 上传待寄出的信 |
| GET  | `/inbox?device=X&limit=N` | 随机抽 N 封"别人的、还能回"的信（标记已抽避免重复；抽到即 +1 浏览量） |
| POST | `/vote` | `{device, letterId, vote: 1\|-1\|0}` 点赞 / 点踩(=举报) / 撤销 |
| POST | `/replies` | `{device, replies:[{letterId,pen,content}]}` 上传回信（每封信最多 `PO_MAX_REPLIES` 个设备能回） |
| GET  | `/replies?device=X` | 取回"我寄出的信"上的回复 + 各信的赞/踩/浏览量 |
| POST | `/release` | `{device, letterIds:[...]}` 作者删自己的信（连同回复/抽取/投票） |
| GET  | `/admin/list?token=&limit=` | **[管理]** 列信（按点踩降序），找要删的 id |
| POST | `/admin/delete` | **[管理]** `{letterId}` 或 `{letterIds:[...]}`，删信 |

管理接口凭 `ADMIN_TOKEN`：`Authorization: Bearer <token>` 或 `?token=<token>`。未配置则一律 401/503。

## 互动与防护

- **点赞 / 点踩**：一台设备对一封信只能一票（可改可撤）。**点踩即举报**，不另设举报。
- **自动删除**：一封信点踩数达 `PO_DISLIKE_LIMIT`（默认 5）即被删除（硬删，不可恢复）。
- **正文上限**：每条信/回信正文上限 **400 字**（按字符，1 汉字/标点=1 字），超出截断。
- **限流**：按客户端 IP 的加盐哈希做固定窗口限流，不存原始 IP——
  **投信：每 IP 每 5 小时 5 条**；回信/投票：每分钟（可调）。
- **不按时间删**：已移除旧的 TTL 自动清理。信只在 ①点踩满 ②管理员删 ③作者删 时消失。

## 环境变量

| 名字 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `PO_MAX_REPLIES` | var | 3 | 一封信最多被几个设备回信 |
| `PO_DISLIKE_LIMIT` | var | 5 | 点踩(=举报)数达此值即自动删信 |
| `PO_RATE_LETTERS` | var | 5 | 每 IP 每 **5 小时** 投信上限 |
| `PO_RATE_REPLIES` | var | 60 | 每 IP 每分钟回信上限 |
| `PO_RATE_VOTES` | var | 120 | 每 IP 每分钟投票上限 |

> 正文上限固定 **400 字**（按字符，1 汉字/标点=1 字），写死在 `src/index.ts`（`MAX_CONTENT`）。
| `ADMIN_TOKEN` | secret | — | 管理员令牌；未配置则 /admin/* 关闭 |
| `PO_IP_SALT` | secret | — | 限流哈希盐；不可逆化 IP，建议配置 |

## 信件生命周期

```
待发送(本地草稿) ─[一键寄出]→ POST /letters → 公共池
   其他用户 ─[刷新收件箱]→ GET /inbox（随机抽，非自己的，+1 浏览量）
            ├─[点赞/点踩]→ POST /vote（点踩满 PO_DISLIKE_LIMIT 自动删）
            └─[回信]→ POST /replies（挂到该信）
作者 ─[收取回复/看热度]→ GET /replies → 落本地留档 ─→ POST /release（删自己的信）
   管理员 ─[巡查]→ GET /admin/list ─[下架]→ POST /admin/delete
```

## 空间优化

`po_devices` 把长 `owner_id`(UUID) 映射成短整数 `uid`；多行的投票表 `po_votes` 只存 `uid`，
避免反复存 36 字节的 UUID 字符串。对外 API 仍只认 `owner_id`，客户端无感知。
