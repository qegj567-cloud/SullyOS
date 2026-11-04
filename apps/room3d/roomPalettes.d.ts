import type {Home3DRoom} from './types';
import type {HomeAsset} from './model.js';
export const ROOM_PALETTES:Record<string,{name:string;wall:string;floor:string;accent:string;trim:string;body:string;soft:string;dark:string;light:string;wood?:string;woodDark?:string;warmDetail?:string}>;
export function paletteRole(name:string,assetId?:string):string|null;
export function hasFixedRoomPalette(room:Home3DRoom):boolean;
export function applyRoomPalette(room:Home3DRoom,palette:string,catalog:HomeAsset[]):Home3DRoom;
