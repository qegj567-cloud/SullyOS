import type {Home3DRoom} from './types';
export function homeMap(home:{activeRoomId:string;rooms:Pick<Home3DRoom,'id'|'name'|'x'|'z'|'level'|'wall'|'activityRoom'>[]},residentRoom?:string|null,collapsed?:boolean):string;

export function homeDisplayX(home:{rooms:Pick<Home3DRoom,'x'|'z'|'level'|'activityRoom'>[]},room:Pick<Home3DRoom,'x'|'z'|'level'|'activityRoom'>):number;
