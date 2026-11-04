# 记账收支与导出

银行 App 和生活记录共用 `bank_transactions`。`BankTransaction.type` 为 `expense` 或 `income`；旧记录没有这个字段时按支出读取，不迁移或猜测旧账性质。金额始终为正数，最多两位小数；`utils/bankLedger.ts` 统一金额校验、收支汇总与 CSV 格式。

- 手动记账两个入口均可选择收入／支出。银行的今日预算、昨日结余奖励和支出分类只统计支出，删除收入也不得减少今日支出。
- 角色代记使用 `[[LIFE:EXPENSE|金额|用途]]` 与 `[[LIFE:INCOME|金额|来源]]`。收入沿用既有 `expense` 模块的授权与可见范围，生活记录 `kind` 区分 `income`；拒绝代记沿原有 transactionId 回滚。去重比较收支类型、日期、金额、备注及时间窗口，不能把同额收入误判为支出重复。
- 提示词区分已到账收入和预期收入、余额、本人账户之间转账。角色读取的摘要分别列收入与支出。
- 统计提供今天、本周、指定月份、全部；收支和结余分别展示。日期按用户设备本地时间，不按角色时区；原始流水时间戳不变。
- 「导出当前范围 CSV」与当前筛选一致；「导出全部 CSV」重新读取数据库全部流水，包含跨月、跨年记录。列为日期、时间、类型、金额、备注、分类；UTF-8 BOM，备注正确处理逗号、引号、换行和表格公式前缀。

回归：`lifeRecords.test.ts`、`communityExports.test.ts`、`communityFixesUI.test.ts`。本机交互样例：`test/fixtures/community-fixes.html`。
