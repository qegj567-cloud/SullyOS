import {validateCollaborationAppearance} from '../features/collaboration/appearance';
/** Shared wire format; no browser, database or model dependencies. */
export const BEAUTY_MAX_BYTES = 20 * 1024 * 1024;
export const BEAUTY_PLATFORMS = ['糯米机美化群', '糯米机官方DC'] as const;
export type BeautyKind = 'chat-decoration' | 'appearance';
export interface BeautyMetadata {
  name: string;
  credit: string;
  platforms: string[];
  contact: string;
  allowRemix: boolean;
  allowRedistribute: boolean;
  /** Explicit consent per work. Older submissions remain unlisted. */
  allowPublicListing?: boolean;
  exportVersion: string;
  bugFeedback: 'welcome' | 'self-fix';
  message: string;
}
export interface BeautySubmission {
  id: string;
  kind: BeautyKind;
  shareCode: string | null;
  publishedRevision: string | null;
  pendingRevision: string | null;
  latestRevision: string;
  status: 'pending' | 'approved' | 'rejected';
  metadata: BeautyMetadata;
  reviewNote: string;
  updatedAt: number;
  authorCode?: string;
  catalogHidden?: boolean;
  catalogPublic?: boolean;
}
export interface BeautyShare {
  code: string;
  kind: BeautyKind;
  revision: string;
  metadata: BeautyMetadata;
  bytes: number;
  sha256: string;
}
export interface BeautyRepoInput {
  code: string;
  revision: string;
  requestId: string;
  deviceId: string;
  signature: string;
  message: string;
  consent: true;
}
export function validateBeautyRepo(value: unknown): BeautyRepoInput {
  if (!isRecord(value) || value.consent !== true) throw Error('请同意将署名与反馈交给管理员，人工转达给作者');
  if (!/^S-[A-F0-9]{12}$/.test(value.code) || !/^[a-f0-9]{32}$/.test(value.revision)) throw Error('美化信息无效，请重新领取');
  if (!/^[a-f0-9-]{32,64}$/.test(value.requestId) || !/^[a-f0-9-]{32,64}$/.test(value.deviceId)) throw Error('提交标识无效');
  return { code: value.code, revision: value.revision, requestId: value.requestId, deviceId: value.deviceId, signature: text(value.signature, '署名', 60, true), message: text(value.message, 'Repo', 1200, true), consent: true };
}
export const isRecord = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function text(value: unknown, label: string, max: number, required = false): string {
  if (typeof value !== 'string') throw Error(`${label}格式不正确`);
  const result = value.trim();
  if (result.length > max || (required && !result)) throw Error(`${label}${required ? '不能为空，且' : ''}最多 ${max} 字`);
  return result;
}
export function validateBeautyMetadata(value: unknown): BeautyMetadata {
  if (!isRecord(value)) throw Error('分享说明格式不正确');
  if (!Array.isArray(value.platforms) || value.platforms.length < 1 || value.platforms.some((p: unknown) => !BEAUTY_PLATFORMS.includes(p as any))) throw Error('请选择发放平台');
  if (typeof value.allowRemix !== 'boolean' || typeof value.allowRedistribute !== 'boolean') throw Error('请设置二改和二次传播权限');
  if (value.bugFeedback !== 'welcome' && value.bugFeedback !== 'self-fix') throw Error('请选择反馈偏好');
  if (value.allowPublicListing !== undefined && typeof value.allowPublicListing !== 'boolean') throw Error('请确认是否允许公开展示');
  return {
    name: text(value.name, '美化名', 80, true), credit: text(value.credit, '署名', 60, true),
    platforms: [...new Set(value.platforms)] as string[], contact: text(value.contact, '联系说明', 160),
    allowRemix: value.allowRemix, allowRedistribute: value.allowRedistribute,
    ...(value.allowPublicListing !== undefined ? {allowPublicListing:value.allowPublicListing} : {}),
    exportVersion: text(value.exportVersion, '导出版本', 80, true), bugFeedback: value.bugFeedback,
    message: text(value.message, '作者留言', 2000),
  };
}

/** Structural admission only, not content review. Never accept whole-system backups. */
export function validateBeautyPackage(value: unknown): { kind: BeautyKind; data: Record<string, any> } {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200) throw Error('请提交有效的美化预设文件');
  if (value.format === 'sullyos-chat-decoration' && value.version === 1 && isRecord(value.parts)) {
    const parts = { ...value.parts };
    const keys = Object.keys(value.parts);
    if (!keys.length || keys.some(key => !['layout', 'bubbles', 'background', 'sound', 'css', 'psyche', 'schedule', 'journal', 'date', 'story', 'collaboration'].includes(key))) throw Error('聊天装扮包含未知内容');
    if (keys.includes('collaboration')) {
      if (keys.length !== 1) throw Error('协同工作美化请单独提交');
      parts.collaboration = validateCollaborationAppearance(value.parts.collaboration);
    }
    if ((keys.includes('date') || keys.includes('story')) && keys.length !== 1) throw Error('见面与剧情界面美化请单独提交');
    for (const key of ['date', 'story']) if (value.parts[key] !== undefined) {
      const part = value.parts[key];
      if (!isRecord(part) || !['none', 'novel', 'paper', 'night'].includes(part.preset)) throw Error('见面／剧情美化样式无效');
      parts[key] = { preset: part.preset, ...(typeof part.name === 'string' ? { name: part.name.slice(0, 60) } : {}) };
    }
    if ((keys.includes('schedule')||keys.includes('journal'))&&keys.length!==1) throw Error('App 美化请按分类分别提交');
    if (value.parts.css !== undefined && typeof value.parts.css !== 'string') throw Error('CSS 格式不正确');
    return { kind: 'chat-decoration', data: { format: value.format, version: 1, name: value.name, parts } };
  }
  if (value.type === 'sully_appearance_preset' && value.version === 1 && isRecord(value.theme)) {
    const data: Record<string, any> = { type: value.type, version: 1, name: value.name, theme: value.theme };
    for (const key of ['customIcons', 'chatThemes', 'chatLayout']) if (value[key] !== undefined) data[key] = value[key];
    return { kind: 'appearance', data };
  }
  throw Error('只支持聊天装扮和外观预设，不接受角色卡或整机备份');
}

export function validateBeautyPassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128) throw Error('密码需为 12–128 个字符，请勿复用其他账号密码');
  return value;
}
