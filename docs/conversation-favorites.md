# 对话合并收藏

收藏的「语音」页支持再次下载单条收藏的音频原件。网页直接保存文件，原生 App 经系统分享面板选择保存位置。取消分享可以重新点下载。

聊天长按消息 → 多选 → 勾选正文 → 合并收藏。收藏作为一条记录出现在收藏的「聊天」页，可展开双方消息、搜索全文、回到仍存在的第一条原消息。只选思考过程不启用合并收藏。

`utils/contentFavorites.ts` 在现有 `kind: chat` 记录上增加可选 `conversation`，保存消息 ID、发送者名字、类型、内容、原始时间和引用，不复制 metadata。旧单条收藏不变。组合 ID 按角色与排序后的消息 ID 生成，重复收藏相同组合会更新快照，不新增重复记录。入口和保存函数都限制角色范围。

合并收藏读取当时快照，不随原消息编辑改变；清理原聊天不影响它。图片的旧 data URL 转为 blobref，已有令牌直接复用。收藏仍在 assets 的 `content_favorites_index_v1` 中，完整备份沿用 assets 和 blobs 旁路。纯文字备份新增 `contentFavoritesIndex` 字段，只恢复收藏索引，不清空其他资源；剥掉图片后显示缺图说明。显示时间沿用用户设备时区。

验证：`pnpm vitest run utils/contentFavorites.test.ts utils/backupRoundtrip.test.ts`。测试覆盖乱序、多次勾选去重、跨角色过滤、删除源消息后保留、完整/纯文字 ZIP 恢复以及图片 blob 恢复。

交互预览：`/test/fixtures/conversation-favorites.html`，使用虚构消息与真实收藏组件。
