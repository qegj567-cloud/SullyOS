import json,struct,io,pathlib,hashlib
from PIL import Image
base=pathlib.Path('art/halloween-2026/meshy');out=base/'furniture-textured-runtime';out.mkdir(exist_ok=True)
catalog=json.loads((base/'furniture-texture-inputs/catalog.json').read_text(encoding='utf8'));report=[]
for batchno in (12,13,14):
 batch=json.loads((base/f'batch-{batchno}-furniture-texture.json').read_text())
 for job in batch['jobs']:
  src=base/batch['id']/(job['id']+'.glb')
  if not src.exists():continue
  asset=next(a for a in catalog if job['model'].endswith(a['url']));raw=src.read_bytes();jl=struct.unpack_from('<I',raw,12)[0];g=json.loads(raw[20:20+jl]);binary=raw[28+jl:]
  assert len(g['buffers'])==1
  for n in g['nodes']:
   assert n.get('matrix',[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1])==[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]
   assert not any(k in n for k in ('rotation','scale','translation'))
  ps=[p for m in g['meshes'] for p in m['primitives']];tri=sum(g['accessors'][p['indices']]['count']//3 for p in ps);assert tri<=8000
  acc=[g['accessors'][p['attributes']['POSITION']] for p in ps];lo=[min(a['min'][k] for a in acc) for k in range(3)];hi=[max(a['max'][k] for a in acc) for k in range(3)];scale=[asset['size'][k]/(hi[k]-lo[k]) for k in range(3)];assert max(scale)/min(scale)<1.12,(asset['id'],scale)
  scale=[scale[0]]*3;extent=[(hi[k]-lo[k])*scale[k] for k in range(3)]
  roots=g['scenes'][g.get('scene',0)]['nodes'];g['nodes'].append({'name':'furniture-fit','children':roots,'scale':scale,'translation':[-(lo[0]+hi[0])/2*scale[0],-lo[1]*scale[1],-(lo[2]+hi[2])/2*scale[2]]});g['scenes'][g.get('scene',0)]['nodes']=[len(g['nodes'])-1]
  baseimages={g['textures'][m['pbrMetallicRoughness']['baseColorTexture']['index']]['source'] for m in g['materials']}
  replacement={};sizes=[]
  for i,img in enumerate(g['images']):
   view=g['bufferViews'][img['bufferView']];start=view.get('byteOffset',0);im=Image.open(io.BytesIO(binary[start:start+view['byteLength']])).convert('RGB');size=1024 if i in baseimages else 512;im.thumbnail((size,size),Image.Resampling.LANCZOS);buf=io.BytesIO();im.save(buf,format='WEBP',quality=90,method=6);replacement[img['bufferView']]=buf.getvalue();img['mimeType']='image/webp';sizes.append(list(im.size))
  for texture in g['textures']:
   texture.setdefault('extensions',{})['EXT_texture_webp']={'source':texture.pop('source')}
  for key in ('extensionsUsed','extensionsRequired'):
   if 'EXT_texture_webp' not in g.setdefault(key,[]):g[key].append('EXT_texture_webp')
  chunks=[];offset=0
  for i,v in enumerate(g['bufferViews']):
   start=v.get('byteOffset',0);data=replacement.get(i,binary[start:start+v['byteLength']]);v['byteOffset']=offset;v['byteLength']=len(data);data+=b'\0'*((-len(data))%4);chunks.append(data);offset+=len(data)
  blob=b''.join(chunks);g['buffers'][0]['byteLength']=len(blob)
  for i,m in enumerate(g['materials']):
   m['name']=f'halloween_texture_{i}';m['pbrMetallicRoughness']['baseColorFactor']=[1,1,1,1];m['normalTexture']['scale']=.65
  for s in g.get('samplers',[]):s.update({'minFilter':9729,'magFilter':9729})
  text=json.dumps(g,separators=(',',':')).encode();text+=b' '*((-len(text))%4);packed=struct.pack('<III',0x46546c67,2,28+len(text)+len(blob))+struct.pack('<II',len(text),0x4e4f534a)+text+struct.pack('<II',len(blob),0x004e4942)+blob
  (out/asset['url']).write_bytes(packed);entry={**asset,'size':extent,'boxes':([] if asset['surface']=='rug' else [[-extent[0]/2,0,-extent[2]/2,extent[0]/2,extent[1],extent[2]/2]]),'revision':hashlib.sha256(packed).hexdigest()[:12],'textureSource':'meshy-reference','materialStyle':'pbr','paintMaterials':[m['name'] for m in g['materials']],'colorParts':[{'material':m['name'],'label':'贴图整体色调','color':'#ffffff'} for m in g['materials']]};report.append({'entry':entry,'triangles':tri,'bytes':len(packed),'textureSizes':sizes,'source':str(src).replace('\\','/')});print(asset['id'],tri,len(packed))
(base/'furniture-texture-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
