import data from './wardrobeLayering.json';

/** Authored construction, not a guess based on the asset's name. Unknown
 * garments use only the generic geometry path until their profile is supplied. */
export interface GarmentLayeringProfile {
 inner?: 'generic'|'loose-shirt'|'sailor'|'surface-shell';
 outer?: 'generic'|'posed';
 skin?: 'standard'|'whole-surface';
 preserveSkirtOutline?: boolean;
 lower?: 'narrow'|'wide'|'long-skirt';
}
export const layeringProfiles=data.profiles as Record<string,GarmentLayeringProfile>;
export const garmentLayeringAssignments=data.garments as Record<string,string>;
export function layeringForGarment(id:string):Readonly<GarmentLayeringProfile>{
 return layeringProfiles[garmentLayeringAssignments[id]]??{};
}
export function usesPosedInnerFit(id:string){
 const inner=layeringForGarment(id).inner;
 return inner==='loose-shirt'||inner==='sailor';
}
