import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import manifest from '../apps/room3d/chibi/faceAssets.json';
import {faceAssets,defaultFace,cleanFace,applyEyePreset,eyeStyles,upperStyles,faceLayerIds} from '../apps/room3d/chibi/faceAppearance';
import originals from '../apps/room3d/chibi/faceOriginals.json';
import {eyePairOffset,scleraContour,browExpressionRotation,measureFaceLandmarks,fitHighlight} from '../apps/room3d/chibi/faceLandmarks';
import {cleanAdjustment,transformFaceSide} from '../apps/room3d/chibi/faceAdjustments';
describe('Authored face asset contract',()=>{
 it('restores the original preset rather than retaining a previous mixed or adjusted eye',()=>{
  for(const style of upperStyles){
   const preset=applyEyePreset({...defaultFace,upper:'03',eye:'06',brow:'03',highlight:'05',eyeState:'half',eyeOffsetY:9,pupilSrc:'old-custom',adjustments:{iris:{y:10},upper:{size:1.3},mouth:{width:.8}}},style);
   expect(preset).toMatchObject({upper:style,brow:'original',highlight:'original',eyeState:'open',eyeOffsetY:0,adjustments:{mouth:{width:.8}}});
   expect(preset.adjustments?.iris).toBeUndefined();expect(preset.pupilSrc).toBeUndefined();
  }
  for(const asset of Object.values(originals.assets))expect(createHash('sha256').update(readFileSync(`public/${asset.src}`)).digest('hex')).toBe(asset.sha256);
 });
 it('keeps the three mouth choices separate and migrates a legacy smile without changing the closed default',()=>{
  const migrated=cleanFace({mouth:'smile-08'});
  expect(migrated.mouths).toEqual({closed:'closed-04',open:'open-01',smile:'smile-08'});
  const chosen=cleanFace({...migrated,mouths:{closed:'closed-03',open:'open-02',smile:'smile-02'}});
  expect(chosen.mouths).toEqual({closed:'closed-03',open:'open-02',smile:'smile-02'});
  expect(cleanFace({mouths:{closed:'open-01',open:'invalid',smile:'closed-01'}}).mouths).toEqual({closed:'closed-04',open:'open-01',smile:'smile-02'});
 });
 it('moves bitmap landmarks together and keeps neutral tuning unchanged',()=>{
  for(const [i,side] of faceAssets['iris-01-open'].sides!.entries()){
   expect(transformFaceSide(side,{},i)).toEqual(side);
   const moved=transformFaceSide(side,{y:7,spacing:4},i);
   expect(moved.anchor-side.anchor).toBe(7);
   expect(moved.x-side.x).toBe(i?4:-4);
   expect(moved.edge).toEqual(side.edge.map(y=>y+7));
   const scaled=transformFaceSide(side,{size:1.4,width:.8},i);
   expect(scaled.bottom-scaled.top).toBeCloseTo((side.bottom-side.top)*1.4);
   expect(scaled.right-scaled.left).toBeCloseTo(Math.round((side.right-side.left)*1.4*.8),-1);
   expect(scaled.edge).toHaveLength(scaled.right-scaled.left+1);
  }
  expect(cleanAdjustment({size:NaN,width:Infinity,y:100,spacing:-100})).toEqual({size:1,width:1,y:25,spacing:-16});
 });
 it('publishes every paired state and keeps all source bytes traceable',()=>{
  expect(Object.keys(manifest.assets)).toHaveLength(77);
  for(const asset of Object.values(manifest.assets)){
   expect(createHash('sha256').update(readFileSync(`public/${asset.src}`)).digest('hex')).toBe(asset.sha256);
   expect(asset.sourceLayer).toBeTruthy();
  }
  for(const style of eyeStyles)for(const state of ['open','half']){
   expect(faceAssets[`white-${style}-${state}`].sides).toHaveLength(2);
   expect(faceAssets[`iris-${style}-${state}`].sides).toHaveLength(2);
  }
 });
 it('aligns all lash/eye combinations with one shared offset plus manual adjustment',()=>{
  for(const upper of upperStyles.filter(s=>s!=='04'))for(const eye of eyeStyles)for(const state of ['open','half']){
   const a=faceAssets[`upper-${upper}-${state}`].sides!,b=faceAssets[`iris-${eye}-${state}`].sides!;
   const reference={lash:faceAssets[`upper-${eye}-${state}`].sides!,iris:b};
   const shift=eyePairOffset(a,b,reference),manual=eyePairOffset(a,b,reference,3.5);
   expect(Math.abs(shift)).toBeLessThan(40);
   expect(manual-shift).toBeCloseTo(3.5);
   const nativeGap=reference.lash.reduce((n,l,i)=>n+l.anchor-b[i].anchor,0)/2;
   expect((b[0].anchor+b[1].anchor)/2+shift).toBeCloseTo((a[0].anchor+a[1].anchor)/2-nativeGap);
   if(upper===eye)expect(shift).toBe(0);
  }
 });
 it('reconstructs sclera from the selected lid corners and iris bottom, including manual migration',()=>{
  for(const upper of upperStyles.filter(s=>s!=='04'))for(const eye of eyeStyles)for(const state of ['open','half']){
   const lashes=faceAssets[`upper-${upper}-${state}`].sides!,irises=faceAssets[`iris-${eye}-${state}`].sides!;
   const dy=eyePairOffset(lashes,irises,{lash:faceAssets[`upper-${eye}-${state}`].sides!,iris:irises});
   for(let i=0;i<2;i++){
    const c=scleraContour(lashes[i],irises[i],dy),m=scleraContour(lashes[i],irises[i],dy+4);
    expect(c.A[0]).toBeLessThan(c.D[0]);expect(c.B[0]).toBeLessThan(c.C[0]);
    expect(c.lid[0]).toEqual(c.A);expect(c.lid.at(-1)).toEqual(c.D);
    expect(c.bottom[0]).toEqual(c.C);expect(c.bottom.at(-1)).toEqual(c.B);
    expect(m.A).toEqual(c.A);expect(m.D).toEqual(c.D);
    expect(m.B[1]-c.B[1]).toBe(4);expect(m.C[1]-c.C[1]).toBe(4);
    expect(Math.max(...c.bottom.map(p=>p[1]))).toBeLessThanOrEqual(irises[i].bottom+dy);
   }
  }
 });
 it('keeps native eyebrow slope and only adds small mirrored expression deltas',()=>{
  for(const id of ['01','02','03','04']){
   const sides=faceAssets[`brow-${id}`].sides!;
   for(const side of sides){expect(browExpressionRotation(side,'neutral')).toBe(0);expect(Math.abs(browExpressionRotation(side,'angry'))).toBeLessThanOrEqual(Math.PI/30);}
   expect(browExpressionRotation(sides[0],'angry')).toBeGreaterThan(0);
   expect(browExpressionRotation(sides[1],'angry')).toBeLessThan(0);
   expect(browExpressionRotation(sides[0],'sad')).toBeLessThan(0);
  }
  expect(Math.abs(browExpressionRotation(faceAssets['brow-01'].sides![0],'angry'))).toBeLessThan(Math.abs(browExpressionRotation(faceAssets['brow-02'].sides![0],'angry')));
 });
 it('never draws iris layers for squint, closed or happy-closed eyes',()=>{
  for(const upper of upperStyles)for(const eyeState of ['closed','happy'] as const)expect(faceLayerIds({...defaultFace,upper,eyeState}).closed).toBe(true);
  expect(faceLayerIds({...defaultFace,upper:'04'}).closed).toBe(true);
  expect(cleanFace({upper:'missing',eyeOffsetY:NaN,browOffsetY:100,irisColor:'bad'})).toMatchObject({upper:'01',eyeOffsetY:0,browOffsetY:20,irisColor:defaultFace.irisColor});
 });
 it('ignores detached thin lash flicks when locating the main stroke',()=>{
  const w=100,h=100,p=new Uint8ClampedArray(w*h*4);
  for(const left of [10,60])for(let x=left;x<left+25;x++){p[(10*w+x)*4+3]=255;for(let y=30;y<=35;y++)p[(y*w+x)*4+3]=255;}
  for(const side of measureFaceLandmarks(w,h,p)){expect(side.anchor).toBe(30);expect(side.edge.every(y=>y===35)).toBe(true);}
 });
 it('places the highlight below the eyelid, translating before shrinking proportionally',()=>{
  const mask=(bottom:number)=>{const p=new Uint8ClampedArray(100*100*4);for(let x=10;x<=40;x++)for(let y=30;y<=bottom;y++)p[(y*100+x)*4+3]=255;return p;};
  const source={left:20,right:29,top:5,bottom:24};
  const open=fitHighlight(100,100,mask(65),source,0)!;
  expect(open.scale).toBe(1);expect(open.y).toBe(31);expect(open.width).toBe(10);expect(open.height).toBe(20);
  const half=fitHighlight(100,100,mask(43),source,0)!;
  expect(half.scale).toBeLessThan(1);expect(half.y).toBe(31);expect(half.y+half.height).toBeLessThanOrEqual(42);
  expect(half.width/half.height).toBeCloseTo(.5);
  expect(fitHighlight(100,100,new Uint8ClampedArray(100*100*4),source,0)).toBeUndefined();
 });
});
