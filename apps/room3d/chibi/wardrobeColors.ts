import * as T from 'three';
import definitions from './wardrobeColorRegions.json';

export type WardrobeColors = Record<string, Record<string, string>>;
export interface GarmentColorRegion {
 id:string;
 label:string;
 color:string;
 targets:Array<{material:number;source?:string}>;
}
export const garmentColorRegions:Record<string,GarmentColorRegion[]> = definitions;
export function normalizeGarmentColor(value:unknown):string|undefined {
 if(typeof value!=='string')return;
 const hex=value.trim().toLowerCase();
 if(/^#[0-9a-f]{6}$/.test(hex))return hex;
 if(/^#[0-9a-f]{3}$/.test(hex))return '#'+hex.slice(1).split('').map(c=>c+c).join('');
}
export function cleanWardrobeColors(value:unknown):WardrobeColors {
 const clean:WardrobeColors={};
 if(!value||typeof value!=='object')return clean;
 for(const [garment,regions] of Object.entries(garmentColorRegions)){
  const stored=(value as WardrobeColors)[garment];
  if(!stored||typeof stored!=='object')continue;
  for(const region of regions){const color=normalizeGarmentColor(stored[region.id]);if(color)(clean[garment]??={})[region.id]=color;}
 }
 return clean;
}

/** Configure an instance-owned material; source maps and vertex colors stay read-only.
 * Uniform deltas recolor the authored palette after map/vertex-color sampling and
 * before lighting. This can lighten charcoal while keeping painted seams, UVs,
 * alpha and material roughness. Unchanged regions have an exact zero delta.
 */
export function createGarmentColorController(material:T.MeshStandardMaterial,garment:string,materialIndex:number){
 const regions=(garmentColorRegions[garment]??[]).flatMap(region=>region.targets.filter(t=>t.material===materialIndex).map(target=>({region,target})));
 const original=material.color.clone();
 if(!regions.length)return (_value?:Record<string,string>)=>{};
 if(regions.length===1&&!regions[0].target.source){
  return (value?:Record<string,string>)=>{const color=normalizeGarmentColor(value?.[regions[0].region.id]);material.color.copy(color?new T.Color(color):original);};
 }
 const sources=regions.map(({target})=>target.source?new T.Color(target.source):original.clone());
 const deltas=sources.map(()=>new T.Color(0,0,0));
 const count=regions.length;
 const lapelMask=count===2&&material.userData.wardrobePaletteAttribute==='_lapel';
 material.onBeforeCompile=shader=>{
  shader.uniforms.wardrobeSources={value:sources};
  shader.uniforms.wardrobeDeltas={value:deltas};
  shader.fragmentShader=`uniform vec3 wardrobeSources[${count}];\nuniform vec3 wardrobeDeltas[${count}];\n`+shader.fragmentShader;
  if(lapelMask){
   shader.vertexShader='attribute float _lapel;\nvarying float wardrobeLapel;\n'+shader.vertexShader;
   shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nwardrobeLapel = _lapel;');
   shader.fragmentShader='varying float wardrobeLapel;\n'+shader.fragmentShader;
   shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
    diffuseColor.rgb = max(vec3(0.0), diffuseColor.rgb + mix(wardrobeDeltas[0], wardrobeDeltas[1], clamp(wardrobeLapel, 0.0, 1.0)));
   `);
  }else shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
   vec3 wardrobeOriginal = diffuseColor.rgb;
   vec3 wardrobeDelta = vec3(0.0);
   float wardrobeTotal = 0.0;
   for (int i = 0; i < ${count}; i++) {
    vec3 distanceToSource = wardrobeOriginal - wardrobeSources[i];
    float distanceSquared = max(dot(distanceToSource, distanceToSource), 0.000001);
    float weight = 1.0 / (distanceSquared * distanceSquared);
    wardrobeDelta += wardrobeDeltas[i] * weight;
    wardrobeTotal += weight;
   }
   diffuseColor.rgb = max(vec3(0.0), wardrobeOriginal + wardrobeDelta / wardrobeTotal);
  `);
 };
 material.customProgramCacheKey=()=>`wardrobe-palette-v2:${count}:${lapelMask?'lapel':'rgb'}`;
 return (value?:Record<string,string>)=>{
  regions.forEach(({region},i)=>{
   const color=normalizeGarmentColor(value?.[region.id]);
   // Use vector subtraction: Color.sub clamps negatives, which prevents darkening.
   const target=color?new T.Color(color):sources[i];
   deltas[i].setRGB(target.r-sources[i].r,target.g-sources[i].g,target.b-sources[i].b);
  });
 };
}
