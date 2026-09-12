# 私聊流式预览与正式消息交接

2026-09-12：修复流式回复先显示、随后消失再整批弹出的现象。

## 交接规则

`applyAssistantPostProcessing` 会逐条保存、重新读取消息。即使启用了 `instantRender`，异步写库之间仍可能有多帧；第一条正式消息出现不代表整轮已经完成。

- `hooks/useChatAI.ts` 保留整组预览直到后处理完成，期间逐次登记与预览匹配的正式消息 ID。
- `apps/Chat.tsx` 在预览仍显示时隐藏本轮这些正式消息，避免重复。整轮完成才撤去预览、展示正式消息。
- 当前轮次的临时隐藏 ID 与已有的入场动画抑制记录分开：下一轮不能隐藏上一轮回复。正式消息接棒时不重新播放入场动画。
- 未被预览覆盖的卡片等消息继续正常展示；不改变解析、持久化或消息来源过滤。
- 出错时撤掉未保存的预览，保留实际已保存的消息与错误提示。

## 回归验证

`scripts/test-chat-stream-handover.mjs` 连接本地 Vite 的真实 Chat 测试入口，通过本地 SSE 返回三条回复，并暂停第二、第三条 IndexedDB 写入。测试连续两轮相同内容，逐帧检查气泡不消失、不重复，正式消息不重播入场动画；另模拟第二条保存失败，验证预览清理。

入口：`test/fixtures/chat-stream-handover.html`。测试专用写入暂停器只存在于该入口，不进入生产应用。启动 Vite 到 5183 后使用仓库的 Playwright loader 运行脚本。

相关单元回归：`streamPreview`、`safeApi.stream`、`chatReplyLifecycle`、`applyAssistantPostProcessing`。
