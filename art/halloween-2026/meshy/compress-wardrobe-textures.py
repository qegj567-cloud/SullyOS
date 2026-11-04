import pathlib,json,struct,io,shutil,sys
from PIL import Image
base=pathlib.Path('art/halloween-2026/meshy');master=base/'wardrobe-size-masters';stage=base/'wardrobe-texture-small';master.mkdir(exist_ok=True);stage.mkdir(exist_ok=True)
assets=sorted({entry['asset'] for entry in json.loads((base/'wardrobe-source-manifest.json').read_text(encoding='utf-8'))})
for asset in assets:
 f=pathlib.Path('public/room3d/wardrobe')/asset
 original=master/f.name
 if not original.exists() or '--refresh-masters' in sys.argv:shutil.copyfile(f,original)
 b=original.read_bytes();n=struct.unpack_from('<I',b,12)[0];j=json.loads(b[20:20+n]);bin=b[28+n:];replace={}
 for image in j.get('images',[]):
  v=j['bufferViews'][image['bufferView']];raw=bin[v.get('byteOffset',0):v.get('byteOffset',0)+v['byteLength']];im=Image.open(io.BytesIO(raw))
  if max(im.size)<=1024:continue
  im=im.convert('RGB');im.thumbnail((1024,1024),Image.Resampling.LANCZOS);out=io.BytesIO();im.save(out,format='JPEG',quality=88,subsampling=0,optimize=True);replace[image['bufferView']]=out.getvalue();image['mimeType']='image/jpeg'
 chunks=[];offset=0
 for k,v in enumerate(j['bufferViews']):
  raw=replace.get(k,bin[v.get('byteOffset',0):v.get('byteOffset',0)+v['byteLength']]);v['byteOffset']=offset;v['byteLength']=len(raw);raw+=b'\0'*((-len(raw))%4);chunks.append(raw);offset+=len(raw)
 blob=b''.join(chunks);j['buffers'][0]['byteLength']=len(blob);s=json.dumps(j,separators=(',',':')).encode();s+=b' '*((-len(s))%4);out=struct.pack('<III',0x46546c67,2,28+len(s)+len(blob))+struct.pack('<II',len(s),0x4e4f534a)+s+struct.pack('<II',len(blob),0x004e4942)+blob;(stage/f.name).write_bytes(out);print(f.name,len(b),len(out))
