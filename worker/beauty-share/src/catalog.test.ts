import {afterEach,describe,expect,it,vi} from 'vitest';
import type {DatabaseSync as SQLiteDatabase} from 'node:sqlite';
import {createRequire} from 'node:module';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
import {readFileSync} from 'node:fs';
import worker from './index';
import {dirtyCatalog,rebuildCatalog} from './catalog';
import {CatalogRefresh} from './catalogRefresh';
import {sha256} from './auth';
import type {Env,Statement} from './types';
import {parseBeautyCatalog} from '../../../utils/beautyCatalogContract';

const cover='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
const metadata={name:'月光',credit:'作者',platforms:['糯米机美化群'],contact:'',allowRemix:false,allowRedistribute:false,exportVersion:'test',bugFeedback:'welcome',message:'',allowPublicListing:true};
const pack={format:'sullyos-chat-decoration',version:1,name:'月光',parts:{css:'.sully-chat-root{color:red}'}};
const databases:SQLiteDatabase[]=[];
afterEach(()=>{databases.splice(0).forEach(db=>db.close());vi.restoreAllMocks();});
async function fixture(){
  const db=new DatabaseSync(':memory:');databases.push(db);
  for(const name of ['0001_initial','0002_private_repos','0003_public_catalog'])db.exec(readFileSync(new URL('../migrations/'+name+'.sql',import.meta.url),'utf8'));
  function statement(query:string):Statement{
    let args:any[]=[];
    return {bind(...values:unknown[]){args=values;return this;},async first<T>(){return db.prepare(query).get(...args) as T||null;},async all<T>(){return {results:db.prepare(query).all(...args) as T[]};},async run(){return {meta:{changes:Number(db.prepare(query).run(...args).changes)}};}};
  }
  const files=new Map<string,string>(),pub=new Map<string,{value:string|ArrayBuffer;options:any}>();
  const env:Env={DB:{prepare:statement,async batch(items){db.exec('BEGIN');try{const result=[];for(const item of items)result.push(await item.run());db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}},
    FILES:{async put(key,value){files.set(key,value);},async get(key){const text=files.get(key);return text===undefined?null:{body:new Response(text).body!,size:text.length};},async delete(key){files.delete(key);}},
    CATALOG:{async put(key,value,options){pub.set(key,{value,options});},async head(key){const item=pub.get(key);return item?{customMetadata:item.options?.customMetadata}:null;},async delete(key){pub.delete(key);},async list(){return {objects:[...pub.keys()].filter(k=>k.startsWith('items/')).map(key=>({key})),truncated:false};}},
    ASSETS:{fetch:async()=>new Response('')},AUTH_PEPPER:'test-only-not-a-production-secret'.repeat(2),UPLOADS_ENABLED:'true'};
  const jobData = new Map<string, unknown>(); let alarmAt: number | null = null;
  const storage = {async get<T>(key:string){return structuredClone(jobData.get(key)) as T|undefined;},async put(key:string,value:unknown){jobData.set(key,structuredClone(value));},async getAlarm(){return alarmAt;},async setAlarm(time:number){alarmAt=time;}};
  const refresh = new CatalogRefresh({storage},env);
  env.CATALOG_REFRESH = {idFromName:name=>name,get:()=>({fetch:request=>refresh.fetch(request)})};
  const fire = async()=>{alarmAt=null;await refresh.alarm();};
  const tokens={author:'a'.repeat(64),stranger:'b'.repeat(64),admin:'c'.repeat(64)};
  for(const [role,token] of Object.entries(tokens)){
    db.prepare('INSERT INTO authors VALUES(?,?,?,?)').run(role,role==='admin'?'admin':'author','unused',1);
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(await sha256(token),role,Date.now()+3600000);
  }
  async function api(path:string,who?:keyof typeof tokens,body?:unknown,method=body===undefined?'GET':'POST'){
    const response=await worker.fetch(new Request('https://test.invalid/api'+path,{method,headers:{'Content-Type':'application/json',...(who?{Authorization:'Bearer '+tokens[who]}:{})},body:body===undefined?undefined:JSON.stringify(body)}),env);
    const value=await response.json();return {status:response.status,value};
  }
  const submit=async(m=metadata,id?:string,expectedRevision?:string)=>{
    const result=await api('/submissions'+(id?'/'+id:''),'author',{metadata:m,package:pack,catalogCover:cover,expectedRevision});expect(result.status).toBe(201);return result.value;
  };
  const approve=async(revision:string)=>{expect((await api('/admin/revisions/'+revision+'/review','admin',{decision:'approved',note:''})).status).toBe(200);};
  const snapshot=()=>parseBeautyCatalog(JSON.parse(pub.get('catalog.json')!.value as string));
  return {db,env,files,pub,api,submit,approve,snapshot,fire,storage};
}
describe('公开装扮库：真实 SQL、审批和快照边界',()=>{
  it.each(['date','story'])('%s 自定义阅读 CSS 经投稿审核与目录导出完整保留',async part=>{
    const f=await fixture();
    const appearance={preset:'night',customCss:'.meeting-reading { --meeting-paper: #112233; }'};
    const response=await f.api('/submissions','author',{metadata,package:{...pack,parts:{[part]:{...appearance,messages:['PRIVATE']}}},catalogCover:cover});
    expect(response.status).toBe(201);
    await f.approve(response.value.revision);await f.fire();
    const entry=f.snapshot().entries[0];expect(entry.categories).toEqual([part]);
    expect(JSON.parse(f.pub.get(entry.file)!.value as string).parts).toEqual({[part]:appearance});
    expect((await f.api('/shares/'+entry.code)).status).toBe(200);
    const updated={...appearance,preset:'paper',customCss:'.meeting-reading { --meeting-paper: #ffeedd; }'};
    const next=await f.api('/submissions/'+response.value.id,'author',{metadata,package:{...pack,parts:{[part]:updated}},catalogCover:cover,expectedRevision:response.value.revision});
    expect(next.status).toBe(201);
    // Pending updates must not replace the version already available by code.
    expect((await f.api('/shares/'+entry.code+'/file?revision='+response.value.revision)).value.parts).toEqual({[part]:appearance});
    await f.approve(next.value.revision);await f.fire();
    const published=f.snapshot().entries[0];expect(published.code).toBe(entry.code);
    expect(JSON.parse(f.pub.get(published.file)!.value as string).parts).toEqual({[part]:updated});
    expect((await f.api('/shares/'+entry.code+'/file?revision='+next.value.revision)).value.parts).toEqual({[part]:updated});
  });
  it('协同工作投稿通过审核后进入独立分类，分享码只带外观',async()=>{
    const f=await fixture();
    const collaboration={uiTheme:'midnight',customCss:'.collab-ui-root { --collab-accent: pink; }',avatarMode:'both',avatarStyle:'circle'};
    const response=await f.api('/submissions','author',{metadata,package:{...pack,parts:{collaboration:{...collaboration,immersive:{apiKey:'PRIVATE'},messages:['PRIVATE']}}},catalogCover:cover});
    expect(response.status).toBe(201);
    await f.fire();expect(f.snapshot().entries).toHaveLength(0);
    await f.approve(response.value.revision);await f.fire();
    const entry=f.snapshot().entries[0];expect(entry.categories).toEqual(['collaboration']);
    expect(JSON.parse(f.pub.get(entry.file)!.value as string).parts).toEqual({collaboration});
    expect((await f.api('/shares/'+entry.code)).status).toBe(200);
  });
  it('允许第 200 份作品，拒绝第 201 份，删除后释放作者名额',async()=>{
    const f=await fixture();
    const first=await f.submit();
    const author=(f.db.prepare('SELECT author_code FROM submissions WHERE id=?').get(first.id) as any).author_code;
    const insert=f.db.prepare("INSERT INTO submissions(id,author_code,kind,created_at,updated_at) VALUES(?,?,'chat-decoration',0,0)");
    for(let i=1;i<199;i++)insert.run('quota-'+i,author);
    await f.submit();
    const blocked=await f.api('/submissions','author',{metadata,package:pack,catalogCover:cover});
    expect(blocked.status).toBe(429);expect(JSON.stringify(blocked.value)).toContain('200');
    f.db.prepare('UPDATE submissions SET deleted_at=1 WHERE id=?').run('quota-1');
    await f.submit();
  });
  it('目录发布后清理旧文件失败，重试仍移除已撤回的公开文件',async()=>{
    const f=await fixture(),one=await f.submit();await f.approve(one.revision);await f.fire();
    const entry=f.snapshot().entries[0];
    await f.api('/submissions/'+one.id+'/hide-catalog','author',{});
    vi.spyOn(f.env.CATALOG!,'delete').mockRejectedValueOnce(Error('temporary storage error'));
    await f.fire();expect(f.snapshot().entries).toHaveLength(0);
    expect(f.pub.has(entry.file)).toBe(true);expect(await f.storage.getAlarm()).not.toBeNull();
    await f.fire();expect(f.pub.has(entry.file)).toBe(false);expect(await f.storage.getAlarm()).toBeNull();
  });
  it('审核批次安排单次任务，完成后不再定时唤醒；删除和手动更新也触发',async()=>{
    const f=await fixture(),one=await f.submit(),two=await f.submit();
    expect(await f.storage.getAlarm()).toBeNull();
    await f.approve(one.revision);await f.approve(two.revision);
    expect(await f.storage.getAlarm()).not.toBeNull();expect(f.pub.has('catalog.json')).toBe(false);
    await f.fire();expect(f.snapshot().entries).toHaveLength(2);expect(await f.storage.getAlarm()).toBeNull();
    expect(f.pub.get('catalog.json')?.options.httpMetadata.cacheControl).toContain('must-revalidate');
    expect((await f.api('/admin/catalog')).status).toBe(401);
    expect((await f.api('/admin/catalog','author',{})).status).toBe(403);
    await f.api('/submissions/'+one.id,'author',undefined,'DELETE');await f.fire();
    expect(f.snapshot().entries).toHaveLength(1);
    expect((await f.api('/admin/catalog','admin',{})).status).toBe(200);await f.fire();
    expect((await f.api('/admin/catalog','admin')).value.pending).toBe(false);
  });
  it('失败保留旧快照并重试；准备后请求中断也会恢复，绑定故障不提交审批',async()=>{
    const f=await fixture(),one=await f.submit();await f.approve(one.revision);await f.fire();
    const previous=f.pub.get('catalog.json');await f.api('/admin/catalog','admin',{});
    vi.spyOn(f.env.FILES,'get').mockResolvedValueOnce(null);await f.fire();
    expect(f.pub.get('catalog.json')).toBe(previous);expect(await f.storage.getAlarm()).not.toBeNull();
    await f.fire();expect(await f.storage.getAlarm()).toBeNull();
    const second=await f.submit();const binding=f.env.CATALOG_REFRESH;f.env.CATALOG_REFRESH=undefined;
    expect((await f.api('/admin/revisions/'+second.revision+'/review','admin',{decision:'approved',note:''})).status).toBe(500);
    expect(f.db.prepare('SELECT status FROM revisions WHERE id=?').get(second.revision)?.status).toBe('pending');
    f.env.CATALOG_REFRESH=binding;
    const stub=binding!.get(binding!.idFromName('public-catalog'));
    await stub.fetch(new Request('https://internal/job',{method:'POST',body:JSON.stringify({action:'prepare',ticket:crypto.randomUUID()})}));
    await dirtyCatalog(f.env).run();await f.fire();expect(await f.storage.getAlarm()).not.toBeNull();
    const realNow=Date.now();vi.spyOn(Date,'now').mockReturnValue(realNow+121000);
    await f.fire();expect(await f.storage.getAlarm()).toBeNull();
  });
  it('修改协议期间取消公开，过时请求不能恢复公开授权',async()=>{
    const f=await fixture(),work=await f.submit();await f.approve(work.revision);
    const get=f.env.FILES.get;
    vi.spyOn(f.env.FILES,'get').mockImplementationOnce(async key=>{await f.api('/submissions/'+work.id+'/hide-catalog','author',{});return get(key);});
    expect((await f.api('/submissions/'+work.id+'/terms','author',{expectedRevision:work.revision,terms:{allowRemix:true}})).status).toBe(409);
    await rebuildCatalog(f.env);expect(f.snapshot().entries).toHaveLength(0);
  });
  it('修改协议沿用已审核文件，权限通过后才生效，原分享码不变',async()=>{
    const f=await fixture(),work=await f.submit();await f.approve(work.revision);await rebuildCatalog(f.env);
    const entry=f.snapshot().entries[0],path='/submissions/'+work.id+'/terms';
    const body={expectedRevision:work.revision,terms:{allowRemix:true,allowRedistribute:true}};
    expect((await f.api(path,'stranger',body)).status).toBe(404);
    expect((await f.api(path,'author',{...body,terms:{allowPublicListing:true}})).status).toBe(400);
    expect((await f.api(path,'author',{...body,terms:{allowRemix:'yes'}})).status).toBe(400);
    const update=await f.api(path,'author',body);expect(update.status).toBe(201);
    expect((await f.api('/shares/'+entry.code)).value.metadata.allowRemix).toBe(false);
    expect((await f.api(path,'author',body)).status).toBe(409);
    await f.approve(update.value.revision);await rebuildCatalog(f.env);
    const next=f.snapshot().entries[0];expect(next.code).toBe(entry.code);expect(next.metadata.allowRemix).toBe(true);expect(next.sha256).toBe(entry.sha256);
    expect(f.pub.get(next.file)?.value).toBe(JSON.stringify(pack));
    expect((await f.api(path,'author',{...body,expectedRevision:next.revision})).value.unchanged).toBe(true);
  });
  it('协议更新不能把退回文件重新发布，隐藏作品也不会借改协议恢复公开',async()=>{
    const f=await fixture(),work=await f.submit();await f.approve(work.revision);
    const rejected=await f.submit({...metadata,name:'被退回的文件'},work.id,work.revision);
    await f.api('/admin/revisions/'+rejected.revision+'/review','admin',{decision:'rejected',note:'文件需要修复'});
    const blob=f.db.prepare('SELECT blob_key FROM revisions WHERE id=?').get(rejected.revision) as any;
    f.files.set(blob.blob_key,JSON.stringify({...pack,name:'不允许发布的文件'}));
    await f.api('/submissions/'+work.id+'/hide-catalog','author',{});
    const update=await f.api('/submissions/'+work.id+'/terms','author',{expectedRevision:rejected.revision,terms:{allowRemix:true}});
    expect(update.status).toBe(201);await f.approve(update.value.revision);await rebuildCatalog(f.env);
    expect(f.snapshot().entries).toHaveLength(0);
    const row=f.db.prepare('SELECT blob_key,metadata FROM revisions WHERE id=?').get(update.value.revision) as any;
    expect(f.files.get(row.blob_key)).toBe(JSON.stringify(pack));expect(JSON.parse(row.metadata).allowPublicListing).toBe(false);
  });
  it('旧投稿与待审文件不公开，仅发布明确同意且已审核的版本',async()=>{
    const f=await fixture();
    const legacy={...metadata};delete (legacy as any).allowPublicListing;
    const old=await f.submit(legacy);await f.approve(old.revision);
    const work=await f.submit();await rebuildCatalog(f.env);expect(f.snapshot().entries).toHaveLength(0);
    await f.approve(work.revision);await rebuildCatalog(f.env);
    const entry=f.snapshot().entries[0];expect(entry.revision).toBe(work.revision);expect(entry.categories).toEqual(['chat','whitebox']);
    expect(f.pub.get(entry.file)?.value).toBe(JSON.stringify(pack));expect(f.pub.has(entry.cover)).toBe(true);
    expect(JSON.stringify(f.snapshot())).not.toMatch(/author_code|blob_key|packages\//);
    const next=await f.submit({...metadata,name:'更新待审'},work.id,work.revision);
    await rebuildCatalog(f.env);expect(f.snapshot().entries[0].revision).toBe(work.revision);
    await f.approve(next.revision);await rebuildCatalog(f.env);expect(f.snapshot().entries[0].revision).toBe(next.revision);expect(f.pub.has(entry.file)).toBe(false);
  });
  it('取消公开受所有权保护，待审版不能在后来通过时重新暴露，凭码领取仍可用',async()=>{
    const f=await fixture(),work=await f.submit();await f.approve(work.revision);await rebuildCatalog(f.env);
    const entry=f.snapshot().entries[0],next=await f.submit(metadata,work.id,work.revision);
    expect((await f.api('/submissions/'+work.id+'/hide-catalog','stranger',{})).status).toBe(404);
    expect((await f.api('/submissions/'+work.id+'/hide-catalog','author',{})).status).toBe(200);
    await f.approve(next.revision);await rebuildCatalog(f.env);
    expect(f.snapshot().entries).toHaveLength(0);expect(f.pub.has(entry.file)).toBe(false);
    expect((await f.api('/shares/'+entry.code)).status).toBe(200);
    // Only a fresh, explicit, reviewed opt-in may publish again.
    const rejoin=await f.submit(metadata,work.id,next.revision);await f.approve(rejoin.revision);await rebuildCatalog(f.env);expect(f.snapshot().entries).toHaveLength(1);
  });
  it('删除立即撤销领取，随后快照移除公开副本；审核封面只有管理员可读',async()=>{
    const f=await fixture(),work=await f.submit();
    const coverURL='https://test.invalid/api/revisions/'+work.revision+'/cover';
    expect((await worker.fetch(new Request(coverURL),f.env)).status).toBe(401);
    expect((await worker.fetch(new Request(coverURL,{headers:{Authorization:'Bearer '+'a'.repeat(64)}}),f.env)).status).toBe(403);
    const preview=await worker.fetch(new Request(coverURL,{headers:{Authorization:'Bearer '+'c'.repeat(64)}}),f.env);expect(preview.status).toBe(200);expect(preview.headers.get('Content-Type')).toBe('image/png');
    await f.approve(work.revision);await rebuildCatalog(f.env);const entry=f.snapshot().entries[0];
    expect((await f.api('/submissions/'+work.id,'author',undefined,'DELETE')).status).toBe(200);
    expect((await f.api('/shares/'+entry.code)).status).toBe(404);
    await rebuildCatalog(f.env);expect(f.snapshot().entries).toHaveLength(0);expect(f.pub.has(entry.file)).toBe(false);
  });
  it('数据未变化时不重建；生成失败不替换上一份目录，并释放锁以便重试',async()=>{
    const f=await fixture(),work=await f.submit();await f.approve(work.revision);await rebuildCatalog(f.env);
    const read=vi.spyOn(f.env.FILES,'get');await rebuildCatalog(f.env);expect(read).not.toHaveBeenCalled();
    const previous=f.pub.get('catalog.json');await dirtyCatalog(f.env).run();read.mockResolvedValueOnce(null);
    await expect(rebuildCatalog(f.env)).rejects.toThrow('source missing');expect(f.pub.get('catalog.json')).toBe(previous);
    await rebuildCatalog(f.env);expect(f.pub.get('catalog.json')).not.toBe(previous);
  });
  it('生成中撤回时丢弃过时目录，下一次生成移除条目',async()=>{
    const f=await fixture(),work=await f.submit();await f.approve(work.revision);await rebuildCatalog(f.env);await dirtyCatalog(f.env).run();
    const previous=f.pub.get('catalog.json'),get=f.env.FILES.get;
    vi.spyOn(f.env.FILES,'get').mockImplementationOnce(async key=>{await f.api('/submissions/'+work.id+'/hide-catalog','author',{});return get(key);});
    await rebuildCatalog(f.env);expect(f.pub.get('catalog.json')).toBe(previous);
    await rebuildCatalog(f.env);expect(f.snapshot().entries).toHaveLength(0);
  });
  it('公开投稿必须有合法封面；关闭公开仍能沿用原分享码流程',async()=>{
    const f=await fixture();
    expect((await f.api('/submissions','author',{metadata,package:pack})).status).toBe(400);
    expect((await f.api('/submissions','author',{metadata,package:pack,catalogCover:'data:image/svg+xml,<svg/>'})).status).toBe(400);
    f.env.CATALOG=undefined;
    expect((await f.api('/submissions','author',{metadata,package:pack,catalogCover:cover})).status).toBe(503);
    expect((await f.api('/submissions','author',{metadata:{...metadata,allowPublicListing:false},package:pack})).status).toBe(201);
  });
});
