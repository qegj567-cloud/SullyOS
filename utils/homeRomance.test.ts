import {afterEach,expect,it,vi} from 'vitest';
import {Group,OrthographicCamera,Vector3} from 'three';
import {hasRomanticPair,homeSocialActionAllowed,isRomanticMotion,normalizeRomanticPairs,updateRomanticPair} from '../apps/room3d/homeRomance';
import {createSocialScene} from '../apps/room3d/chibi/selectedSocial';
// @ts-expect-error Runtime JS module.
import {createPhotoSession} from '../apps/room3d/photoSession.js';
import {createHome,validateHome} from '../apps/room3d/model.js';
import catalog from '../public/room3d/catalog.json';
import motions from '../apps/room3d/chibi/selectedMotionCatalog.json';
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
it('denies every intimate clip by default, including old homes and apparent high affinity',()=>{
 const home={affinity:100,relationship:'情侣',socialMemberIds:['A','B']} as any;
 const ids=motions.filter(m=>m.category==='close').map(m=>m.id).concat(['cmu-20_10','cmu-22_09']);
 for(const id of ids){expect(isRomanticMotion(id)).toBe(true);expect(homeSocialActionAllowed(home,id,'A','B')).toBe(false);}
 expect(homeSocialActionAllowed({},'cmu-18_08','A','B')).toBe(true);expect(homeSocialActionAllowed({},'cmu-22_13','A','B')).toBe(true);
});
it('authorizes only the exact declared pair, symmetrically, with no transitive permission',()=>{
 const home={romanticPairs:updateRomanticPair({},'A','B',true)};
 expect(homeSocialActionAllowed(home,'home-hug','A','B')).toBe(true);expect(homeSocialActionAllowed(home,'home-hug','B','A')).toBe(true);
 for(const [a,b]of [['A','C'],['user','A'],['B','C'],['A','A']])expect(homeSocialActionAllowed(home,'home-hug',a,b)).toBe(false);
 home.romanticPairs=updateRomanticPair(home,'B','A',false);expect(hasRomanticPair(home,'A','B')).toBe(false);
});
it('persists explicit pairs, rejects malformed imports, and leaves old homes unapproved',()=>{
 const home=createHome(catalog as any);expect(validateHome(home,catalog as any).romanticPairs).toBeUndefined();
 home.romanticPairs=[['B','A'],['A','B']];expect(validateHome(home,catalog as any).romanticPairs).toEqual([['A','B']]);
 expect(()=>normalizeRomanticPairs([['A','A']])).toThrow();expect(()=>normalizeRomanticPairs([['A','B','C']])).toThrow();
});
const residents=()=>['A','B'].map(id=>({id,visitor:{root:new Group(),animate:vi.fn(),finishPose:vi.fn()} as any}));
it('blocks animation before loading a clip even if the caller supplies an intimate ID directly',async()=>{
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);const scene=createSocialScene(residents(),{canInteract:(id,a,b)=>homeSocialActionAllowed({},id,a,b)});
 await expect(scene.start('home-hug','A','B')).rejects.toThrow('浪漫关系');expect(fetch).not.toHaveBeenCalled();expect(scene.active).toBe(false);
});
it('rechecks relationship after asynchronous motion loading before staging either person',async()=>{
 let allowed=true,resolve!:(value:any)=>void;vi.stubGlobal('fetch',vi.fn(()=>new Promise(r=>{resolve=r;})));
 const scene=createSocialScene(residents(),{canInteract:()=>allowed}),pending=scene.start('home-hug','A','B');allowed=false;
 resolve({ok:true,json:async()=>({version:1,id:'home-hug',actors:[{},{}]})});await expect(pending).rejects.toThrow('浪漫关系');expect(scene.active).toBe(false);
});
it('applies the same restriction to photo interactions without changing actor transforms',async()=>{
 const actors=residents().map(r=>({id:r.id,label:r.id,root:r.visitor.root,person:r.visitor}));actors[1].root.position.x=2;
 const session=createPhotoSession({actors,camera:new OrthographicCamera(),controls:{target:new Vector3()},invalidate:vi.fn(),canInteract:(id:string,a:string,b:string)=>homeSocialActionAllowed({},id,a,b)});
 await expect(session.interaction('home-hug','A','B')).rejects.toThrow('浪漫关系');expect(actors[1].root.position.x).toBe(2);session.restore();
});
