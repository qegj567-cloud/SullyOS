# bifang · 彼方公共后端

Worker 和 D1 使用同名 `bifang`。正式入口 `https://bifang.friedsully.com/po`。

邮局与活动纪念馆复用 `../post-office/src/index.ts`；本目录增加服务端核实诗句归属的恢复入口。部署、数据范围和恢复限制见 [迁移说明](../../docs/bifang-migration.md)。

```sh
pnpm build:workers
pnpm dlx wrangler@4.122.0 deploy --config worker/bifang/wrangler.toml
```

首次部署必须先把 `../post-office/schema.sql`、本目录 `schema.sql` 和经校验的公开诗集导入新 D1。不要把首次导入 SQL 重放到生产库。管理员令牌与限流盐使用 Worker Secret；本机备份在被 Git 忽略的 `.dev.vars`，不放入源码或前端。
