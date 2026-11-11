import { createLocalId } from './localId';
import { collectBlobRefs } from './backupBlobs';
import { isSharedSpaceKey } from './userSpaces';

export const newImportedSpaceId = () => `u_${createLocalId()}`;
export const newImportedBlobId = () => `b_${Date.now().toString(36)}_${createLocalId().replace(/-/g, '')}`;

/** Connections and pending deliveries belong to the original installation, not the copied history. */
export const canMigrateLocalKey = (key: string) => !isSharedSpaceKey(key)
    && !/location|geolocation|latitude|longitude|privacy|user_spaces_catalog|import.*progress|^sully_(?:user_spaces|active_user_space|space_)|amsg|active.?msg|push_|notification_target|pending.*(?:job|result)/i.test(key);

const referenceField = (key: string) => /(?:Ids?|_ids?)$/.test(key)
    || ['id', 'key', 'sender', 'author', 'owner', 'speaker', 'target', 'from', 'to', 'members', 'participants', 'romanticPairs', 'relatedTo', 'bubbleStyle'].includes(key);
const opaque = (value: unknown) => value instanceof Blob || value instanceof Date || value instanceof ArrayBuffer || ArrayBuffer.isView(value);
const proseFields = new Set(['name', 'title', 'description', 'systemPrompt', 'prompt', 'instructions', 'text', 'content', 'summary', 'body', 'reason', 'thought']);

/** Remap identity references, never substring-replace names, prompts, CSS or prose. */
export function remapIndependentUser(
    tables: Record<string, any[]>, collabTables: Record<string, any[]>, local: Record<string, string>,
    blobIds: Map<string, string>,
): { tables: Record<string, any[]>; collabTables: Record<string, any[]>; local: Record<string, string> } {
    const ids = new Map<string, string>();
    const charIds = new Map<string, string>();
    for (const char of tables.characters || []) {
        if (typeof char.id !== 'string' || !char.id || ids.has(char.id)) throw new Error('备份中的角色编号无效或重复');
        const id = createLocalId(); ids.set(char.id, id); charIds.set(char.id, id);
    }
    // Vector storage also exists remotely: reusing a memory ID can overwrite another user's vector.
    for (const row of [...(tables.memory_nodes || []), ...(tables.memory_vectors || [])]) {
        const id = row.memoryId || row.id;
        if (typeof id === 'string' && !ids.has(id)) ids.set(id, createLocalId());
    }
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Composite keys contain character IDs. Keep the (potentially huge) memory map out of the regex.
    const pattern = charIds.size ? new RegExp(`(^|[_:/#-])(${[...charIds.keys()].sort((a, b) => b.length - a.length).map(escape).join('|')})(?=$|[_:/#-])`, 'g') : null;
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
    const nextTables: Record<string, any[]> = Object.create(null);
    for (const [store, rows] of Object.entries(tables)) {
        nextTables[store] = rows.filter(row => store !== 'assets' || !/user_spaces_catalog|amsg|active.?msg|pending.*(?:job|result)/i.test(row.id)).map(row => {
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
        });
    }
    return { tables: nextTables, collabTables: walk(collabTables), local: cleanLocal(local) };
}
