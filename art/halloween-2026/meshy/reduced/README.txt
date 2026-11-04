万圣节本地减面对照

推荐继续制作的候选（均保留原参考图生成的颜色贴图）：
南瓜装：pumpkin-costume-34000.glb，82,764 → 34,000 三角面，减少 58.9%。
幽灵上衣：ghost-top-24000.glb，61,695 → 23,999 三角面，减少 61.1%。
南瓜灯：pumpkin-lantern-12000.glb，20,767 → 11,999 三角面，减少 42.2%。

衣服数值包括 Meshy 随附人体，不是最终单件穿戴服装的面数。
原版保留在 ../halloween-batch-04-texture/*-smooth.glb，没有覆盖。
本次不调用 Meshy，不花 credits。贴图字节原样保留；同时删除柔和材质不再引用的法线/金属粗糙图，清除未使用顶点和旧 buffer 数据。

减面方法：meshoptimizer simplifyWithAttributes，法线权重 0.5、UV 权重 10，误差上限 0.005，LockBorder，并按重合位置的 UV 差异显式锁定图集接缝顶点。
早期更低面数出现袖子、帽子与灯柄串色，未采纳。加强 UV 边界保护后，实际面数可能高于请求值；文件名中的数字是目标，manifest.json 和页面显示实际面数。
源顶点、UV、法线不重新采样，索引压缩后保持各属性同步。

compare.html：原版、保守减面、轻量候选，同灯光/材质的正侧背对照，支持拖动旋转。
已检查三件各三个方向的实际渲染，无页面异常；衣帽、叶片、波浪边与灯环保留。
尚未完成衣服去人体、拆件、48 骨绑定和动作验收。不能直接作为已实装衣橱成品。

复现：
pnpm node art/halloween-2026/meshy/reduce-models.mjs
pnpm node art/halloween-2026/meshy/verify-reduction.mjs
pnpm node art/halloween-2026/meshy/capture-reduction.mjs

接口参考：https://github.com/zeux/meshoptimizer/blob/master/js/README.md
