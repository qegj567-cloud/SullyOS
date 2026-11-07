// D1 限额报错的说明文案。代码由 amsg-server 写进 error.cause.code，定时任务的失败记录也带同一份。
const D1_LIMIT_TEXT: Record<string, string> = {
  D1_STORAGE_FULL: '云端数据库满了，新内容存不进去（Cloudflare 免费版每个库上限 500 MB）。到「云端数据」里删掉不用的内容后就能恢复。',
  D1_DAILY_READ_LIMIT: 'Cloudflare 免费版今天的数据库读取额度用完了，UTC 0 点（北京时间早上 8 点）自动恢复。',
  D1_DAILY_WRITE_LIMIT: 'Cloudflare 免费版今天的数据库写入额度用完了，UTC 0 点（北京时间早上 8 点）自动恢复。',
};

/** 认得出的 D1 限额代码返回一句说明，其余返回空串。 */
export const describeD1LimitCode = (code: unknown): string =>
  typeof code === 'string' && Object.prototype.hasOwnProperty.call(D1_LIMIT_TEXT, code) ? D1_LIMIT_TEXT[code] : '';
