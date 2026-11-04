import {afterEach,expect,it,vi} from 'vitest';
import {IDBFactory} from 'fake-indexeddb';

afterEach(()=>vi.unstubAllGlobals());

async function seedLegacy(factory:IDBFactory,version:number){
 await new Promise<void>((resolve,reject)=>{
  const req=factory.open('AetherOS_Data',version);
  req.onupgradeneeded=()=>{
   const messages=req.result.createObjectStore('messages',{keyPath:'id',autoIncrement:true});
   messages.createIndex('charId','charId');
   messages.createIndex('timestamp','timestamp');
   if(version===72)messages.createIndex('charId_deliveryId',['charId','metadata.deliveryId']);
   else {
    messages.createIndex('charId_source',['charId','metadata.source']);
    messages.createIndex('charId_homeTurn',['charId','metadata.homeTurnId']);
   }
   messages.put({id:1,charId:'c',role:'user',type:'text',content:'保留原来的聊天',timestamp:10});
   messages.put({id:2,charId:'c',role:'user',type:'text',content:'保留原来的家园',timestamp:5,metadata:{source:'home',homeTurnId:'turn'}});
   req.result.createObjectStore('characters',{keyPath:'id'}).put({id:'c',name:'旧角色'});
   req.result.createObjectStore('assets',{keyPath:'id'}).put({id:'old-wallpaper',data:'原图片'});
  };
  req.onsuccess=()=>{req.result.close();resolve();};req.onerror=()=>reject(req.error);
 });
}

it.each([72,73])('upgrades v%s without losing records and installs both branches of message indexes',async version=>{
 vi.resetModules();
 const factory=new IDBFactory();vi.stubGlobal('indexedDB',factory);
 await seedLegacy(factory,version);
 const {openDB,DB}=await import('./db');const db=await openDB();
 try {
  expect(db.version).toBe(74);
  const names=Array.from(db.transaction('messages').objectStore('messages').indexNames);
  expect(names).toEqual(expect.arrayContaining(['charId_source','charId_homeTurn','charId_deliveryId']));
  expect((await DB.getMessagesByCharId('c',true)).map(m=>m.content)).toEqual(['保留原来的聊天','保留原来的家园']);
  const message={charId:'c',role:'assistant',type:'text',content:'只收一次',timestamp:20} as const;
  const first=await DB.saveMessageOnce('delivery',message);
  expect(await DB.saveMessageOnce('delivery',message)).toBe(first);
  expect(await DB.getMessagesByCharId('c',true)).toHaveLength(3);
  expect((await DB.getAllCharacters())[0].name).toBe('旧角色');
  expect(await DB.getAsset('old-wallpaper')).toBe('原图片');
 } finally {db.close();}
});

it('rolls back an interrupted v72 home-index upgrade, preserves the archive and retries once',async()=>{
 vi.resetModules();
 localStorage.removeItem('sully_db_open_diagnostics_v1');
 const diagnosticKeys=Array.from({length:localStorage.length},(_,i)=>localStorage.key(i)!)
  .filter(key=>key.startsWith('sully_db_open_diagnostics_v2_')||key.startsWith('sully_db_open_checkpoint_v2_'));
 for(const key of diagnosticKeys)localStorage.removeItem(key);
 const factory=new IDBFactory();vi.stubGlobal('indexedDB',factory);
 await seedLegacy(factory,72);
 const originalOpen=factory.open.bind(factory);
 const open=vi.spyOn(factory,'open').mockImplementationOnce((...args:Parameters<IDBFactory['open']>)=>{
  const request=originalOpen(...args);
  request.addEventListener('upgradeneeded',()=>queueMicrotask(()=>request.transaction!.abort()));
  return request;
 });
 const {openDB,DB}=await import('./db');
 try {await expect(openDB()).rejects.toMatchObject({name:'AbortError'});}
 finally {open.mockRestore();}
 const old=await new Promise<IDBDatabase>((resolve,reject)=>{
  const request=factory.open('AetherOS_Data');
  request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
 });
 try {
  expect(old.version).toBe(72);
  const messages=old.transaction('messages').objectStore('messages');
  expect(Array.from(messages.indexNames)).not.toContain('charId_source');
  expect(Array.from(messages.indexNames)).not.toContain('charId_homeTurn');
  const request=messages.getAll();
  const rows=await new Promise<any[]>((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  expect(rows.map(row=>[row.id,row.content])).toEqual([[1,'保留原来的聊天'],[2,'保留原来的家园']]);
 } finally {old.close();}
 const {databaseOpenDiagnostic}=await import('./databaseOpenDiagnostics');
 expect(databaseOpenDiagnostic()).toContain('upgrade-aborted');
 expect(databaseOpenDiagnostic()).not.toContain('upgrade-committed');
 const retried=await openDB();
 try {
  expect(retried.version).toBe(74);
  expect((await DB.getAllCharacters())[0].name).toBe('旧角色');
  expect(await DB.getAsset('old-wallpaper')).toBe('原图片');
  expect((await DB.getMessagesByCharId('c',true)).map(row=>row.id)).toEqual([1,2]);
  expect(databaseOpenDiagnostic()).toContain('upgrade-committed');
 } finally {retried.close();}
});
