# 同行临时视频上传

仅智谱的视频 URL 模式需要。豆包、MiniMax 直接接收 Base64，不使用此服务。此服务是独立 Worker，不接入主代理、主动消息或 CallApp，也没有默认公共实例。

录像会上传到**你自己的 Cloudflare R2**，智谱再读取临时链接。链接随机、120 秒到期，知道完整链接的人在有效期内也能读取；不要公开链接。浏览器在模型请求结束或取消后尝试删除，断网等情况靠定时清理。到期立即拒绝读取，物理删除在下一次 cron 执行；供应商已读取的副本不受这里删除控制。Worker 不记录视频、Key 或链接日志；部署时关闭请求日志采集。

## 控制台部署

1. [注册 / 登录 Cloudflare](https://dash.cloudflare.com/)，创建一个私有 R2 bucket，不开启公共访问。
2. 创建独立 ES Module Worker，将同行接入引导中下载的文件（本目录 `index.js`）完整粘贴部署。
3. 绑定这个 bucket，变量名 **CLIPS**；添加 Secret **UPLOAD_TOKEN**，使用至少 32 位随机字符，不能填智谱 Key。
4. 添加普通变量 **ALLOWED_ORIGINS**，填写使用 SullyOS 的完整 origin，逗号分隔，例如 `http://127.0.0.1:5175,https://your-sully.example`（无末尾斜杠）。
5. 添加 Cron Trigger **`*/5 * * * *`**。建议另外给 bucket 中 `companion-clips/` 前缀设置 1 天过期生命周期，作为 cron 停用时的物理清理兜底。
6. 同行选择智谱，填写模型 URL、Key、ID，以及这个 Worker 的 HTTPS 根地址和同一上传口令，再保存。先用不含私人信息的镜头测试。

配置完成不等于云端已验证；仓库未替用户部署服务或开通计费。实际可用性还取决于浏览器 CORS、智谱到 Worker 的网络可达性、模型额度与地域。R2 / Workers 的请求与存储可能计费。

## 协议与验证

客户端生成 32 位十六进制随机 ID，`PUT /clips/{id}` 上传原始 `video/mp4`，Bearer 上传口令，成功返回 204。限制 8 MB，并检查 MP4 文件头。`GET /clips/{id}` / HEAD 无需模型携带口令；支持单范围 Range，响应 no-store。`DELETE /clips/{id}` 用同一上传口令删除。模型 Key 不传给此服务，上传口令不传给模型；重定向拒绝。

替代上传服务须实现同一协议和过期规则，不是填写任意图床 URL。客户端上传上限 15 秒、视频理解上限 45 秒，两个凭据独立保存；可用性检查要求上传配置齐全。

本地：`pnpm vitest run worker/companion-video/index.test.ts utils/companion/vision.test.ts`。R2 API 与 cron 参考 [Cloudflare 官方 R2 文档](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)和[定时触发器文档](https://developers.cloudflare.com/workers/configuration/cron-triggers/)。
