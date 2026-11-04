import type {APIConfig, CharacterProfile, DialogueApiConfig} from '../types';
import {DB} from './db';
import {pickDialogueApi, resolveDialogueApi} from './characterApi';

// Keep credentials separate from feed settings/material sent to characters.
export const FRIEND_FEED_API_KEY = 'friend_feed_api';
export async function readFriendFeedApi(): Promise<DialogueApiConfig | null> {
    const raw = await DB.getAsset(FRIEND_FEED_API_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (value === null) return null;
    if (!value || typeof value.baseUrl !== 'string' || typeof value.apiKey !== 'string' || typeof value.model !== 'string')
        throw new Error('哔哔 API 配置损坏，请重新保存');
    return pickDialogueApi(value);
}
export async function saveFriendFeedApi(value: DialogueApiConfig | null) {
    await DB.saveAsset(FRIEND_FEED_API_KEY, JSON.stringify(value ? pickDialogueApi(value) : null));
}
export async function resolveFriendFeedApi(globalApi: APIConfig, char: CharacterProfile) {
    return resolveDialogueApi(globalApi, char, await readFriendFeedApi());
}
