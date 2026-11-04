import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {tintAppearancePixels} from '../apps/room3d/chibi/appearanceColors';
import {HUE_PALETTE,resolveTint,hexForTint,type CreatorHairTint} from '../apps/room3d/chibi/creatorHairTint';
const html=readFileSync('public/like520/character_creator.html','utf8');
const section=(start:string,end:string)=>html.slice(html.indexOf(start),html.indexOf(end));
const helpers=section('function hslToRgb(', '/* 解析 tintColor')+section('function colorHsl(', '/* ===== 取翻转状态');
const tint=section('function applyTint(', '/* 眼睛分左右染色');
const palette=section('const HUE_PALETTE =','const state =');
it('matches every original Chibi palette entry and its full grayscale/alpha ramp exactly',()=>{
 expect(runInNewContext(palette+';HUE_PALETTE')).toEqual(HUE_PALETTE);
 const cases:CreatorHairTint[]=HUE_PALETTE.flatMap((_,hueIdx)=>[0,50,100].map(sat=>({hueIdx,sat,light:(sat-50)/2})));
 cases.push({hueIdx:0,sat:50,light:0,color:'#e2b8cb'},{hueIdx:0,sat:50,light:0,color:'#73513b',gradientColor:'#ecc5d5'});
 for(const c of cases)for(const threshold of [0,25,55]){
  const source=new Uint8ClampedArray(Array.from({length:256*5},(_,i)=>[i%256,i%256,i%256,i%7===0?0:i%3===0?127:255]).flat());
  const expected=source.slice(),actual=source.slice(),ctx={getImageData:()=>({data:expected}),putImageData:()=>{}};
  runInNewContext(palette+helpers+tint+';applyTint(canvas,resolveTint(c));',{state:{preserveLineart:threshold},canvas:{width:256,height:5,getContext:()=>ctx},c});
  tintAppearancePixels(actual,256,5,hexForTint(c),c.gradientColor,c,threshold);
  expect(actual,JSON.stringify(c)+' threshold='+threshold).toEqual(expected);
  expect(runInNewContext(palette+helpers+';resolveTint(c);',{c})).toEqual(resolveTint(c));
 }
});
function legacy(pixels:Uint8ClampedArray,width:number,height:number,color:string,gradientColor?:string,skin=false){
 const ctx={getImageData:()=>({data:pixels}),putImageData:()=>{}};
 runInNewContext(`${helpers}\n${tint}\napplyTint(canvas,{...resolveTint({color,gradientColor}),skin});`,{state:{preserveLineart:25},canvas:{width,height,getContext:()=>ctx},color,gradientColor,skin});
}
it('uses distinct root/tip colors in both creators while retaining alpha and linework',()=>{
 const source=new Uint8ClampedArray(11*3*4);
 for(let y=0;y<11;y++)source.set([128,128,128,255,10,10,10,255,88,77,66,0],y*12);
 const actual=source.slice(),old=source.slice();tintAppearancePixels(actual,3,11,'#ff0000','#0000ff');legacy(old,3,11,'#ff0000','#0000ff');
 // HSL implementations can round a channel one level apart.
 for(let i=0;i<actual.length;i++)expect(Math.abs(actual[i]-old[i])).toBeLessThanOrEqual(1);expect(actual[0]).toBeGreaterThan(actual[2]);expect(actual[120]).toBeLessThan(actual[122]);
 for(let y=0;y<11;y++){expect([...actual.slice(y*12+4,y*12+8)]).toEqual([0,0,0,255]);expect([...actual.slice(y*12+8,y*12+12)]).toEqual([88,77,66,0]);}
});
it('switches back to a uniform color without a stale gradient',()=>{
 const pixels=new Uint8ClampedArray(Array.from({length:11},()=>[128,128,128,255]).flat());
 tintAppearancePixels(pixels,1,11,'#cc8855');expect([...pixels.slice(0,4)]).toEqual([...pixels.slice(-4)]);
});
it('recolors the original skin around the chosen color instead of washing it out',()=>{
 const pixels=new Uint8ClampedArray([200,200,200,255,220,220,220,255,240,240,240,255]);legacy(pixels,3,1,'#806040',undefined,true);
 expect([...pixels.slice(4,7)]).toEqual([128,96,64]);expect(pixels[0]).toBeLessThan(pixels[4]);expect(pixels[8]).toBeGreaterThan(pixels[4]);
});
it('restores linked gradients and custom skin from saved state and rejects invalid colors',()=>{
 const state:any={selected:{},tintColor:{fronthair:{hueIdx:0,sat:50,light:0},skin:{hueIdx:0,sat:50,light:0},eyes:{}},hairLinked:{back1:true},flipped:{}};
 const saved={tintColor:{fronthair:{color:'#123456',gradientColor:'#abcdef'},skin:{color:'#a87654'}},hairLinked:{back1:false}};
 const code=section('function applyFullState(', 'function tryLoadDraft(');
 const context={state,PARTS:[],HUE_PALETTE:[{}],saved};runInNewContext(code+';applyFullState(saved);',context);
 expect(state.tintColor.fronthair).toMatchObject(saved.tintColor.fronthair);expect(state.tintColor.skin.color).toBe('#a87654');expect(state.hairLinked.back1).toBe(false);
 runInNewContext(code+`;applyFullState({tintColor:{fronthair:{color:'bad',gradientColor:'url(x)'}}});`,context);
 expect(state.tintColor.fronthair.color).toBeUndefined();expect(state.tintColor.fronthair.gradientColor).toBeUndefined();
});
