# 捏人器 · PSD 整批导入 & 内置素材包

> 3D 分层表情 `6_0_29201.psd` 使用独立发布流程，包含隐藏备选层及 A/B、C/D 对齐基准，见 [分层贴图表情](./chibi-face-textures.md)。不要直接套用下方普通素材的隐藏层过滤规则。

> 覆盖 520 / 彼方共用的捏人器（`public/like520/character_creator.html`）、
> 开发面板（`apps/CharCreatorDevApp.tsx`）、解析器（`utils/psdCreatorImport.ts`）、
> Blob 存储桥（`utils/creatorPartsBlob.ts`）、内置素材包（`utils/builtinPartsPack.ts`）。

## 两种素材，别搞混

| | 存哪 | 占 IndexedDB 配额 | 谁能看到 |
|---|---|---|---|
| **内置素材** | 二进制 PNG 文件在 `public/like520/parts/`（+ `parts/manifest.json` 清单） | ❌ 不占（走 bundle / HTTP 缓存） | 所有用户 |
| **用户上传素材** | Blob 存 `cc_custom_parts`（`src` 存 blobref 令牌，见下） | ✅ 占（已改 Blob，比 base64 省 ~33%） | 只本机 |

> 历史包袱：`character_creator.html` 里原本还内联了一批 base64 内置部件（曾把文件撑到
> ~1.6MB）。新增内置素材一律走「PNG 文件 + 清单」，别再往 HTML 里内联 base64。

## PSD 组织约定（给画师看）

- 画布 **472×472**（大画布等比缩到 472，超过 944 触发），所有图层按画布位置导出，锚点天然对齐。
- **顶层图层组 = 一个类目**（组名就写类目，如 `眼睛` / `前发`）。
- **组内每个图层 = 一个独立部件**（图层名 = 部件显示名，如眼睛组里「杏眼」「圆眼」各一层 → 拆成两个部件）。
  组内若有子图层组，则该子组的图层合并成一个部件（少数需多图层的部件用得上）。
- **顶层散图层**（不在组里）= 一个部件，类目从它自己名字猜。
- **显示 / 隐藏**：要导入的图层保持**显示**；**隐藏的图层/组会被跳过**（可藏草稿 / 参考层）。图层不透明度会被照搬，要导的记得拉满 100%。
- 类目认中文别名或英文 key：前发/刘海、耳发/鬓发、后发1、后发2、肤色/皮肤/身体、眼睛、嘴、衣服/服装、外套、面纹/腮红、配饰/饰品/装饰。识别不出的在面板里手动选。
- 换色标记：名字带 `#色`/`#tint` 强制可换色，`#原色`/`#notint` 强制不可；不标时**头发四类 + 眼睛默认可换色**，其余默认不可。
- **没有单独的阴影/投影层**——一个图层就是一个部件。部件自身的明暗（发丝阴影、高光）直接画进图层即可，`applyTint` 按像素明度重上色，明暗关系天然保留。

## 数据流

```
画师 PSD ──(CharCreatorDevApp「PSD 整批导入」)──> parseCreatorPsd
  组=类目、组内每图层=一个部件 → part.src（透明 PNG dataURL）
        ↓ 面板确认（类目 / 名称 / 可换色）
  ├─「全部加入捏人器」→ creatorPartToBlobRefs → DB.saveCustomCreatorPart（本机 IndexedDB，src 存 blobref 令牌）
  │        ↓ Like520Event loadCreatorPartsForRender（令牌→base64）随 like520_init/add_items 注入 extraItems
  │   character_creator.html mergeExtraItems → PARTS
  └─「导出为内置素材包」→ buildBuiltinPartsPackZip → ZIP（parts/manifest.json + parts/*.png）
           ↓ 管理员把 parts/ 放进 public/like520/ 提交
     character_creator.html 启动 fetch('parts/manifest.json') → mergeExtraItems → 全员内置
```

## 管理员：PSD → 全员内置素材（无需改代码）

1. 开发面板 →「PSD 整批导入」→ 选 PSD → 逐个确认类目/名字/可换色。
2. 点 **「导出为内置素材包（PNG+清单）」**（或用已有列表那颗「把已有 N 个部件导出为内置素材包」），下到一个 ZIP。
3. 解压，把里面**整个 `parts/` 文件夹**放进仓库 `public/like520/`
   （最终是 `public/like520/parts/manifest.json` + `public/like520/parts/*.png`；已存在就整体覆盖，清单是全量快照）。
4. 提交并部署。`character_creator.html` 启动时自动 `fetch('parts/manifest.json')` 合并进 PARTS，**不用手改 HTML 的 PARTS 数组**。

> 不会用 git 也行：GitHub 网页版 → 进 `public/like520/parts/` 目录 → `Add file → Upload files` 拖拽上传 → 底部 `Commit changes`。

## 换画风：老画风折叠（`LEGACY_IDS`）

`character_creator.html` 启动时把当时 `PARTS` 里的内置部件 id 快照进 `LEGACY_IDS`（不含
SULLY 专属 special）。之后经内置素材包 / 用户上传进来的都是「新画风」，不在此集合。

规则**按类目智能生效**：某类目**一旦有了新画风部件**（`catHasNonLegacy`），它的老画风就
**折叠隐藏**（面板不展示）+ **随机 roll 不到**；还没上传新款的类目，老款照常可用，避免迁移期留空档。
老画风数据始终保留在 `PARTS` 里，**用了老部件的旧角色仍能正常渲染**——只是不能再在面板里重新选它。

所以换画风只需：把新画风做成内置素材包传上去，对应类目的老款自动隐去，无需删任何东西。

## 用户上传部件的 Blob 存储

`CustomCreatorPart.src` / `shadowSrc` 落库前经 `creatorPartToBlobRefs` 转成 `blobref:<id>` 令牌
（二进制进 `blob_assets` store，省配额）；读出/注入 iframe 前经 `loadCreatorPartsForRender`
转回 base64（iframe 契约要字符串）。备份（v3）里令牌原样进 JSON，二进制随 zip 的 `blobs/<id>`
旁路走、导入按原 id 写回（见 `utils/backupBlobs.ts`）。详见 `utils/creatorPartsBlob.ts`。

测试：`pnpm vitest run utils/psdCreatorImport.test.ts utils/builtinPartsPack.test.ts utils/creatorPartsBlob.test.ts`。
