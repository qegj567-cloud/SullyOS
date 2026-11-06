import { SESSION_SPACE_ID } from './userSpaces';

declare global {
    interface Window {
        __sullySpaceTransition?: {
            arriving(id: string): boolean;
            begin(id: string, name: string): Promise<void>;
            finish(): void;
            cancel(): void;
        };
    }
}
export function isUserSpaceArrival() {
    return typeof window !== 'undefined' && !!window.__sullySpaceTransition?.arriving(SESSION_SPACE_ID);
}
export async function beginUserSpaceTransition(id: string, name: string) {
    await window.__sullySpaceTransition?.begin(id, name);
}
export function finishUserSpaceTransition() { window.__sullySpaceTransition?.finish(); }
export function cancelUserSpaceTransition() { window.__sullySpaceTransition?.cancel(); }
