import * as T from 'three';
import {getCharacterStyle,type CharacterStyle} from './characterStyle';

// A single material pass: retain painted features, cutout hair, skinning and
// garment colours, but replace physical highlights with two painted tones.
// Standalone previews use a fixed illustration light; homes bind their shared
// lighting uniforms and receive the room shadows in the existing material pass.
const originals = new WeakMap<T.MeshStandardMaterial, {
  compile: T.MeshStandardMaterial['onBeforeCompile'];
  cache: T.MeshStandardMaterial['customProgramCacheKey'];
  toneMapped: boolean;
  style: CharacterStyle;
}>();
type RoomLightUniforms = {roomShadeTint:{value:T.Color};roomSunTint:{value:T.Color};roomBrightness:{value:number};roomSunContrast:{value:number};roomShadeSoftness?:{value:number}};
const roomTints = new WeakMap<T.MeshStandardMaterial, {value:T.Color}>();
const roomLights = new WeakMap<T.MeshStandardMaterial, {enabled:{value:number}; uniforms:RoomLightUniforms}>();

export function setCharacterRoomLighting(root:T.Object3D,uniforms:RoomLightUniforms){
 root.traverse(object=>{
  if(!(object instanceof T.Mesh))return;
  object.receiveShadow=true;
  for(const material of Array.isArray(object.material)?object.material:[object.material]){
   if(!(material instanceof T.MeshStandardMaterial))continue;
   const room=roomLights.get(material);if(!room||room.uniforms===uniforms)continue;
   room.enabled.value=1;room.uniforms=uniforms;material.needsUpdate=true;
  }
 });
}

// Keep faces legible while giving all residents the same room colour cast.
// Standalone avatar previews keep a neutral tint.
export function setCharacterRoomTint(root:T.Object3D,color:string){
 root.traverse(object=>{
  if(!(object instanceof T.Mesh))return;
  for(const material of Array.isArray(object.material)?object.material:[object.material]){
   if(!(material instanceof T.MeshStandardMaterial))continue;
   const tint=roomTints.get(material);if(tint)tint.value.set(color);
  }
 });
}

export function setCharacterIllustration(root:T.Object3D, enabled=true, style=getCharacterStyle()) {
  const seen = new Set<T.Material>();
  root.traverse(object => {
    if (!(object instanceof T.Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!(material instanceof T.MeshStandardMaterial) || seen.has(material)) continue;
      seen.add(material);
      const original = originals.get(material);
      if (!enabled) {
        if (!original) continue;
        material.onBeforeCompile = original.compile;
        material.customProgramCacheKey = original.cache;
        material.toneMapped = original.toneMapped;
        originals.delete(material);
        roomTints.delete(material);
        roomLights.delete(material);
      } else {
        if (original?.style===style) continue;
        const saved = original??{compile:material.onBeforeCompile, cache:material.customProgramCacheKey, toneMapped:material.toneMapped,style};
        material.onBeforeCompile=saved.compile;
        material.customProgramCacheKey=saved.cache;
        const cacheKey = material.customProgramCacheKey();
        const face=!!material.userData.illustrationFace;
        const hair=!!material.userData.illustrationHair || /hair/.test(object.name);
        originals.set(material,{...saved,style});
        const roomTint=roomTints.get(material)??{value:new T.Color('#ffffff')};roomTints.set(material,roomTint);
        const room=roomLights.get(material)??{enabled:{value:0},uniforms:{roomShadeTint:{value:new T.Color('#ffffff')},roomSunTint:{value:new T.Color('#ffffff')},roomBrightness:{value:1},roomSunContrast:{value:0}}};roomLights.set(material,room);
        material.toneMapped = false;
        material.onBeforeCompile = (shader,renderer) => {
          saved.compile.call(material,shader,renderer);
          shader.uniforms.characterRoomTint=roomTint;
          shader.uniforms.characterRoomEnabled=room.enabled;
          Object.assign(shader.uniforms,room.uniforms);
          shader.fragmentShader='uniform vec3 characterRoomTint;\nuniform float characterRoomEnabled;\nuniform vec3 roomShadeTint;\nuniform vec3 roomSunTint;\nuniform float roomBrightness;\nuniform float roomSunContrast;\n'+shader.fragmentShader;
          if(style==='modern'){
            shader.uniforms.roomShadeSoftness=(room.uniforms as RoomLightUniforms).roomShadeSoftness??{value:0};
            shader.fragmentShader='uniform float roomShadeSoftness;\n'+shader.fragmentShader;
          }
          if(style==='modern')shader.fragmentShader = shader.fragmentShader.replace('#include <shadowmap_pars_fragment>', '#include <shadowmap_pars_fragment>\n#include <shadowmask_pars_fragment>');
          shader.fragmentShader = shader.fragmentShader.replace(
            'vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;',
            style==='legacy'?`
            vec3 inkLight = normalize(mat3(viewMatrix) * vec3(-0.45, 0.8, 0.65));
            float inkFacing = dot(normal, inkLight);
            float inkEdge = max(fwidth(inkFacing) * 1.5, 0.012);
            float inkLit = smoothstep(0.12 - inkEdge, 0.12 + inkEdge, inkFacing);
            float inkShade = mix(${material.userData.illustrationFace ? '0.90' : '0.70'}, 1.0, inkLit);
            vec3 inkTint = mix(vec3(0.96, 0.97, 1.0), vec3(1.0), inkLit);
            vec3 inkPreview = diffuseColor.rgb * inkShade * inkTint * characterRoomTint;
            vec3 inkWeights = vec3(.2126,.7152,.0722);
            float inkBase = max(dot(diffuseColor.rgb,inkWeights),.001);
            float inkEnergy = dot(totalDiffuse,inkWeights)/inkBase;
            // directDiffuse includes window occlusion and the actual light direction.
            float inkDirect = dot(reflectedLight.directDiffuse,inkWeights)/inkBase;
            float inkSun = smoothstep(.18,.85,inkDirect);
            float inkRoomShade = mix(${material.userData.illustrationFace ? '.84' : '.68'},1.0,smoothstep(.18,.82,inkEnergy));
            inkRoomShade += inkSun * mix(.12,.38,roomSunContrast);
            vec3 inkRoomTint = mix(roomShadeTint,roomSunTint,inkSun);
            vec3 inkRoom = diffuseColor.rgb * inkRoomShade * inkRoomTint * roomBrightness;
            vec3 outgoingLight = mix(inkPreview,inkRoom,characterRoomEnabled);
            `:`
            vec3 inkLight = normalize(mat3(viewMatrix) * vec3(-0.45, 0.8, 0.65));
            #if NUM_DIR_LIGHTS > 0
              if(characterRoomEnabled > .5) inkLight = directionalLights[0].direction;
            #endif
            float inkFacing = dot(normal, inkLight);
            // Separate the authored shade boundary from ambient intensity.
            float inkSoftness = clamp(roomShadeSoftness*characterRoomEnabled,0.,1.);
            float inkFeather = max(fwidth(inkFacing)*1.5, ${face ? '.20' : '.13'})*mix(1.,1.4,inkSoftness);
            float inkLit = smoothstep(-inkFeather,inkFeather,inkFacing + ${face ? '.23' : hair ? '-.08' : '-.20'});
            float inkShadow = mix(1.,getShadowMask(),characterRoomEnabled);
            inkLit *= mix(${face ? '.62' : '.20'},1.,inkShadow);
            vec3 inkShadeFactor = ${face ? 'vec3(.91,.79,.80)' : hair ? 'vec3(.62,.53,.72)' : 'vec3(.63,.64,.78)'};
            // Neutralise only the lighting tint, keeping dyed clothes and hair intact.
            inkShadeFactor = mix(inkShadeFactor,vec3(dot(inkShadeFactor,vec3(.2126,.7152,.0722))),inkSoftness)*mix(1.,1.08,inkSoftness);
            vec3 inkShadeColor = diffuseColor.rgb * inkShadeFactor;
            vec3 inkShadeTint = mix(vec3(1.),roomShadeTint,characterRoomEnabled*.72);
            vec3 inkLitTint = mix(characterRoomTint,roomSunTint,characterRoomEnabled);
            float inkBrightness = mix(1.,roomBrightness,characterRoomEnabled);
            float inkForm = .90 + .10*smoothstep(-.1,.85,inkFacing);
            vec3 inkColor = mix(inkShadeColor*inkShadeTint,diffuseColor.rgb*.96*inkForm*inkLitTint,inkLit)*inkBrightness;
            vec3 inkView = normalize(vViewPosition);
            float inkFresnel = 1.-clamp(abs(dot(normal,inkView)),0.,1.);
            // Material-space edge shaping, not an extra outline mesh/pass.
            float inkContour = smoothstep(.62,.94,inkFresnel)*${face ? '.035' : '.16'}*(1.-inkLit*.5);
            inkColor *= 1.-inkContour;
            float inkRim = pow(inkFresnel,4.)*smoothstep(-.15,.65,inkFacing)*${face ? '.015' : '.055'};
            ${hair ? 'float inkHighlight=smoothstep(.86,.93,dot(normal,normalize(inkLight+inkView)))*inkLit*.055; inkRim+=inkHighlight;' : ''}
            vec3 outgoingLight = inkColor + (1.-clamp(inkColor,0.,1.))*inkRim*inkLitTint;
            `,
          );
        };
        material.customProgramCacheKey = () => cacheKey + '-character-illustration-v5-' + style + '-' + face + '-' + hair;
      }
      material.userData.characterIllustration = enabled;
      material.needsUpdate = true;
    }
  });
}
