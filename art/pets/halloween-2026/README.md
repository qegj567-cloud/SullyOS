# 水母、仓鼠与万圣节衣柜

参考图通过内置 image_gen 生成，风格参考既有 pet_cat、pet_slime、pet_shark 缩略图。原图分别为 hamster-reference.png、jellyfish-reference.png。

Meshy image-to-3d（meshy-6、无纹理、6000 目标三角面）真正生成两只模型；原始 GLB、任务 ID、图片及模型 SHA-256、额度记录在 meshy-ledger.json。各 20 积分，共 40；本次生成后余额 656。密钥仅从 MESHY_API_KEY 读取，不写入文件。

`node art/pets/halloween-2026/meshy-pets.mjs status` 查询并下载已有任务，不重复创建。`submit` 只用于未登记的新任务，提交结果不明时不会自动重试。

`node art/pets/halloween-2026/build-pets.mjs` 从保留的 Meshy 源几何离线重建：仓鼠纵深压至 52%，从长条收成圆团；水母去掉嘴巴浮雕与嘴巴配件；减面、重建纯色脸部、沿几何裁切伞缘、删除纹理与 UV。随后运行 `node art/pets/register.mjs` 注册，每种提供 8 套配色。两只基础模型均低于 4000 三角面。

小巫师帽、南瓜帽是独立程序几何配件，可给所有九种宠物穿脱；不属于 Meshy 生成内容。帽子挂到宠物 visual，随移动、睡眠和抱起的父变换运动。`hat` 随 HomePet 本机保存、备份恢复和移出撤回；旧存档默认不戴，未知值归一为 null。已有同时养 7 只的容量不变。

入口：宠物 → 选择小伙伴 → 衣柜。配色页独立，换色不改变帽子。真实模型头像缓存包含帽子 ID。

预览：`pnpm vite --config art/pets/halloween-2026/vite.config.ts`，端口 5204；`/test/fixtures/room3d-pets.html` 看素材，`/test/fixtures/room3d-pet-life.html` 看正式共享宠物系统，`/test/fixtures/home-pets.html` 看 Home3DView。测试房间单独存储，不修改用户已有家园。

生成提示词见 prompts.md。用户后续修订（仓鼠收圆、水母无嘴）在离线几何步骤实现，原始参考图保留为生成来源。
