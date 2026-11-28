# 见面 · 观测协议 OBSERVE

> 给「见面」(DateApp) 加的一块**全息观测面板**：开启后让 LLM 在每条回复正文最前面吐一段
> 结构化观测（时间 / 地点 / 状态 / 细节），前端剥出来既留在记录里、又渲染成可独立查看的 HUD。
> 改观测相关逻辑（提示词注入 / 解析容错 / HUD 渲染）前必读。

## 一句话

替代土味状态栏，做成中二感的全息 HUD，让用户**全方位观察角色此刻的状态**。开关是 per-character 的。

## 数据模型（`types.ts`）

- `DateObservation`：`{ time?, place?, state?, detail?, extra? }`，前四维全可缺省（模型漏写不崩）；
  `extra?: Record<id,string>` 存用户**追加的自定义维度**的值（按 `DateObserveCustomField.id`）。
- `CharacterProfile.dateObserve?: DateObserveConfig`：per-character 配置（开关 + 样式 + 字段自定义）。
  - `enabled?: boolean`：总开关。
  - `style?: DateObserveStyleId`：HUD 视觉样式（`hologram` 默认 / `ink` / `neon` / `crystal` / `terminal`）。
  - `fields?: Partial<Record<keyof DateObservation, DateObserveFieldConfig>>`：四个维度的自定义。
    - `DateObserveFieldConfig`：`{ label?, hint?, enabled? }`——`label` 只改 HUD 展示标签（**不参与解析**），
      `hint` 改「这一格让 AI 生成什么」，`enabled:false` 则该维度既不注入提示、HUD 也不渲染。任一项留空回落默认。
    - `custom?: DateObserveCustomField[]`：**追加的自定义维度**（最多 6 个），`{ id, label, hint?, enabled? }`。
      与默认维度不同，自定义维度的 `label` **同时是线格式字段名和 HUD 标签**——解析时按 label 精确匹配回该维度，
      所以 `extractObservation` 必须收到 `custom` 才能解析（DateSession 传 `char.dateObserve?.custom`）。空 label 或禁用的不注入/不解析。
- `DateState.observation?: DateObservation`：旧版恢复快照的兼容字段。当前见面不再保存／恢复播放快照；观测随消息正文持久化，进入与回看时从正文解析。

## 样式与自定义（`datePrompts.ts` + `ObserveHUD.tsx` + `ObserveSettings.tsx`）

- **默认维度单一来源**：`OBSERVE_DIMENSIONS`（`datePrompts.ts`）固定四项 `时间/地点/状态/细节`，
  其 `label` 同时是**线格式字段名**——`buildObserveBlock` 注入时永远用它，所以用户改 `label` 不会让
  `extractObservation` 失配。`resolveObserveFields(char)` 合并默认 + 自定义并过滤禁用项，HUD 与提示词共用。
- **五种样式**：`ObserveHUD.tsx` 的 `THEMES` 表，每个主题给一组类名/内联样式，渲染走同一条路径；
  新增样式 = 往 `THEMES` 加一项 + `OBSERVE_STYLES`（设置面板选择器用，含名称/简介/预览色块）加一项。
- **设置入口**：`ObserveSettings.tsx`（嵌在 DateSettings）——总开关、样式选择（带实时预览）、
  每个维度的启用开关 + 显示标签 + 生成提示、「一键重置」（清空 `style` + `fields` 回默认，保留 `enabled`）。
  与行动选择、离开提醒共用一张设置卡片，标题展开详情、右侧开关独立启停；总开关与维度开关复用 `DateSettingSwitch`，仅统一显示与交互，不改变提示词、观测解析或存储字段。

## 数据流

开场调用 `buildObserveBlock(char, true)` 与开场专用译文示例，观测后只要求第三人称散文，不混入 VN 标签要求。独立感知页也调用 `extractObservation`，显示观测卡并剥离朗读译文；进入会话仍保存完整原文，历史回看不会丢失观测或译文。正式互动保持逐行 VN 协议。

```
开关 ON
  └─ datePrompts.buildObserveBlock 注入提示词（session 的 VN 块末尾 + peek 指令）
       └─ LLM 在回复最前面输出 ⟦OBSERVE⟧…⟦/OBSERVE⟧ 块 + 正常 VN 正文
            └─ DateSession 收到回复 → extractObservation(text, { lenient })
                 ├─ observation → setObservation → ObserveHUD（独立查看）
                 └─ rest（剥掉观测块的正文）→ parseDialogue → 立绘/台词
```

落库的 `message.content` **保留**原始观测块（它是「正文的一部分」）；渲染时才用 `extractObservation`
即时剥离，所以历史记录、阅读模式回看都能重新解析出 HUD，不依赖额外存储。

## 关键文件

| 文件 | 职责 |
|------|------|
| `utils/datePrompts.ts` | `buildObserveBlock`（提示词）、`extractObservation`/`stripObservation`/`hasObservation`（解析）、`OBSERVE_OPEN`/`OBSERVE_CLOSE` |
| `components/date/ObserveHUD.tsx` | 观测面板组件，`variant: 'hud' \| 'card'`、`THEMES` 五样式、`OBSERVE_STYLES` 选择器元数据 |
| `components/date/ObserveSettings.tsx` | 设置面板：开关 + 样式选择（实时预览）+ 每维度自定义 + 一键重置 |
| `components/date/DateSession.tsx` | 调 extractObservation、驱动 HUD、持久化、菜单快捷开关（传 `config={char.dateObserve}` 给 HUD） |
| `components/date/DateSettings.tsx` | 渲染 `<ObserveSettings>` |
| `utils/datePrompts.test.ts` | 注入 + 解析 + 掉格式容错测试 |

## 线格式（wire format）

模型被要求逐字输出：

```
⟦OBSERVE⟧
时间｜傍晚六点过，天刚擦黑
地点｜便利店门口的塑料凳上
状态｜有点疲惫，但见到你眼神亮了一下
细节｜指尖无意识地敲着关东煮的纸杯
⟦/OBSERVE⟧
[normal] 抬眼看你。
[happy] "你来啦。"
```

定界符故意用冷僻的 `⟦⟧`，避免和 `[emotion]` 立绘标签、台词引号撞车。

## 解析鲁棒性（重点）

LLM **一定会**偶尔掉格式，所以 `extractObservation` 分两层。改这里务必跑 `datePrompts.test.ts`
里的「掉格式容错」一组。

**第 1 层 · 严格（永远开，不会误伤正文）**
成对定界块。容忍：括号风格 `⟦⟧【】〔〕「」『』[]()<>`、关键字 `OBSERVE`/`观测`/`观测协议`、
大小写、定界符内空格。块内字段行容忍 markdown 列表符 / 加粗 / 中英 key / 全半角竖线 `｜|` /
中英冒号 `：:`。有定界符 = 明确意图，哪怕只解析出 1 个字段也认。

**第 2 层 · 回退（lenient，仅开关打开时启用）**
处理「丢了闭合标记 / 换了标记 / 完全没标记，只在开头堆字段行」。从文本**开头**连续扫字段行，
遇到第一行「非字段、非标记、非空」的内容（正文 / 台词 / `[emotion]` 行）就停。

防误吞的两道闸：
1. **至少命中 2 个不同维度**才认（正文里偶发一句"状态：…"不会被当观测）。
2. **只扫开头连续段**（`maxScan` 限制 + 遇正文即停），正文中部出现 field 样式旁白不受影响。

因为回退层有误吞风险，它由调用方按 `observeEnabled` 传 `{ lenient }` 控制——开关关闭、或历史
遗留消息，都不会走回退层。

**兜底**：两层都没解析出有效观测时，`observation = null`、`rest = 原文`，HUD 自动隐藏、正文照常显示，
对话流程不受影响。

## HUD 渲染（`ObserveHUD.tsx`）

- 视觉：暗色玻璃 + 青紫渐变描边（内联 style 实现 border + glow）+ 四角科技括号 + 顶部扫描线 + 脉冲点。
- `variant='hud'`：立绘模式左上角悬浮，可折叠（▾）、可放大（⛶）成全屏独立查看面板。
- `variant='card'`：阅读模式内嵌在每条回复正文上方，peek 开场也用这个。
- 只渲染存在的字段；`hasObservation` 为假时上层直接不挂载。
- 面板根节点带 `.control-panel` 类 + `stopPropagation`，避免点 HUD 时误触发推进对话 /
  收菜单（见 DateSession `handleScreenClick`）。

## 开关入口（两处，都写 `char.dateObserve.enabled`）

- 见面菜单的「观测 · 开/关」快捷钮（即点即用，像语音开关）。
- 设置面板「观测协议 · OBSERVE」section。

> 即时生效：system prompt 每次请求重建，存上就影响**下一条**回复（已生成的回复不会追溯补观测）。
