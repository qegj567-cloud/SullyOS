// 存储维护操作的进程内互斥锁。
//
// 孤儿图片 GC 和「优化资源存储」都会大面积读写 blob_assets 与各引用面，且 GC 的 mark
// 不是一致性快照——迁移把字段值从 data: 换成令牌属于「引用搬家」，撞上进行中的 GC
// 有误删风险（@rei-standard/blob-store README 的宿主义务）。两个入口共用这把锁，
// 拿不到就把占用方名字告诉用户，绝不排队静默等待（用户看不到的等待=按钮卡死观感）。
//
// 这里只防同页面内并发。优化资源存储还从扫描到引用提交持有 sharedAssetLock 的
// 独占锁，DB.deleteBlobAsset 使用同一把锁；支持 Web Locks 时跨标签页也生效。
// 72h 新鲜豁免仅保护新 Blob，不能保护去重时准备复用的旧图片。

let holder: string | null = null;

/** 尝试拿锁。成功返回 true；已被占用返回 false（用 currentMaintenanceHolder 查占用方）。 */
export function tryAcquireMaintenanceLock(name: string): boolean {
    if (holder !== null) return false;
    holder = name;
    return true;
}

/** 释放锁。调用方必须在 finally 里保证释放，否则两个维护入口一起报废。 */
export function releaseMaintenanceLock(): void {
    holder = null;
}

/** 当前占用方名字；空闲时 null。 */
export function currentMaintenanceHolder(): string | null {
    return holder;
}
