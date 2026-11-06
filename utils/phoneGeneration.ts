import type { CharacterProfile, PhoneContact, PhoneEvidence } from '../types';

export const PHONE_GENERATION_COMMITTED = 'phone-generation-committed';
export interface PhoneGeneration {
    records: PhoneEvidence[];
    contacts?: PhoneContact[];
    baseContacts?: PhoneContact[];
}

/** Merge only this generation's delta, keeping edits and other generations made while awaiting the model. */
export function mergePhoneGeneration(current: CharacterProfile['phoneState'], generation: PhoneGeneration): NonNullable<CharacterProfile['phoneState']> {
    let contacts = [...(current?.contacts || [])];
    const aliases = new Map<string, string | undefined>();
    for (const incoming of generation.contacts || []) {
        const base = generation.baseContacts?.find(contact => contact.id === incoming.id);
        if (base && JSON.stringify(base) === JSON.stringify(incoming)) continue;
        const index = contacts.findIndex(contact => contact.id === incoming.id
            || (incoming.linkedCharId ? contact.linkedCharId === incoming.linkedCharId
                : contact.name.trim().toLowerCase() === incoming.name.trim().toLowerCase()));
        if (index < 0) {
            // A contact deleted during generation must not be resurrected.
            if (base) { aliases.set(incoming.id, undefined); continue; }
            contacts.push(incoming); continue;
        }
        const latest = contacts[index];
        aliases.set(incoming.id, latest.id);
        const merged = { ...latest };
        for (const key of Object.keys(incoming) as (keyof PhoneContact)[]) {
            if (key === 'id') continue;
            if (base ? JSON.stringify(latest[key]) === JSON.stringify(base[key]) : latest[key] === undefined) {
                (merged as any)[key] = incoming[key];
            }
        }
        // A handwritten note is never replaced by generated text.
        if (latest.note) merged.note = latest.note;
        contacts[index] = merged;
    }
    const ids = new Set((current?.records || []).map(record => record.id));
    const records = generation.records.filter(record => !ids.has(record.id)).map(record => record.contactId && aliases.has(record.contactId)
        ? { ...record, contactId: aliases.get(record.contactId) } : record);
    return { ...current, records: [...(current?.records || []), ...records], ...(generation.contacts ? { contacts } : {}) };
}
