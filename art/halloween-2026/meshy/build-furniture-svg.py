import pathlib,json,struct,io,sys,re,hashlib,time,html
from PIL import Image
sys.path.insert(0,'tmp/halloween-svg-tools');import vtracer
base=pathlib.Path('art/halloween-2026/meshy');out=base/'furniture-svg';out.mkdir(exist_ok=True);report=[]
for r in json.loads((base/'furniture-texture-report.json').read_text(encoding='utf8')):
 a=r['entry'];b=(base/'furniture-textured-runtime'/a['url']).read_bytes();n=struct.unpack_from('<I',b,12)[0];j=json.loads(b[20:20+n]);images={j['textures'][m['pbrMetallicRoughness']['baseColorTexture']['index']]['source'] for m in j['materials']};assert len(images)==1
 index=images.pop();v=j['bufferViews'][j['images'][index]['bufferView']];pixels=b[28+n+v.get('byteOffset',0):28+n+v.get('byteOffset',0)+v['byteLength']];im=Image.open(io.BytesIO(pixels));png=out/(a['id']+'-reference.png');im.save(png);svg=out/(a['id']+'.svg')
 if a['id']=='halloween_bat_sofa':svg.write_text((out/'sofa-prototype.svg').read_text(),encoding='utf8')
 else:vtracer.convert_image_to_svg_py(str(png),str(svg),colormode='color',hierarchical='stacked',mode='spline',filter_speckle=2,color_precision=7,layer_difference=12,corner_threshold=60,length_threshold=3.5,max_iterations=10,splice_threshold=45,path_precision=2)
 s=svg.read_text();k=[0]
 def tag(m):
  k[0]+=1;return '<path id="region-%05d"'%k[0]
 s=re.sub(r'<path',tag,s);s=s.replace('<svg ','<svg viewBox="0 0 %d %d" '%im.size,1);at=s.index('>',s.index('<svg'))+1;s=s[:at]+'\n<title>'+html.escape(a['name'])+' · UV 颜色图</title>\n<desc>Vector path tracing of the approved Meshy color atlas. No embedded raster. PBR normal and roughness maps are retained separately.</desc>\n'+s[at:];svg.write_text(s,encoding='utf8');assert '<image' not in s and 'data:image' not in s
 report.append({'id':a['id'],'svg':svg.name,'sourceSha256':hashlib.sha256(pixels).hexdigest(),'paths':k[0],'bytes':svg.stat().st_size,'size':list(im.size)});print(a['id'],k[0],svg.stat().st_size,flush=True)
(out/'manifest.json').write_text(json.dumps({'generator':'VTracer 0.6.15; spline paths; editable region IDs','assets':report},ensure_ascii=False,indent=2),encoding='utf8')
