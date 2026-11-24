/**
 * 用途 → 落地函数。每个功能一个文件，按需加载（落地代码要读写 IndexedDB，别拖进补收链路的首屏包）。
 * 接入新功能：在这里加一行，再写一个导出 `lander` 的文件。
 */

import type { CloudGenLander, CloudGenPurpose } from '../types';

const LOADERS: Record<CloudGenPurpose, () => Promise<{ lander: CloudGenLander }>> = {
  schedule: () => import('./schedule'),
  'persona-sim': () => import('./personaSim'),
  dream: () => import('./dream'),
};

export const loadCloudGenLander = async (purpose: CloudGenPurpose): Promise<CloudGenLander> =>
  (await LOADERS[purpose]()).lander;
