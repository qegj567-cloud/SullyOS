# 协同工作：私聊衔接与选择转发

2026-09-13 修复。

## 私聊输入

`features/collaboration/chatBridge.ts` 在每次生成前从 DB 读取当前角色与最新上下文范围。不能使用 Chat 页面传入的 `recentChatMessages` 作为生成数据源：它只是 UI 当前分页，可能陈旧或缺少消息。

「用户设定范围」沿用 `loadCharacterContextRange` 的手动断点、自适应记忆水位和最大范围。「最近 10／20 条」在相同范围内再取末尾 N 条；「不读取」不读聊天记录。范围为空时保持为空，不回退全库，不越过用户边界。只选择当前角色的私聊，不带其他角色或群聊。

两种协同模式仍保留原差异：沉浸式带完整 ChatApp 角色上下文，中度协同只追加私聊原文。实际请求明确标出 ChatApp 私聊的开始、结束及当前协同窗口，避免模型把「窗口独立」误解成「上文没有私聊」。界面显示本次读取条数。

模型自述“看不到 ChatApp”不能单独证明请求没有携带记录。验证时检查最终发送请求的 messages；已有范围外的旧内容仍不会出现，不能为避免这句话而偷偷扩大范围。

## 转发到 ChatApp

顶部发送按钮先打开选择页，默认不选；支持逐条勾选、全选、清空、取消。确认后只转发选中且属于当前窗口的 user/assistant 消息，保留原顺序及所选附件文字，不包括思考过程或其它协同窗口。仍通过原有 `onSendToChat` 写入一张转发卡，不自动混入日常聊天。

## 验证

- `utils/collaborationChatBridge.test.ts`：每次读取最新 DB、固定条数、最新手动断点、空自适应范围、角色／群聊隔离与选择转发。
- 既有 collaborationContext / collaborationWiring 回归。
- `scripts/test-worldbook-cowork.mjs`：真实协同 UI → 本地 mock API，检查最终请求包含私聊；窗口打开后追加私聊，再选「最近 20 条」生成，仍读到新内容；只选一条转发时回调只收到该条。

浏览器测试入口 `test/fixtures/worldbook-cowork.html`，Vite 端口 5183；使用仓库 Playwright loader。测试素材及模型请求只在隔离浏览器和本地 mock 服务里运行。
