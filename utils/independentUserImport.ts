import { createLocalId } from './localId';
import { createIndependentUserRemap } from './independentUserRemap';

export const newImportedSpaceId = () => `u_${createLocalId()}`;
export { newImportedBlobId, canMigrateLocalKey } from './independentUserRemap';

/** Remap identity references, never substring-replace names, prompts, CSS or prose. Rules live in independentUserRemap.ts. */
export function remapIndependentUser(
    tables: Record<string, any[]>, collabTables: Record<string, any[]>, local: Record<string, string>,
    blobIds: Map<string, string>,
): { tables: Record<string, any[]>; collabTables: Record<string, any[]>; local: Record<string, string> } {
    const remap = createIndependentUserRemap(blobIds);
    for (const char of tables.characters || []) remap.noteCharacter(char.id);
    for (const row of [...(tables.memory_nodes || []), ...(tables.memory_vectors || [])]) remap.noteMemory(row);
    remap.finish();
    const nextTables: Record<string, any[]> = Object.create(null);
    for (const [store, rows] of Object.entries(tables)) nextTables[store] = rows.map(row => remap.row(store, row)).filter(row => row !== null);
    return { tables: nextTables, collabTables: remap.collabRow(collabTables), local: remap.local(local) };
}
