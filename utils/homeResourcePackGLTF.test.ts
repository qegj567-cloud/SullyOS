import {it,expect,vi,afterEach} from 'vitest';
const {read,parse}=vi.hoisted(()=>({read:vi.fn(),parse:vi.fn()}));
vi.mock('../apps/room3d/resourcePacks',()=>({readPackAsset:read,resourcePath:(url:string)=>new URL(url).pathname.slice(1)}));
vi.mock('three/addons/loaders/GLTFLoader.js',()=>({GLTFLoader:class{constructor(private manager:any){}setMeshoptDecoder(){return this;}parseAsync(bytes:ArrayBuffer,base:string){return parse(bytes,base,this.manager);}}}));
import {loadHomeGLTF} from '../apps/room3d/resourcePackGLTF';
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();vi.clearAllMocks();});
it('resolves external textures from the same local generation with no network and releases temporary URLs',async()=>{
 vi.stubGlobal('location',{href:'https://example.test/'});const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 read.mockResolvedValue({blob:new Blob(['model']),revision:'v1',dependencies:new Map([['room3d/wardrobe/texture.jpg',new Blob(['texture'])]])});
 const create=vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:local-texture'),revoke=vi.spyOn(URL,'revokeObjectURL');
 parse.mockImplementation(async(bytes,base,manager)=>{expect(new TextDecoder().decode(bytes)).toBe('model');expect(manager.resolveURL(`${base}texture.jpg`)).toBe('blob:local-texture');return {scene:'loaded'};});
 expect(await loadHomeGLTF('https://example.test/room3d/wardrobe/model.glb')).toEqual({scene:'loaded'});
 expect(fetch).not.toHaveBeenCalled();expect(create).toHaveBeenCalledTimes(1);expect(revoke).toHaveBeenCalledWith('blob:local-texture');
});
it('releases local texture URLs even if GLTF decoding fails',async()=>{
 vi.stubGlobal('location',{href:'https://example.test/'});
 read.mockResolvedValue({blob:new Blob(['bad']),dependencies:new Map([['room3d/wardrobe/texture.jpg',new Blob(['texture'])]])});
 vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:failed');const revoke=vi.spyOn(URL,'revokeObjectURL');parse.mockRejectedValue(new Error('decode'));
 await expect(loadHomeGLTF('https://example.test/room3d/wardrobe/model.glb')).rejects.toThrow('decode');expect(revoke).toHaveBeenCalledWith('blob:failed');
});
