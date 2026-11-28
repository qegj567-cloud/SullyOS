import {beforeEach,expect,it,vi} from 'vitest';
import {canEditDecoration,importedOrigin,readDecorationOrigin,saveLibraryDecoration,combineDecorationOrigins,DECORATION_STORE,readLibraryDecorations,deleteLibraryDecoration,replaceReceivedDecoration,remixOrigin,originLabel} from './decorationLibrary';
const assets=vi.hoisted(()=>new Map<string,string>());
vi.mock('./db',()=>({DB:{saveAssetBatch:vi.fn(async(entries:any[])=>{for(const entry of entries)assets.set(entry.id,entry.data);}),getAsset:async(key:string)=>assets.get(key)||null,saveAsset:async(key:string,value:string)=>{assets.set(key,value);}}}));
vi.mock('./beautyUsage',()=>({decorationSourceKey:async(p:any)=>'chat-'+p.name,rememberBeautySource:async(key:string,share:unknown)=>{assets.set('beauty_source_'+key,JSON.stringify(share));}}));
const preset={format:'sullyos-chat-decoration' as const,version:1 as const,name:'测试',parts:{css:'.sully-chat-root{color:red}'}};
beforeEach(()=>assets.clear());
it('combines authors without relaxing the most restrictive permission',()=>{
 const result=combineDecorationOrigins([{kind:'self'},{kind:'imported',credit:'甲',allowRemix:true,allowRedistribute:true},{kind:'imported',credit:'乙',allowRemix:true,allowRedistribute:false}]);
 expect(result).toMatchObject({kind:'imported',credit:'甲 · 乙',allowRemix:true,allowRedistribute:false});
 expect(canEditDecoration(combineDecorationOrigins([result,{kind:'imported',allowRemix:false}]))).toBe(false);
});
it('keeps imported restrictions and never treats a file claiming self authorship as self',()=>{
 const origin=importedOrigin({beautyOrigin:{kind:'self',allowRemix:false,allowRedistribute:false,credit:'原作者'}});
 expect(origin.kind).toBe('imported');expect(canEditDecoration(origin)).toBe(false);expect(origin.credit).toBe('原作者');
});
it('prefers share metadata over a conflicting self label',async()=>{
 assets.set('decoration_origin_x',JSON.stringify({kind:'self'}));assets.set('beauty_source_x',JSON.stringify({metadata:{allowRemix:false,credit:'作者'}}));
 expect(canEditDecoration(await readDecorationOrigin('x'))).toBe(false);
});
it('saves a self draft and updates only that original',async()=>{
 const key=await saveLibraryDecoration(preset,{kind:'self'});
 await saveLibraryDecoration({...preset,name:'新版'},{kind:'self'},key);
 expect(JSON.parse(assets.get(DECORATION_STORE)!)).toHaveLength(1);
 expect((await readDecorationOrigin('chat-新版')).kind).toBe('self');
});
it('refuses overwriting imported originals, leaving the collection intact',async()=>{
 const key=await saveLibraryDecoration(preset,{kind:'imported',allowRemix:true});
 await expect(saveLibraryDecoration({...preset,name:'新版'},{kind:'self'},key)).rejects.toThrow('仅自制');
 expect(JSON.parse(assets.get(DECORATION_STORE)!)[0].name).toBe('测试');
});
it('preserves attribution and restrictions on a permitted remix',async()=>{
 const origin={kind:'imported' as const,allowRemix:true,allowRedistribute:false,credit:'作者'};
 const key=await saveLibraryDecoration(preset,origin);
 expect(await readDecorationOrigin(key)).toEqual(origin);
 expect((await readDecorationOrigin('unknown')).kind).toBe('legacy');
});

it('keeps stable identity through edits and distinguishes identical copies',async()=>{
 const a=await saveLibraryDecoration(preset,{kind:'self'});const b=await saveLibraryDecoration(preset,{kind:'self'});
 expect(a).not.toBe(b);await saveLibraryDecoration({...preset,name:'改名'}, {kind:'self'},a);
 const list=await readLibraryDecorations();expect(list.find(p=>p._libraryId===a)?.name).toBe('改名');expect(list.find(p=>p._libraryId===b)?.name).toBe('测试');
 await deleteLibraryDecoration(b);expect((await readLibraryDecorations()).map(p=>p._libraryId)).toEqual([a]);
 await expect(saveLibraryDecoration(preset,{kind:'self'},b)).rejects.toThrow('不存在');
});
it('migrates old records once, without exposing IDs in exported packages',async()=>{
 assets.set(DECORATION_STORE,JSON.stringify([preset,preset]));const first=await readLibraryDecorations();
 expect(new Set(first.map(p=>p._libraryId)).size).toBe(2);expect(await readLibraryDecorations()).toEqual(first);
 const {validateDecoration}=await import('./chatDecoration');expect(validateDecoration(first[0])).not.toHaveProperty('_libraryId');
});
it('replaces a code import only for its original code and expected local revision',async()=>{
 const share={code:'S-AAAAAAAAAAAA',kind:'chat-decoration',revision:'one',metadata:{allowRemix:false,credit:'作者'}} as any;
 const id=await saveLibraryDecoration(preset,{kind:'imported',share});
 await expect(replaceReceivedDecoration(id,{...preset,name:'恶意串码'},{...share,code:'S-BBBBBBBBBBBB',revision:'two'},'one')).rejects.toThrow('版本已变化');
 expect((await readLibraryDecorations())[0].name).toBe('测试');
 await replaceReceivedDecoration(id,{...preset,name:'审核新版'},{...share,revision:'two'},'one');
 expect((await readLibraryDecorations())[0]).toMatchObject({_libraryId:id,name:'审核新版'});
 expect(originLabel(await readDecorationOrigin(id))).toBe('码导入');expect(canEditDecoration(await readDecorationOrigin(id))).toBe(false);
 await expect(replaceReceivedDecoration(id,preset,{...share,revision:'three'},'one')).rejects.toThrow('版本已变化');
});
it('separates an allowed remix from the code original while preserving permissions',async()=>{
 const origin={kind:'imported',share:{code:'S-AAAAAAAAAAAA'},allowRemix:true,allowRedistribute:false,credit:'作者'} as any;
 const result=remixOrigin(origin);expect(result.kind).toBe('remix');expect(result.share).toBeUndefined();expect(result.allowRedistribute).toBe(false);
 const id=await saveLibraryDecoration(preset,result);await saveLibraryDecoration({...preset,name:'二改新版'},result,id);expect((await readLibraryDecorations())).toHaveLength(1);
 expect(originLabel(await readDecorationOrigin(id))).toBe('二改');
});

it('leaves the old file and revision intact when saving the replacement fails',async()=>{
 const {DB}=await import('./db');
 const share={code:'S-AAAAAAAAAAAA',kind:'chat-decoration',revision:'old',metadata:{allowRemix:true,credit:'作者'}} as any;
 const id=await saveLibraryDecoration(preset,{kind:'imported',share});
 vi.mocked(DB.saveAssetBatch).mockRejectedValueOnce(Error('storage full'));
 await expect(replaceReceivedDecoration(id,{...preset,name:'新版'},{...share,revision:'new'},'old')).rejects.toThrow('storage full');
 expect((await readLibraryDecorations())[0].name).toBe('测试');expect((await readDecorationOrigin(id)).share?.revision).toBe('old');
});

it('preserves the outfit collection through editing and backup restore without exporting local metadata',async()=>{
 const id=await saveLibraryDecoration(preset,{kind:'self'},undefined,'outfit');
 await saveLibraryDecoration({...preset,name:'更新搭配'},{kind:'self'},id);
 const backup=assets.get(DECORATION_STORE)!;assets.delete(DECORATION_STORE);assets.set(DECORATION_STORE,backup);
 const list=await readLibraryDecorations();expect(list[0]).toMatchObject({_libraryId:id,_collection:'outfit',name:'更新搭配'});
 const {validateDecoration}=await import('./chatDecoration');expect(validateDecoration(list[0])).not.toHaveProperty('_collection');
});

it('imports a batch atomically and preserves each original attribution',async()=>{
 const {saveLibraryDecorationBatch}=await import('./decorationLibrary');const {DB}=await import('./db');
 const items=[{preset,origin:{kind:'self' as const}},{preset:{...preset,name:'外部'},origin:{kind:'imported' as const,allowRemix:false,credit:'作者'}}];
 vi.mocked(DB.saveAssetBatch).mockRejectedValueOnce(Error('full'));await expect(saveLibraryDecorationBatch(items)).rejects.toThrow('full');expect(await readLibraryDecorations()).toEqual([]);
 const saved=await saveLibraryDecorationBatch(items);expect(saved).toHaveLength(2);expect(await readDecorationOrigin(saved[1]._libraryId)).toMatchObject({credit:'作者',allowRemix:false});
});

it('still rejects invalid resource protocols instead of treating them as absent backup media', async () => {
 const {validateDecoration}=await import('./chatDecoration');
 expect(()=>validateDecoration({...preset,parts:{background:{image:'javascript:alert(1)',style:'plain'}}})).toThrow('资源不是');
 expect(()=>validateDecoration({...preset,parts:{sound:{src:'blobref:missing'}}})).toThrow('资源不是');
});
