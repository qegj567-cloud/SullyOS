import { createLocalId } from './localId';
import { collectBlobRefs } from './backupBlobs';
import { isSharedSpaceKey } from './userSpaces';

// 「迁入为新用户」改编号规则的唯一一份。整份数据一次改完的 remapIndependentUser（independentUserImport.ts）也调用这里。
export const newImportedBlobId = () => `b_${Date.now().toString(36)}_${createLocalId().replace(/-/g, '')}`;

/** Connections and pending deliveries belong to the original installation, not the copied history. */
export const canMigrateLocalKey = (key: string) => !isSharedSpaceKey(key)
    && !/location|geolocation|latitude|longitude|privacy|user_spaces_catalog|import.*progress|^sully_(?:user_spaces|active_user_space|space_)|amsg|active.?msg|push_|notification_target|pending.*(?:job|result)/i.test(key);

const referenceField = (key: string) => /(?:Ids?|_ids?)$/.test(key)
    || ['id', 'key', 'sender', 'author', 'owner', 'speaker', 'target', 'from', 'to', 'members', 'participants', 'romanticPairs', 'relatedTo', 'bubbleStyle'].includes(key);
const opaque = (value: unknown) => value instanceof Blob || value instanceof Date || value instanceof ArrayBuffer || ArrayBuffer.isView(value);
const proseFields = new Set(['name', 'title', 'description', 'systemPrompt', 'prompt', 'instructions', 'text', 'content', 'summary', 'body', 'reason', 'thought']);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export type IndependentUserRemap = ReturnType<typeof createIndependentUserRemap>;

/**
 * 「迁入为新用户」的逐页改编号，分两遍：
 * 1. 扫描：noteCharacter / noteMemory 只记角色、记忆节点、向量的旧编号；
 * 2. finish() 分配新编号，之后 row / collabRow / local 逐页改写。
 * 表按名字排序写入，memory_links 会排在 memory_nodes 前面，所以映射必须在写第一页之前建完。映射只含编号。
 */
export function createIndependentUserRemap(blobIds: Map<string, string>) {
    const sourceChars = new Set<string>(), sourceMemories = new Set<string>();
    const ids = new Map<string, string>(), charIds = new Map<string, string>();
    let pattern: RegExp | null = null;

    const remapKey = (key: string) => {
        if (ids.has(key)) return ids.get(key)!;
        // World-home DM IDs sort the two participants; new UUID ordering can be different.
        if (key.startsWith('dm_')) for (const [a, nextA] of charIds) {
            const prefix = `dm_${a}_`;
            if (key.startsWith(prefix) && charIds.has(key.slice(prefix.length))) return `dm_${[nextA, charIds.get(key.slice(prefix.length))!].sort().join('_')}`;
        }
        return pattern ? key.replace(pattern, (_all, prefix, id) => prefix + ids.get(id)) : key;
    };
    const assetId = (id: string) => {
        if (!blobIds.has(id)) blobIds.set(id, newImportedBlobId());
        return blobIds.get(id)!;
    };
    const walk = (value: any, key = ''): any => {
        if (typeof value === 'string') {
            if (proseFields.has(key)) return value;
            if (/^\s*[\[{]/.test(value)) {
                let parsed: any;
                try { parsed = JSON.parse(value); } catch { /* Not serialized data. */ }
                if (parsed && typeof parsed === 'object') {
                    const next = walk(parsed, key);
                    return JSON.stringify(next) === JSON.stringify(parsed) ? value : JSON.stringify(next);
                }
            }
            const refs = new Set<string>(); collectBlobRefs(value, refs);
            if (refs.size) return value.replace(/blobref:([A-Za-z0-9_]+)/g, (_all, id) => `blobref:${assetId(id)}`);
            if (referenceField(key)) return blobIds.get(value) || remapKey(value);
            return value;
        }
        if (!value || typeof value !== 'object' || opaque(value)) return value;
        if (Array.isArray(value)) return value.map(item => walk(item, key));
        if ((value.format === 'live2d' || value.format === 'vrm') && value.assetId && !value.builtIn) assetId(value.assetId);
        const result: Record<string, any> = Object.create(null);
        for (const [field, item] of Object.entries(value)) {
            // Image messages and structured cards carry references in content; ordinary prose does not.
            const dataContent = field === 'content' && value.type && !['text', 'system', 'voice'].includes(value.type);
            const creatorSelection = ['selected', 'itemColor', 'flipped', 'activeItemFocus'].includes(key);
            result[remapKey(field)] = walk(item, dataContent ? 'data' : creatorSelection ? 'id' : field);
        }
        return result;
    };
    const cleanLocal = (values: Record<string, any>) => Object.fromEntries(Object.entries(values)
        .filter(([key]) => canMigrateLocalKey(key))
        .map(([key, value]) => [remapKey(key), walk(value, key)]));

    return {
        noteCharacter(id: unknown) {
            if (typeof id !== 'string' || !id || sourceChars.has(id)) throw new Error('备份中的角色编号无效或重复');
            sourceChars.add(id);
        },
        noteMemory(row: any) {
            const id = row?.memoryId || row?.id;
            if (typeof id === 'string') sourceMemories.add(id);
        },
        /** 扫描结束后调用一次。角色先分配，记忆编号和角色编号相同时沿用角色的新编号。 */
        finish() {
            for (const id of sourceChars) { const next = createLocalId(); ids.set(id, next); charIds.set(id, next); }
            // Vector storage also exists remotely: reusing a memory ID can overwrite another user's vector.
            for (const id of sourceMemories) if (!ids.has(id)) ids.set(id, createLocalId());
            // Composite keys contain character IDs. Keep the (potentially huge) memory map out of the regex.
            pattern = charIds.size ? new RegExp(`(^|[_:/#-])(${[...charIds.keys()].sort((a, b) => b.length - a.length).map(escape).join('|')})(?=$|[_:/#-])`, 'g') : null;
        },
        newId: (id: string) => ids.get(id),
        /** 主库一行；返回 null 表示这行属于原来那台设备，不迁入。 */
        row(store: string, row: any): any {
            if (store === 'assets' && /user_spaces_catalog|amsg|active.?msg|pending.*(?:job|result)/i.test(row.id)) return null;
            const copy = walk(row);
            if (store === 'characters') {
                copy.activeMsg2Config = { ...copy.activeMsg2Config, enabled: false, instantChatEnabled: false, tasks: [] };
                delete copy.activeMsg2Config.lastSyncedAt; delete copy.activeMsg2Config.lastError;
                // Imported history must not trigger catch-up replies on the first reload.
                if (copy.awayMessage) copy.awayMessage = { ...copy.awayMessage, enabled: false };
                if (copy.dateLeaveReminder) copy.dateLeaveReminder = { ...copy.dateLeaveReminder, enabled: false };
            }
            if (store === 'assets' && row.id === 'ls_mirror_v1') {
                // The mirror can repopulate localStorage at startup. Filter it just like live settings.
                let mirror = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
                mirror = { ...mirror, data: cleanLocal(mirror?.data || {}) };
                copy.data = typeof row.data === 'string' ? JSON.stringify(mirror) : mirror;
            }
            return copy;
        },
        /** 协同库一行；也可以整份传入 { 表名: 行[] }，结果相同。 */
        collabRow: (row: any) => walk(row),
        local: (local: Record<string, string>) => cleanLocal(local),
    };
}
