import type { CharacterProfile, PhoneEvidence } from '../types';

export const PHONE_EVIDENCE_SYNCED = 'phone-evidence-synced';
export interface PhoneEvidenceChatLink { charId: string; recordId: string; messageId: number }
export const phoneEvidenceDeliveryId = (recordId: string): string => `phone-evidence:${recordId}`;

/** 事务已经落盘，界面只合并关联编号，不覆盖联系人、正文或其他并发编辑。 */
export function applyPhoneEvidenceChatLink(character: CharacterProfile, link: PhoneEvidenceChatLink): CharacterProfile {
    if (character.id !== link.charId || !character.phoneState?.records?.some(record => record.id === link.recordId)) return character;
    return { ...character, phoneState: { ...character.phoneState, records: character.phoneState.records.map(record =>
        record.id === link.recordId ? { ...record, systemMessageId: link.messageId } : record) } };
}

const renderPhoneField = (input: unknown, seen: Set<object>): string => {
    if (input == null) return '';
    const valueType = typeof input;
    if (valueType === 'string') return input as string;
    if (valueType === 'number' || valueType === 'boolean' || valueType === 'bigint') return String(input);
    if (valueType === 'symbol' || valueType === 'function') return String(input);

    if (valueType === 'object') {
        const objectValue = input as object;
        if (seen.has(objectValue)) return '[循环引用]';
        seen.add(objectValue);
        let text: string;
        if (Array.isArray(input)) {
            text = input.map(item => renderPhoneField(item, seen)).filter(Boolean).join('\n');
        } else {
            const entries = Object.entries(input as Record<string, unknown>);
            text = entries.length
                ? entries.map(([key, value]) => `${key}: ${renderPhoneField(value, seen)}`).join('\n')
                : '';
        }
        seen.delete(objectValue);
        return text;
    }

    return String(input);
};

/**
 * LLM 自定义 App 偶尔会把本应为字符串的字段返回成对象。
 * React 不能直接渲染对象；这里在生成边界和历史数据展示边界统一降级成可读文本。
 */
export function phoneFieldToText(input: unknown, fallback: string = ''): string {
    const text = renderPhoneField(input, new Set()).trim();
    return text || fallback;
}

export function normalizePhoneEvidence(record: PhoneEvidence): PhoneEvidence {
    const raw = record as unknown as Record<string, unknown>;
    const value = phoneFieldToText(raw.value);
    return {
        ...record,
        title: phoneFieldToText(raw.title, 'Unknown'),
        detail: phoneFieldToText(raw.detail, '...'),
        value: value || undefined,
    };
}

/** 生成首次同步与事后补同步共用的私聊卡片载荷。 */
export function buildPhoneEvidenceChatCard(record: PhoneEvidence, appName: string): {
    content: string;
    metadata: { deliveryId: string; phoneCard: { app: string; kind: string; title: string; detail: string; value?: string } };
} {
    const normalized = normalizePhoneEvidence(record);
    const app = phoneFieldToText(appName, '手机');
    const content = normalized.type === 'chat'
        ? `[你手机的聊天软件] 你和「${normalized.title}」的对话：${normalized.detail.replace(/\n/g, ' ')}`
        : `[你手机的${app}] ${normalized.title}${normalized.value ? ` · ${normalized.value}` : ''} — ${normalized.detail}`;
    return {
        content,
        metadata: {
            deliveryId: phoneEvidenceDeliveryId(record.id),
            phoneCard: {
                app,
                kind: normalized.type,
                title: normalized.title,
                detail: normalized.detail,
                value: normalized.value || undefined,
            },
        },
    };
}
