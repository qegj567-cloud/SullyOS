# ElevenLabs 角色语音

## 用户更新公告（待发布）

这次更新给角色语音接入了 Eleven v4 / v4 Turbo，还加了几种听对话的新方式：

- **不用等整段声音生成完再听**：聊天、电话和见面支持边生成边播放，并显示跟随声音的字幕。
- **电话可以边想边说**：在「通话偏好」里开启后，角色写完一句就能开始说。需要文字 API 支持流式回复；高质量视频演出仍需等待完整台词和动作准备好。
- **群聊可以整段配音**：选择角色消息，让大家按顺序用各自的声音说话。可以调整本次配音的台词、重播或保存整段音频，原聊天记录不变。多人配音请选择 v4，Turbo 只支持单一音色。
- **见面可以连续朗读**：阅读模式下，能朗读最新一段，也能选中多段连着听，叙述部分也会读出来。

使用前，在「设置 → 其他 API」配置 ElevenLabs，再给角色填好 Voice ID。已有模型和自动播放设置会保留；关闭自动播放时，聊天语音仍然点了才生成。新生成的流式语音保存为 WAV，采样率从原来的 44.1 kHz 调整为 24 kHz，文件也会更大。旧语音仍可播放，但没有新增的同步字幕。模型不可用或额度不足时会直接提示，不会自动换模型。

<!-- 发布条件：前端和中心 Worker 同步更新，并完成真实账号试听；本公告尚未表示线上已发布。 -->

## 技术说明

Eleven v4 是 TTS（文字合成声音）。电话的语音输入（STT）可独立选择 ElevenLabs Scribe（`scribe_v2`）、鱼声 Fish ASR（`transcribe-1-pro`）、MiniMax ASR（`asr-1.0`）或浏览器 / 系统自带语音识别，已填写对应官方 Key 的平台可直接切换。

## 配置与默认行为

在「设置 → 其他 API」保存 ElevenLabs Key、选择 ElevenLabs 语音引擎和模型，再到「角色 → 语音」保存该角色的 Voice ID。聊天语音条、电话、见面和试听共用适配器。

- 新配置默认 `eleven_v4`，也可选择 `eleven_v4_turbo`。
- 旧配置已有明确模型时保留原选择，不强制迁移或自动切换服务商。
- v4 / Turbo 请求只发送 `stability` 和 `similarity_boost`，稳定度使用连续的 0–1 数值，不套 v3 的三档取整。
- 数值语速、Style、Speaker Boost 和 SSML 不受 v4 支持，不发送；旧参数保留给其他模型，设置与角色页会说明。
- 模型报错、权限不足、额度不足时直接提示错误，不偷偷重试旧模型。
- 流式播放会把长文按完整句、段落拆分，每批最多 1800 字符，保留 Audio Tags / IPA。旧的单次试听适配器仍遵守 v4 的 10000 字符上限，超限报错，不截断正文。

## 现有语音流程里的能力

| 能力 | 接入方式 |
| --- | --- |
| 情绪、音色质感、声音动作 | 保留开放式英文 `[Audio Tags]`，不使用 v3 的小白名单 |
| 音效与特殊演出 | 保留 `[door slams]`、`[applause]`、`[sings]` 等标签与自由描述，按场景生成 |
| 节奏、长短停顿、组合标签 | 保留标签、标点和原始换行，不压成单行、不合并长短停顿 |
| 发音控制 | 正文里的 `/IPA/` 原样传递 |
| 多语言与粤语 | 保留现有语种选择，放行 v4 / Turbo 的粤语；`yue` 不是 ISO 639-1，不传入 `language_code`，用粤语台词决定发音 |
| 见面语音 | 标签放在台词引号内部，TTS 保留；立绘 `[emotion]` 和语音 `[v:xxx]` 仍独立 |
| 字幕与收藏 | 聊天、电话、见面使用官方字符 alignment + 播放器时钟；展示实际朗读语言，隐藏演出指令；完成音频仍可收藏 |
| 原生、开发环境、静态部署 | 原生直连、同源 `/api/elevenlabs/tts`、中心 Worker 三条路径共用请求体 |
| 本地音频缓存 | 新流式路径保存 WAV + 字符时间轴；旧 MP3 缓存保留；缓存键包含模型与实际请求参数，v4 和 Turbo 不混用 |

默认表演提示覆盖以上能力，使用多少标签由台词和场景决定。用户自己的语音指南优先，不覆盖其文字；旧指南若禁止方括号，可在设置中清空以恢复 v4 默认指南。

## 流式语音入口

- **聊天**：现有语音条和手动转语音入口接入流式播放。关闭自动播放时仍沿用点播才合成的规则，避免额外费用；新音频生成后，缓存重播也有同步字幕。多条自动语音串行播放，换角色或手动停止取消待播队列。
- **电话**：「通话偏好 → 边想边说」默认开启。单独为该次文字请求设置 `stream: true`，不修改全局配置；通过已有 SSE 回调拿完整句，按句请求 ElevenLabs，正文尚未写完就能开口。思考、AVATAR 指令、双语的中文字幕不送入 TTS。上游忽略流式请求而返回整包 JSON 时，会提示本轮等台词写完再播放。
- **见面**：台词点播和 GAL 自动语音使用流播放；阅读模式可朗读最新一段，或批量选择后连续朗读所选角色正文（含叙述）。停止后从头重播；未实现拖动进度或暂停续读。
- **群聊**：「选择消息配音」选角色文字消息，再点「为所选角色消息配音」。面板可编辑这次配音的台词，原记录不变；按消息顺序使用各角色 Voice ID，生成后可重播、保存整段 WAV。

首块 PCM 到达即排入 WebAudio，不等整个响应结束。字幕时间轴跟随音频输出时钟，网络卡顿造成的空档不计入播放进度。成功完成才保存缓存；中断或上游错误不会把残缺音频当成功结果缓存，也不会自动重试产生第二笔语音费用。

## 与旧流程相比的变化与限制

1. **输出格式变化**：新路径使用 `pcm_24000`（24 kHz、单声道、16 bit），保存为 WAV。相比旧 `mp3_44100_128`，采样率降低、文件变大（约 2.88 MB/分钟，旧 MP3 约 0.96 MB/分钟）。这是为了逐块播放和准确计时；没有自动降低模型或修改稳定度。官方 44.1 kHz PCM 有套餐要求，因此没有把它设为所有账号的默认值。旧缓存、音色试听等未改用新播放器的入口仍用原 MP3。
2. **按句输入，不是逐 token WebSocket**：本轮采用 HTTP `/v1/text-to-speech/{voice_id}/stream/with-timestamps` 与 `/v1/text-to-dialogue/stream/with-timestamps`。完整句输入能保留 v4 表现标签，但句子间仍可能有网络空档；不能保证和一次生成整段完全相同的韵律。长文通过前后文和可用的 request-id 衔接；增量电话通过上一句文字衔接。
3. **视频演出**：默认演出可以边生成边说，口型分析器直接读取流播放器；高质量模式需要先拿完整台词排练动作，因此仍等排练完再开口，之后音频本身仍流式播放。基础演出的动作随收到的指令更新，不保证跨句动作与声音逐帧精确对齐。
4. **多人能力**：v4 / v3 最多 10 种音色，每次请求按官方建议控制在 2000 字符以内（本地 1800）；v4 Turbo 多音色会明确报错，用户需自行选择 v4，不自动换模型。Dialogue 端点不接受每个角色独立的单人 voice_settings，因此多人请求不套用各角色的稳定度、相似度滑杆；音色与台词标签仍保留。
5. **时间轴与历史**：新聊天音频持久化字幕，长文/多人共享缓存保存字幕；旧 MP3 没有时间轴，不伪造逐字字幕。电话同一页面内重播保留时间轴；旧通话记录需要重新生成才能有时间戳。收藏页仍按原播放器播放，不新增字幕编辑器。
6. **仍未接入的 API**：声音克隆上传/训练、音色库管理、发音词典管理、seed 与输出格式选择、WebSocket 输入、STT Scribe、配音翻译、音效/音乐独立生成。它们不属于本轮已确认的五项播放功能，不能称作覆盖 ElevenLabs 全部 API。

v4 跨语言默认使用目标语言的自然发音，可能改变参考音色原先的外语口音；标签执行效果取决于所选音色。错误直接显示，不静默回退旧模型。

## 部署与验收

- Vercel `api/elevenlabs/tts.ts` 改为直接透传流并响应浏览器断开；开发代理和 `worker/index.js` 都支持 `timestamps=1` 与 `mode=dialogue`，暴露 `request-id` 供长文衔接。
- **静态站与原生端必须同步更新中心 Worker**。只有前端更新而 Worker 仍是旧版，会返回 MP3，无法按时间戳 JSON 解析。原生新路径使用 WebView fetch 经代理传流，避免 CapacitorHttp 整包缓冲。
- 模拟验收页：`test/fixtures/elevenlabs-streaming.html`。使用独立浏览器配置运行；它会在测试源写入合成角色和测试 API 配置，所有语音/文字请求都被模拟，不调用真实 ElevenLabs。
- 单测验证分块边界、取消、排程、长文拼接、增量正文过滤、代理流透传与组件生命周期；浏览器模拟使用真实 WebAudio 和合成正弦波。
- 模拟测试不能证明真实音色效果、真实服务时间戳精度、套餐权限或 iOS / Android 真机后台行为。上线前还需用有权限的 Voice ID 实际试听，并确认代理已部署。仓库内的代理修改不等于已部署。

## 维护入口

- `utils/elevenLabsModels.ts`：默认模型、选择项和能力判断的唯一来源。
- `utils/elevenLabsTts.ts`：表演指南、文本清洗、请求参数、旧 MP3 传输与缓存。
- `utils/elevenLabsStream.ts` / `utils/voiceStream.ts`：时间戳 HTTP、长文/多人/句子队列、PCM 调度与 WAV。
- `hooks/useStreamingVoice.ts`：每个页面的取消、音频解锁、播放时钟与字幕状态。
- `utils/incrementalCallSpeech.ts`：电话 SSE 正文分句与思考/演出过滤。
- `utils/ttsProvider.ts`：给提示词使用的当前模型同步。
- `utils/ttsRouter.ts`：服务商分发、粤语门禁、字幕清洗。
- `utils/dateVoiceText.ts` / `components/date/DateSession.tsx`：见面台词提取、播放、字幕和收藏。
- `utils/datePrompts.ts`：保持 VN 格式的 v4 语音指导。

官方参考：[v4 模型说明](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/eleven-v4)、[Audio Tags 与 IPA](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices)、[HTTP 合成接口](https://elevenlabs.io/docs/api-reference/text-to-speech/stream)、[模型列表](https://elevenlabs.io/docs/overview/models)。

流接口参考：[单人流式时间戳](https://elevenlabs.io/docs/api-reference/text-to-speech/stream-with-timestamps)、[多人流式时间戳](https://elevenlabs.io/docs/api-reference/text-to-dialogue/stream-with-timestamps)、[TTS / Dialogue WebSocket 模型支持](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/tts-vs-ttd-websockets)。

运行模拟页前，在项目根目录用 `pnpm exec tailwindcss -i scripts/chat-preview.input.css -o output/playwright/voice.css --content 'test/fixtures/elevenlabs-streaming.tsx,components/**/*.{ts,tsx},apps/{CallApp,GroupChat,Chat}.tsx' --minify` 生成测试样式，再启动 `pnpm dev` 并访问该 fixture。不要在生产账号的浏览器资料中运行测试页。
