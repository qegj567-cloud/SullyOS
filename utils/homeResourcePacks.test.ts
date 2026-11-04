import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resourcePacks,downloadResourcePack,pauseResourcePack,removeResourcePack,readPackAsset,resourcePackStatus,RESOURCE_PACK_DB,type ResourcePack,type PackFile} from '../apps/room3d/resourcePacks';
import {createHomeResourceManifest} from '../scripts/home-resource-packs.mjs';

function file(path:string,body:string,dependencies:string[]=[]):PackFile{return {path,bytes:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex'),dependencies};}
const modelPath='room3d/wardrobe/halloween-witch-dress.glb',texturePath='room3d/wardrobe/halloween-texture-efdfbe3287c0.jpg';
function pack(version='old'):ResourcePack{return {id:'halloween-wardrobe',name:'test',description:'',revision:version,bytes:version.length*2,files:[file(modelPath,version,[texturePath]),file(texturePath,version.toUpperCase())]};}
const response=(url:string,version='old')=>new Response(url.includes('.jpg')?version.toUpperCase():version);
const address=(path:string)=>`https://local.invalid/${path}?v=ignored`;
beforeEach(async()=>{await Promise.all(resourcePacks.map(p=>removeResourcePack(p.id)));});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
describe('optional home resource packs',()=>{
 it('publishes exact hashes, sizes and all GLB dependencies, including subpath-safe relative URLs',()=>{
  expect(createHomeResourceManifest()).toEqual(resourcePacks);
  for(const pack of resourcePacks){
   const paths=new Set(pack.files.map(f=>f.path));
   for(const f of pack.files){expect(readFileSync(`public/${f.path}`).length).toBe(f.bytes);for(const dep of f.dependencies)expect(paths.has(dep)).toBe(true);}
  }
  expect(resourcePacks.find(p=>p.id==='halloween-wardrobe')!.files.filter(f=>f.path.endsWith('.jpg'))).toHaveLength(8);
 });
 it('downloads bytes only, reads model + textures from IndexedDB offline after a fresh module load',async()=>{
  const fetch=vi.fn(async(url:string)=>response(url));vi.stubGlobal('fetch',fetch);
  await downloadResourcePack(pack());expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls.every((call:any)=>call[1].cache==='no-store')).toBe(true);
  expect(await resourcePackStatus(pack())).toMatchObject({installed:true,savedBytes:6});
  vi.resetModules();const fresh=await import('../apps/room3d/resourcePacks');
  fetch.mockImplementation(async()=>{throw Error('offline');});
  const local=await fresh.readPackAsset(address(modelPath));
  expect(await local!.blob.text()).toBe('old');expect(await local!.dependencies.get(texturePath)!.text()).toBe('OLD');
  expect(fetch).toHaveBeenCalledTimes(2);
 });
 it('keeps completed files after failure and retries only missing files without activating a partial pack',async()=>{
  const fetch=vi.fn(async(url:string)=>url.includes('.jpg')?new Response('',{status:503}):new Response('old'));vi.stubGlobal('fetch',fetch);
  await expect(downloadResourcePack(pack())).rejects.toThrow('503');
  expect(await readPackAsset(address(modelPath))).toBeUndefined();
  expect(await resourcePackStatus(pack())).toMatchObject({installed:false,savedBytes:3});
  fetch.mockClear();fetch.mockImplementation(async(url:string)=>response(url));
  await downloadResourcePack(pack());expect(fetch).toHaveBeenCalledTimes(1);expect(fetch.mock.calls[0][0]).toContain('.jpg');
 });
 it('continues to use the complete old generation when an update fails, then switches model and texture together',async()=>{
  const fetch=vi.fn(async(url:string)=>response(url));vi.stubGlobal('fetch',fetch);await downloadResourcePack(pack());
  fetch.mockImplementation(async()=>new Response('bad'));
  await expect(downloadResourcePack(pack('new'))).rejects.toThrow('校验');
  let local=await readPackAsset(address(modelPath));expect(await local!.blob.text()).toBe('old');expect(await local!.dependencies.get(texturePath)!.text()).toBe('OLD');
  expect(await resourcePackStatus(pack('new'))).toMatchObject({installed:true,update:true});
  fetch.mockImplementation(async(url:string)=>response(url,'new'));await downloadResourcePack(pack('new'));
  local=await readPackAsset(address(modelPath));expect(await local!.blob.text()).toBe('new');expect(await local!.dependencies.get(texturePath)!.text()).toBe('NEW');
 });
 it('pauses and resumes without redownloading the completed file',async()=>{
  const fetch=vi.fn(async(_url:string,{signal}:RequestInit)=>new Promise<Response>((resolve,reject)=>{
   if(_url.includes('.glb'))resolve(new Response('old'));
   else signal!.addEventListener('abort',()=>reject(new DOMException('paused','AbortError')),{once:true});
  }));vi.stubGlobal('fetch',fetch);
  await expect(downloadResourcePack(pack(),bytes=>{if(bytes===3)pauseResourcePack(pack().id);})).rejects.toMatchObject({name:'AbortError'});
  expect(await resourcePackStatus(pack())).toMatchObject({savedBytes:3,installed:false});
  fetch.mockClear();fetch.mockImplementation(async(url:string)=>response(url));
  await downloadResourcePack(pack());expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('exports layout and outfit parameters without pack bytes, and deletion leaves the saved character intact',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>response(url)));await downloadResourcePack(pack());
  const {DB,openDB}=await import('./db');
  const character={id:'resource-pack-owner',name:'test',home3D:{rooms:[{id:'room',items:[{assetId:'halloween_bat_sofa',x:2}]}]},chibiStudio:{home3D:{hair:{wardrobe:{onepiece:'halloween-witch-dress'},wardrobeColors:{'halloween-witch-dress':{orange:'#123456'}}}}}};
  const db=await openDB();await new Promise<void>((resolve,reject)=>{const tx=db.transaction('characters','readwrite');tx.objectStore('characters').put(character);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});
  const before=await DB.exportFullData();expect(before.characters!.find(c=>c.id===character.id)).toMatchObject(character);
  expect(JSON.stringify(before)).not.toContain(RESOURCE_PACK_DB);expect(JSON.stringify(before)).not.toContain(pack().files[0].sha256);
  await removeResourcePack(pack().id);
  expect(await resourcePackStatus(pack())).toMatchObject({installed:false,savedBytes:0});expect(await readPackAsset(address(modelPath))).toBeUndefined();
  const after=await DB.exportFullData();expect(after.characters!.find(c=>c.id===character.id)).toMatchObject(character);
  expect([...db.objectStoreNames]).not.toContain('packs');
 });
 it('does not fetch or open the resource database for ordinary assets',async()=>{
  const fetch=vi.fn(),open=vi.spyOn(indexedDB,'open');vi.stubGlobal('fetch',fetch);
  expect(await readPackAsset(address('room3d/kit.glb'))).toBeUndefined();expect(fetch).not.toHaveBeenCalled();expect(open).not.toHaveBeenCalled();
 });
 it('repairs a missing installed texture without downloading healthy files',async()=>{
  const fetch=vi.fn(async(url:string)=>response(url));vi.stubGlobal('fetch',fetch);await downloadResourcePack(pack());
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open(RESOURCE_PACK_DB);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  await new Promise<void>((resolve,reject)=>{const tx=db.transaction('files','readwrite');tx.objectStore('files').delete(`${pack().id}/${pack().files[1].sha256}`);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});db.close();
  fetch.mockClear();expect(await resourcePackStatus(pack())).toMatchObject({installed:false,savedBytes:3});
  await expect(readPackAsset(address(modelPath))).rejects.toThrow('补齐');expect(fetch).not.toHaveBeenCalled();
  await downloadResourcePack(pack());expect(fetch).toHaveBeenCalledTimes(1);expect(await resourcePackStatus(pack())).toMatchObject({installed:true});
 });
 it('deleting an in-flight download prevents late responses from recreating the pack',async()=>{
  let started=0,ready!:()=>void;const pending=new Promise<void>(resolve=>{ready=resolve;});
  vi.stubGlobal('fetch',vi.fn(async(_url:string,{signal}:RequestInit)=>new Promise<Response>((_resolve,reject)=>{signal!.addEventListener('abort',()=>reject(new DOMException('paused','AbortError')),{once:true});if(++started===2)ready();})));
  const task=downloadResourcePack(pack()).catch(error=>error);await pending;await removeResourcePack(pack().id);
  expect(await task).toMatchObject({name:'AbortError'});expect(await resourcePackStatus(pack())).toMatchObject({installed:false,savedBytes:0});
 });
});
