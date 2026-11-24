# canary 版本通道

较大的改动先发给一小部分志愿用户，确认没问题再合进 master 推给所有人。前端和主动消息 2.0 的 Worker 一起覆盖，两边按通道配对。

## 一眼看懂

| | 正式版 | canary |
|---|---|---|
| 来源分支 | `master` | `canary` |
| 前端地址 | 各官方站点根路径 | 只有 `https://friedsully.com/canary/` |
| Worker 成品包 | 部署仓库 `main` 分支 | 部署仓库 `canary` 分支 |
| 谁在用 | 所有人 | 解锁调试面板后手动加入的人 |

发版流程：dev 上某一版可以给志愿者试了，就把 `canary` 分支快进到那个提交（或开 PR dev→canary）。快进之前先在 `utils/canaryChangelog.ts` 里补当天的更新日志（见下文「更新日志」）。push 之后，CI 先把 Worker 包同步到部署仓库的 `canary` 分支，再部署 canary 前端。确认没问题后照常走 dev→master。合进 dev 不会自动发到 canary，不快进 `canary` 分支，线上 canary 就一直是上一次发布的构建。

```bash
git fetch origin && git push origin origin/dev:refs/heads/canary
```

canary 每次发布都会给正打开着的页面弹「新版本已准备好」。网页更新只在版本号（`APP_VERSION` 的前半截）变了时才弹提示，同一版本号内的构建要等下次打开或刷新才悄悄换上；canary 构建的更新版本号拼上了构建号（`releaseUpdateVersion`，SW 清单与页面用同一个式子），每个构建都算新版本。统计标签不受影响，仍是 `v3.x-canary`。

## 前端

### 同网址子路径

canary 前端挂在 `friedsully.com/canary/`，和正式版同一个网址。浏览器的 IndexedDB、localStorage、通知权限按网址隔离，同网址意味着两个前端用的是同一份数据：加入和退出都不用搬数据，主屏幕图标也不用换。

代价写在加入确认框里：canary 的 bug 会直接碰到真数据，加入前先导出备份。canary 升级过的数据库，回到正式版也能打开（`utils/db.ts` 遇到库版本比代码新时不带版本号重开），但 canary 新加的字段正式版不认识。

只在 `friedsully.com` 上提供 canary。github.io、Vercel 上的数据存在各自的网址下，去不了 `friedsully.com/canary/`，那些站点上的加入按钮置灰并说明原因。原生 App 也不提供。

正式版 Service Worker 的作用域是整个站点，但它只接管自己清单里的文件和 `assets/build/` 下的哈希文件，`/canary/` 下的请求一律放行给网络。canary 构建以 `/canary/` 为部署路径，注册自己的 SW，作用域是 `/canary/`，更窄的作用域优先。两个 SW 互不接管。

### 通道由构建决定，选择存在本地

构建时的环境变量 `RELEASE_CHANNEL=canary` 决定这一份前端是 canary（部署路径同时变成 `/canary/`）。代码里用 `utils/releaseChannel.ts` 的 `RELEASE_CHANNEL` 判断，新功能不需要为 canary 单独加开关：进了 canary 分支，就只在 canary 前端里生效。

用户选了哪个通道，存在 localStorage 的 `sullyos_release_channel`，两个前端读的是同一条：

- 正式版启动时读到 `canary`，就带着原来的路径跳到 `/canary/`。
- canary 启动时读到的不是 `canary`，就跳回根路径。直接打开 `/canary/` 而没有加入的人会被送回正式版。

跳转在 React 挂载之前做，页面不会先闪一下另一个版本。

### 加入与退出

入口是设置底部版本信息下方的「正式版 | canary」标签。正式版上要先连点 5 下版本号、解锁调试面板后才出现，让人数保持在少量；在 canary 里一直显示，退出不藏。切换都用 `useConfirmDialog` 二次确认。确认加入后，屏幕边缘亮起黄光、一道光从底部扫到顶部，直到页面跳走；Worker 换得再快也至少扫完一遍（1.4 秒）。系统开了减弱动态效果时只亮不扫。

canary 构建不挂开发角标（分支@提交号那三行），改在右下角放一个小黄点。设置底部可以取消「右下角显示 canary 黄点」，偏好存在 localStorage 的 `sullyos_canary_dot_hidden`，只属于这台设备，不进备份。预览页 `test/fixtures/canary-channel.html`（`?glow` 看加入动画，`?arrive` 看落地动画，`?update` 看更新卡片，`?changelog` 看更新日志）。

### 小金丝雀

canary 的几个节点由一只小金丝雀串起来（`components/CanaryBird.tsx`），让切换通道这件事有点仪式感：

| 时机 | 小鸟在做什么 |
|---|---|
| 设置里的通道标签 | 站在「canary」字样旁边；在 canary 里隔一会儿扇两下翅膀，切换中一直扑腾 |
| 确认加入 | 跟着黄光从底部飞到顶部，掉几片羽毛；身边飘起「canary」在各国语言里的叫法 |
| 加入后第一次启动 | 从左上飞到右下角，挨个报几种语言的名字，停在「啾！欢迎来到 canary」，再缩成小黄点 |
| canary 里出现网页更新 | 站在更新卡片顶上，点更新后扑腾起来 |
| 确认退出 | 往左上角飞走，飞完（1.1 秒）再切回正式版 |

各国叫法代表 canary 是很多人一起试出来的。加入、退出的动画由切换发起的那一侧画：加入时人还在正式版，所以加入动画要等改动进了正式版才看得到。落地动画在 canary 这一侧，看切换通道时新旧版本都会写的 `sullyos_channel_arrival`（只读不清，推送补登记还要用），另用 `sullyos_canary_welcomed` 记「这次欢迎过了」，每次切换通道时清掉；两条都是设备状态，不进备份。系统开了减弱动态效果时小鸟和文字都不动，只静静出现。正式版的更新卡片不带小鸟。

### 金黄主题

canary 的版本主题色是金黄配白，只替换系统默认配色，用户自己设过的照常生效：

- **系统强调色**（`--primary-*`，外观里的色相 / 饱和度 / 亮度）：三项都还是出厂值时，canary 显示成蜂蜜金 `hsl(40 85% 40%)`；任何一项被用户调过就用用户的。只在显示层替换，不写回设置，回到正式版自动恢复。判断在 `utils/canaryTheme.ts`。强调色上大量压白字，亮黄配白看不清，所以这里用深一点的金。
- **网页更新卡片**：白底淡金边，亮金主按钮配深棕字。
- **系统界面里写死的紫色系**：`index.html` 的 Tailwind 配置把 violet / indigo / purple 每一档改成先读 `--sully-system-tint-*`、读不到用原色。canary 里只在带 `sully-system-ui` 类的容器内设这组变量，换成一套金色。目前标了设置页根节点（设置里的二级弹窗渲染在里面，跟着变）、系统确认框、报错弹窗。聊天、见面等 App 自己的紫色是它们的设计，不在范围内；新加系统界面想跟着换，给根节点加 `sully-system-ui` 即可。确认框的删除（红）、警告（橙）不受影响。
- 通道写在 `<html data-release-channel>` 上（`appEntry.tsx` 渲染前设置），以上 CSS 都按它生效。

以下情况不能加入，按钮置灰并写明原因：

| 情况 | 原因 |
|---|---|
| 不在 `friedsully.com` 上 | 数据在别的网址，canary 读不到 |
| 原生 App | 只做网页版 |
| 开着主动消息 2.0，但 Worker 没有自更新能力 | Worker 换不成 canary 包，会变成新前端配旧 Worker |
| 开着 2.0，Worker 还不认通道（`/config-check` 没有 `bundleChannel`） | 先更新 Worker；开了自动更新的 Worker 会自己跟上 |

**加入时先换 Worker，再换前端**。Worker 换成 canary 包成功了，才写本地记录并跳过去；Worker 换失败就不加入。中间那一瞬间是新 Worker 配旧前端，这正是总纲「Worker 先部署」允许的方向。

**退出时 Worker 降级失败也照样退出**。旧前端配新 Worker 同样是允许的方向，下次冷启动还会自动重试降级（见下文「冷启动对齐」）。

### 打不开时自动退回

iOS 主屏幕 PWA 没有地址栏，canary 如果白屏，用户连设置都进不去。所以：

- 正式版每次往 canary 跳之前，把 `sullyos_canary_boot_attempts` 加一；canary 挂载完成后清零。
- 正式版准备跳时发现这个数已经到 2（连续两次跳过去都没启动成功），就不再跳，把通道改回正式版，并在启动后提示一次「canary 连续两次没能启动，已回到正式版」。之后的 Worker 降级由冷启动对齐完成。
- 手动后门：打开 `https://friedsully.com/?channel=stable` 会强制回到正式版，清掉计数。只对同一个浏览器里的数据有效：iOS 主屏幕 App 和 Safari 的存储是分开的（2026-11 真机确认），在 Safari 里打开这个网址改不到主屏幕 App，主屏幕 App 只能靠自动退回或设置里的标签切回。

### 推送订阅

推送订阅挂在 Service Worker 注册上，两个前端各有一份。切换通道后到达的那一边，如果开着 2.0 且已授权通知，会调用一次 `registerPushSubscription()`，把自己的订阅登记到 Worker 上，否则主动消息会推到另一边的 SW。

### 更新日志

canary 更新得勤、每次改动小，不做正式版那种整页更新说明，只在更新后第一次打开时弹一个小卡片，按天列出没看过的条目。

- **内容手写**，在 `utils/canaryChangelog.ts` 的 `CANARY_CHANGELOG` 里。每次快进 `canary` 分支之前，在最上面补当天的条目，同一天发几次就往当天追加。写给志愿者看：这次能试什么、修了什么，一条一句，不写提交信息原文。忘了写就不弹，不影响发布。
- **按条目认已读**。每条以「日期 + 原文」为准，关掉卡片时把日志里现有的条目全部记进 localStorage 的 `sullyos_canary_changelog_seen`（设备状态，不进备份）。改了某条的措辞会被当成新条目再弹一次；删掉的旧条目从记录里一起消失，记录不会越攒越大。
- **刚加入那次不弹**，把现有条目直接记成看过：那次启动有小金丝雀落地动画，而且加入不是一次更新，之前的条目对新人没意义。
- **排在启动提醒最后**：正式版的更新公告、活动弹窗、「该备份啦」都处理完才轮到它，桌面上的邀请卡片给它让路。正式版公告里点了「立刻体验」跳走、剩下几条没看完时，这次启动不弹，下次再弹。
- 读不出存储时不弹，免得每次开机都弹。
- 预览：`test/fixtures/canary-channel.html?changelog`（示例条目，不写已读）。

## Worker

### Worker 自己记住通道

Worker 的诊断表 `worker_diagnostics` 里存一条 `bundle_channel`（`stable` / `canary`，没有就是 `stable`）。自动更新（cron 每 6 小时、App 冷启动时敲门）按这条去拉对应的成品包：

- `stable`：`https://raw.githubusercontent.com/Tosd0/sullyos-workers/main/amsg/worker.bundle.js`
- `canary`：同一仓库的 `canary` 分支

配了 `AMSG_BUNDLE_URL` 的 Worker（自己维护成品包的人）照旧从那里拉，通道不起作用，请求切换通道会被拒绝（`CUSTOM_BUNDLE_URL`），以免以为加入了 canary 实际没换包。

### 通道只由 App 来改

`POST /self-update`（要共享密钥）的请求体可以带 `{ "channel": "canary" }`：

- 按请求的通道拉包，**装成功了才写通道**。失败时通道保持原样，不会落在半切换的状态。
- 不带 `channel` 就用已存的通道。老前端照旧调用时，不会把 canary 用户的 Worker 拉回正式版。
- 值不是 `stable` / `canary` 时回 400 `INVALID_CHANNEL`。

`GET /config-check` 多报一项 `bundleChannel`。老 bundle 没有这个字段，前端据此判断「这台 Worker 还不认通道」。

### 冷启动对齐

前端每次冷启动探 Worker 版本时，先比通道：Worker 报的 `bundleChannel` 和本前端的 `RELEASE_CHANNEL` 不一样，就直接带上自己的通道调一次 `/self-update`，排在版本号比较前面。正常加入退出、自动退回、某一步中途失败，下次启动都会自己对齐。

这条检查沿用原来的节流（构建换了就查，否则隔 6 小时）。切换通道必然换构建，所以切换后的第一次启动一定会查。

本地选择和这份前端的通道不一致时（正式版正要跳去 canary，或反过来），整条检查直接跳过。跳转要等新页面加载才生效，这段时间里旧页面的启动流程可能已经在跑；这时去对齐，会把 Worker 拉向马上要离开的那一边。设置页手动点「更新 Worker」同样带上本前端的通道。

已知限制：canary 用户如果同时在 github.io、Vercel 或原生 App 上开着正式版，两个前端会轮流把 Worker 拉向各自的通道。这和一台 Worker 配两台设备是同一类情况，不做处理，手册里提醒 canary 用户只用 friedsully.com。

### 成品包同步

`sync-workers-repo.yml` 可以被别的 workflow 调用，参数是目标分支。master push 照旧同步到部署仓库 `main`；`deploy-canary.yml` 先调用它同步到部署仓库的 `canary` 分支，成功后才部署 canary 前端，保持「Worker 先于前端」。用 Sync fork 的人只同步 `main`，不受影响。

GitHub raw 的 CDN 缓存 5 分钟，前端构建和上传本身要几分钟，通常来得及。如果前端先到、Worker 拿到的还是旧 canary 包，下一次检查会再对齐。

## CI 与部署

| 文件 | 作用 |
|---|---|
| `.github/workflows/deploy-canary.yml` | `canary` 分支 push 时：先同步 Worker 包，再以 `RELEASE_CHANNEL=canary` 构建前端，部署到 `sully-os-canary` |
| `wrangler.canary.jsonc` | canary 静态站 Worker，挂在路由 `friedsully.com/canary*` 上 |
| `.github/workflows/sync-workers-repo.yml` | 支持 `workflow_call`，按参数推到部署仓库的对应分支 |

canary 用独立的静态站 Worker，不和正式站一起部署：canary 部署出问题碰不到正式站。Cloudflare 路由文档写明，路由和自定义域名在同一个域名上时路由优先（[Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)），所以 `/canary*` 会落到 canary Worker，其余路径仍由 `sully-os-site` 处理。没设 `assets.base_path` 时静态资源按完整请求路径查找，构建产物放在 `dist-canary/canary/` 下（`base_path` 要 wrangler 4.148 以上，仓库钉的是 4.122）。`/canary` 会被默认的 trailing-slash 处理 307 到 `/canary/`；`/canaryfoo` 这类路径也会落到 canary Worker，回 404。

### 首次上线清单

1. 确认 `friedsully.com` 以自定义域名绑在 `sully-os-site` 上，并且 zone 在同一个 Cloudflare 账号里。
2. 确认 Actions 里的 `CLOUDFLARE_API_TOKEN` 有 Workers Routes 的编辑权限，否则第一次部署建路由会失败。
3. 在主仓库建 `canary` 分支。部署仓库的 `canary` 分支第一次同步时会从 `main` 自动建出来（内容和 `main` 相同也照样推上去，否则 Worker 按 canary 拉包会 404）。
4. 这次改动合进 master 后，存量 Worker 会因为版本号抬到 `2026-11-24` 在冷启动时更新到认通道的这一版；在那之前加入按钮会提示先更新 Worker。
5. 打开 `https://friedsully.com/canary/`：没加入时应该跳回根路径。

## 联动

- **使用统计**：canary 构建的统计标签是 `v3.x-canary`（`utils/analytics.ts` 的 `analyticsTag`），所有事件、快照和性能数据都能按通道切开，不额外占快照属性；事件「加入 canary」「退出 canary」「canary 自动退回」。见 [`analytics.md`](./analytics.md)。
- **备份**：通道选择和启动计数是这台设备的设置，不进备份；Worker 的通道在云端诊断表里，也不进备份。
- **Sully-11 手册**：「设置」一区有加入、退出、打不开时怎么办的说明。
