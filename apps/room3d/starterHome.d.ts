import type {Home3DState,Home3DRoom} from './types';
export const STARTER_ROOMS:ReadonlyArray<{name:string;x:number;level:number;kind:string|null}>;
export function createStarterHome(catalog:unknown[],palette?:string):Home3DState;
export function defaultRoomLayout(home:Home3DState,room:Home3DRoom,catalog:unknown[]):Home3DRoom|null;
export function hasDefaultRoomLayout(home:Home3DState,room:Home3DRoom):boolean;
