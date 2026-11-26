# 神经链接 · 角色统计

入口：角色详情 → 手办之后的「角色统计」。只读取本地数据，不调用模型、不抽取宫殿记忆、不修改小眼睛或世界书状态。刷新按钮重新读取消息窗口和表情映射。

## 统计口径

- 原文窗口复用 `loadCharacterContextRange`，遵守 manual/adaptive、宫殿水位及用户断点。宫殿开关与范围模式分别显示，不能互相推断。
- 月度总结与日度记忆复用 `readableContextMemories`，与 ContextBuilder 的记忆渲染同源。月度总结始终保留；日度记忆只读 activeMemoryMonths 对应月份，兼容中文日期、斜线和单数字月份。宫殿开启不自动关闭日度记忆。
- 世界书由 ContextBuilder.inspectWorldbooks 检查，复用正式关键词判定与宏替换，但不进行概率抽签。统计按私聊场景算：启用场景里没开私聊的条目标「未在私聊启用」，和待关键词、概率候选、停用、空正文、零概率条目一样仍可查看，只有确定命中的条目计入总数。深度、角色、顺序均显示。使用当前共享历史模拟；未来输入和 App 筛选可以改变命中结果。
- 消息以 ChatPrompts 的文字格式化为基准，清理翻译和图片二进制，按 metadata.source 分组。来源表示消息起源，不是只对该 App 可读；不读取独立剧场或群聊会话。
- 其他常驻来源列出角色设定、世界观、内在认知、用户画像、印象、门牌、情绪底色的配置正文；不计提示词包装。门牌在打开面板时从本地现读；召回结果只属于单次请求、不存在角色资料里，所以不展示（见 `memory-system-overview.md`「召回结果只属于这一次请求」）。关闭宫殿不展示门牌。
- 数量均为 Unicode 字符（含标点和空白），不是字节。总数不是实际请求长度，不包括 App 专属规则、媒体成本及本轮动态注入。

## Token 提示

醒目标识「估计值，非真实用量」。本地粗估 ASCII / 4 + 其他字符数，不宣称是任何模型的分词结果。实际看 API usage。

模型间没有固定中文用量比例或大小顺序。页面只引用 DeepSeek 官方的中文字符 × 0.6 示例，并链接 Gemini、Claude 的计数说明；不把某一个模型的比例推广为所有国产模型。此说明不会发起计数 API 调用。

测试：`pnpm exec node node_modules/vitest/vitest.mjs run utils/characterStats.test.ts utils/contextWorldbook.test.ts utils/chatContextRange.test.ts utils/contextPipeline.test.ts`。
