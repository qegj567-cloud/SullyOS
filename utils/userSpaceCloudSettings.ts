import type { CharacterProfile, RealtimeConfig } from '../types';
import type { McpFireServer } from './mcpFireCore';
import { DB, openSpaceDB } from './db';
import { createSpaceStorage, listUserSpaces, rawSpaceStorage, SESSION_SPACE_ID, isUserSpaceDeleting } from './userSpaces';

async function spaceCharacters(id: string): Promise<CharacterProfile[]> {
    if (id === SESSION_SPACE_ID) return DB.getAllCharacters();
    const db = await openSpaceDB(id);
    return new Promise((resolve, reject) => {
        const req = db.transaction('characters').objectStore('characters').getAll();
        req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
}

/** Global connection maintenance must still cover characters behind every frontend space. */
export async function allSpaceCharacters(): Promise<CharacterProfile[]> {
    return (await Promise.all(listUserSpaces().filter(s => !isUserSpaceDeleting(s.id)).map(space => spaceCharacters(space.id)))).flat();
}

/** The worker has one global tool_config: merge audiences, never overwrite it with one space. */
export async function collectSpaceToolSettings(realtime: RealtimeConfig | undefined, servers: McpFireServer[]) {
    if (listUserSpaces().length === 1 || !rawSpaceStorage) return { realtime, servers };
    const audiences = new Map(servers.map(server => [server.id, new Set<string>()]));
    const weatherCities: Record<string, string> = {};
    for (const space of listUserSpaces()) {
        if (isUserSpaceDeleting(space.id)) continue;
        const db = await openSpaceDB(space.id);
        const charIds = await new Promise<IDBValidKey[]>((resolve, reject) => {
            const req = db.transaction('characters').objectStore('characters').getAllKeys();
            req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
        });
        const view = createSpaceStorage(rawSpaceStorage, space.id);
        const config = space.id === SESSION_SPACE_ID ? realtime : JSON.parse(view.getItem('os_realtime_config') || 'null');
        for (const charId of charIds) {
            const city = config?.weatherCities?.[String(charId)];
            if (typeof city === 'string') weatherCities[String(charId)] = city;
        }
        const scopedServers = space.id === SESSION_SPACE_ID ? servers : JSON.parse(view.getItem('aetheros.mcp.servers') || '[]');
        for (const server of scopedServers) {
            const audience = audiences.get(server.id);
            if (!audience) continue;
            for (const charId of charIds) if (!server.charIds?.length || server.charIds.includes(charId)) audience.add(String(charId));
        }
    }
    return {
        realtime: realtime ? { ...realtime, weatherCities } : realtime,
        servers: servers.map(server => ({ ...server, charIds: audiences.get(server.id)!.size ? [...audiences.get(server.id)!] : ['__space_unselected__'] })),
    };
}
