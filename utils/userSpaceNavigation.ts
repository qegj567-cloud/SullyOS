import { openSpaceDB } from './db';
import { listUserSpaces, SESSION_SPACE_ID, selectUserSpace, isUserSpaceDeleting } from './userSpaces';

const PENDING_KEY = 'sully_space_notification_target_v1';
export async function findCharacterSpace(charId: string): Promise<string | null> {
    let owner: string | null = null;
    for (const space of listUserSpaces()) {
        if (isUserSpaceDeleting(space.id)) continue;
        const db = await openSpaceDB(space.id);
        const found = await new Promise<boolean>((resolve, reject) => {
            const request = db.transaction('characters').objectStore('characters').getKey(charId);
            request.onsuccess = () => resolve(request.result !== undefined); request.onerror = () => reject(request.error);
        });
        if (!found) continue;
        if (owner) throw new Error('角色编号同时出现在两个用户空间，无法确定通知归属');
        owner = space.id;
    }
    return owner;
}

/** Notification clicks change only the frontend space. No schedule/config writes. */
export async function routeCharacterNotification(charId: string): Promise<'current' | 'switching' | 'missing'> {
    const owner = await findCharacterSpace(charId);
    if (!owner) return 'missing';
    if (owner === SESSION_SPACE_ID) return 'current';
    // If session storage is unavailable, fail before switching rather than losing the destination.
    window.sessionStorage.setItem(PENDING_KEY, JSON.stringify({ spaceId: owner, charId }));
    window.sessionStorage.setItem('sully_space_switch_notice', owner);
    selectUserSpace(owner);
    window.location.reload();
    return 'switching';
}
export function takeSpaceNotificationTarget(): string | null {
    try {
    const raw = window.sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const target = JSON.parse(raw);
    if (target.spaceId !== SESSION_SPACE_ID) return null;
    window.sessionStorage.removeItem(PENDING_KEY);
    return typeof target.charId === 'string' ? target.charId : null;
    } catch { return null; }
}
