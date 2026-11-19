# 自部署 SullyOS 后端 Worker

这个仓库放的是 SullyOS 几个后端 Worker 打好的成品代码。你 **fork 一份、在 Cloudflare 连上它**，之后每次上游更新，你只要在 GitHub 点一下「Sync fork」，Cloudflare 就会自动重新部署——不用再复制粘贴几百 KB 的代码，手机上也能操作。

内容物：

| 目录 | 是什么 | 需要 D1 数据库 |
|------|--------|---------------|
| `amsg/` | 主动消息 2.0：角色到点主动发消息给你 | 需要 |
| `mcp-proxy/` | MCP 工具代理：让角色能连你自己配的 MCP 工具服务器 | 不需要 |

每个都是独立的，只部署你要用的那个就行。

> 只部署主动消息（`amsg/`）的话，SullyOS 那边还有一份带截图的完整版：
> [主动消息 2.0 · 从零开始的部署手册](https://github.com/qegj567-cloud/SullyOS/blob/master/docs/amsg2-setup-walkthrough.md)。

---

## 一次性准备

### 1. Fork 这个仓库

页面右上角「Fork」。这一步之后你就有了自己的一份副本。

### 2. 建 D1 数据库（只有 `amsg/` 需要，其余跳过）

Cloudflare 面板 → 左侧 **Storage & databases** → **D1 SQLite Database** → **Create Database**，名字随便起（比如 `sullyos-amsg`）。

建好后会跳进这个库的 Overview 页，把 **Database ID** 复制下来（一串 uuid，长这样 `3f2b1c8a-9d4e-...`）。

> 表结构不用管：SullyOS 里点「连接」时会自动建表。

### 3. 在 Cloudflare 连上仓库

Cloudflare 面板 → **Compute** → **Workers & Pages** → 右上角 **Create application** → 选 **Continue with GitHub**（第一次会跳去 GitHub 授权），在仓库列表里选中你 fork 的仓库，点 **Next**。

往下滚到 **Set up your application**：

| 位置 | 填什么 |
|------|--------|
| Project name | 随便起，比如 `sullyos-amsg` |
| Build command | `sh ./deploy-prepare.sh` |
| Deploy command | 保持默认的 `npx wrangler deploy` |

再点 **Advanced settings** 展开：

| 位置 | 填什么 |
|------|--------|
| Path | 你要部署的那个子目录：`/amsg` 或 `/mcp-proxy` |
| API token | 下拉选 **Create new token**，名字随便起 |
| Variable name / value | 只有 `amsg/` 需要：`D1_DATABASE_ID` = 上一步复制的 Database ID |

> Variable value 旁边有个 **Encrypt**，**别点**——这个值要在构建阶段被读到，而且 Database ID 本身不是敏感信息。

> 代码已经是打包好的，那条构建命令不编译任何东西——它只做一件事：把 Database ID 填进 `wrangler.toml`。这样你就不用去 GitHub 上编辑代码了。

点右下角 **Deploy**。页面会跳到构建进度，**它不会自动刷新**，看起来一直卡在 Initializing 是正常的，手动刷新就能看到真实状态（顺利的话 30 秒左右完成）。

### 4. 填密钥

Secrets 要等**部署完**再填：Worker 页面 → **Settings** → 最上面的 **Variables and secrets** → **+ Add**，按你部署的 Worker 加。

**`amsg/`**

| Type | 名字 | 哪来的 | 必填 |
|------|------|--------|------|
| Secret | `AMSG_MASTER_KEY` | SullyOS 设置 → 主动消息 2.0 里能一键生成 | 是 |
| Secret | `VAPID_PUBLIC_KEY` | SullyOS 设置 →「推送凭据 (VAPID)」面板 | 是 |
| Secret | `VAPID_PRIVATE_KEY` | 同上 | 是 |
| Text | `VAPID_EMAIL` | 随便一个 `mailto:你的邮箱` | 否 |
| Secret | `AMSG_SERVER_TOKEN` | 自己起一个密码，填了就要求所有请求带上它 | 否 |

平时不要设 `AMSG_RESCUE_TOKEN`。它只在本地数据被清空、需要从云端救数据时临时加，用完立刻删掉，见 [主动消息 2.0 · 数据救援](./amsg2-rescue.md)。

填完点右下角 **Deploy**。

> ⚠️ VAPID 那一对**必须和 SullyOS 面板里的是同一对**。整个站点共用一个浏览器推送订阅，Worker 用别的密钥对去签，推送会被浏览器拒掉（403），表现是「一切正常但就是收不到」。

**`mcp-proxy/`** 不需要密钥。

### 5. 把地址填回 SullyOS

Worker 的 **Overview** 页，标题下面那个 `https://xxx.workers.dev` 就是地址，复制它，填进 SullyOS 对应的设置项里，点「连接」。

---

## 以后怎么更新

上游发了新版本之后：

1. 打开你 fork 的仓库页面
2. 点 **Sync fork** → **Update branch**
3. 完事——Cloudflare 检测到新提交会自动重新部署

密钥、D1 绑定、你填的 Database ID 都不会丢。

---

## 常见问题

**Sync fork 提示冲突？**
正常情况不会——你的 Database ID 和密钥都存在 Cloudflare，不在仓库里，所以 fork 里没有你改过的文件。如果真冲突了（比如你手动编辑过），删掉 fork 重新 fork 一遍就行，Cloudflare 那边的连接、变量和密钥都不受影响。

**构建失败，日志里说 `D1_DATABASE_ID 是空的`？**
那个变量没设，或者设的时候点了 Encrypt。补的位置是 Worker → **Settings** → 往下找 **Build** → **Variables**（构建阶段才读得到），不是运行时的 Secret。加完重新部署一次。

**部署成功了但 SullyOS 连不上？**
先在浏览器直接打开 `https://你的地址/config-check`，Worker 会自己报缺什么（这个地址不需要密钥，配了 `AMSG_SERVER_TOKEN` 也照样打得开）：

- `"ok": true` → 配置齐全。连不上的话问题在地址填错，或者 `AMSG_SERVER_TOKEN` 两边不一致
- `"ok": false` → 后面的 `message` 直接写了缺哪一样、去哪儿补
- `warnings` 里每一条都是「能跑，但有一块是哑的」。最常见的是 VAPID 没配齐——任务建得成、界面全绿，到点一条都推不出去
- 整个页面打不开 → Worker 没起来，去 Cloudflare 的 **Deployments** 看部署日志

SullyOS 里点「连接并验证」时也会先读一次这个自检，缺什么会直接写在提示里，不用自己来开这个地址。

**找人帮忙看的时候，贴 `/debug` 的输出**

`https://你的地址/debug` 比 `config-check` 多报库和定时任务的状况，一份就够对方判断问题在哪：

```json
{ "server": { "version": "2.6.0-next.12" },
  "config": { "ok": true, "warnings": [] },
  "storage": { "schemaReady": true, "missingColumns": [],
               "pushSubscriptionRegistered": true, "pendingTasks": 0 },
  "tick": "idle",
  "vapidPublicKey": "BDQd..." }
```

怎么读：

| 字段 | 不对劲的样子 | 说明 |
|------|------|------|
| `storage.missingColumns` | 列出了几个列名 | 换了新版本但没重新点「连接并验证」，定时任务会每分钟静默失败。点一次就好 |
| `storage.pushSubscriptionRegistered` | `false` | 云端没有推送订阅，消息发不出去。去 SullyOS 把推送开关关掉再打开 |
| `tick` | `stalled` | 有任务卡住了：到点很久一直没人处理，或者开始发过又没了下文。多半是定时触发器没配（**Settings → Trigger events**），或者 Worker 半路被 Cloudflare 掐掉 |
| `tick` | `failing` | 有任务在失败重试。报错原文不在这个地址里，去 SullyOS 体检面板的「定时任务」那一行看 |
| `vapidPublicKey` | 和 SullyOS 面板里的对不上 | 推送会被拒（403），表现是「一切正常但收不到」|

这个地址是只读的，也不需要密钥，但它**不会**返回任何密钥的值、你的用户标识或消息内容——贴出来是安全的。

**主动消息到点了没反应？**
`amsg/` 靠定时触发器每分钟检查一次，配置里已经写好了（`crons = ["* * * * *"]`）。去 Worker 的 **Settings → Trigger events** 确认 Cron 那条在；不在的话通常是 Path 填错、部署的不是 `amsg` 目录。

**想用 wrangler 命令行而不是网页？**

```bash
cd amsg
wrangler d1 create sullyos-amsg     # 拿 database_id 填进 wrangler.toml
wrangler secret put AMSG_MASTER_KEY # 其余密钥同理
wrangler deploy
```
