import {bindBlankBody} from './blankRig';
import {createBlankMotion} from './blankMotion';
import {mirrorFrame} from '../mirrorMotion.js';
import {createBlankBody,BLANK_HAIR_Y_SCALE,BLANK_HAIR_PIVOT,BLANK_HAIR_Z_SCALE,BLANK_HEAD_SCALE,fitBlankHeadY} from './blankBody';
import {eatingHand} from '../diningMotion.js';
import {rhythmFrame} from '../rhythm.js';
import type {ActivityPose} from './types';
import * as T from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import type { Parts, Motion, Posture } from './types';
import {defaultHairLayer,hairMode,bodyProportions,type HairSettings} from './types';
import { clothingCanvas,composeGarments } from './partSurfaces';
import referenceUrl from './reference.fbx?url';
import {hairContours,createHairShell} from './hairShell';
import {createHairSeam} from './hairSeam';
import {createRearHairLiner,simplifyLinerContours} from './rearHairLiner';
import {cleanFace,loadFaceImages,composeFace,type FaceSettings} from './faceAppearance';

const contourCache=new WeakMap<HTMLImageElement,ReturnType<typeof hairContours>>();
const hairColorCache=new WeakMap<HTMLImageElement,WeakMap<HTMLImageElement,(x:number,y:number)=>T.Color>>();

export async function loadBody() { return new FBXLoader().loadAsync(referenceUrl); }

export function buildBody(source: T.Group, parts: Parts, appearance: 'skin' | 'hair' | 'outfit', hair?:HairSettings) {
    const blank=hair?.bodyShape==='blank';
    const headDepth=.82;
    const resources: Array<{ dispose(): void }> = [];
    const keep = <V extends { dispose(): void }>(v: V): V => { resources.push(v); return v; };
    const average = (img: HTMLImageElement) => {
        const c = document.createElement('canvas'); c.width = c.height = 32;
        const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0, 32, 32);
        const d = ctx.getImageData(0, 0, 32, 32).data; let r=0,g=0,b=0,n=0;
        for(let i=0;i<d.length;i+=4) if(d[i+3]>180){r+=d[i];g+=d[i+1];b+=d[i+2];n++;}
        return n ? `rgb(${Math.round(r/n)},${Math.round(g/n)},${Math.round(b/n)})` : '#b6a9aa';
    };
    const skin=average(parts.skin);
    const garment=composeGarments(parts,{outfit:hair?.layers.outfit?.length??1,outer:hair?.layers.outer?.length??1});
    const frontScalp=keep(new T.MeshStandardMaterial({color:average(parts.fronthair),roughness:1}));
    const rearScalp=keep(new T.MeshStandardMaterial({color:average(parts.back1||parts.back2||parts.fronthair),roughness:1}));
    // Match the actual face/body material boundary (model y=.60) in the original
    // 472px canvas. Split spatially, so several rolled decorations can land on
    // different surfaces without classifying the whole decor layer as one item.
    const decorBoundary=424-.60/2*336;
    const decorLayer=(face:boolean)=>{
        const canvas=document.createElement('canvas');canvas.width=canvas.height=472;
        const ctx=canvas.getContext('2d')!;
        ctx.beginPath();ctx.rect(0,face?0:decorBoundary,472,face?decorBoundary:472-decorBoundary);ctx.clip();
        if(parts.decor)ctx.drawImage(parts.decor,0,0,472,472);
        return canvas;
    };
    const faceDecor=decorLayer(true),bodyDecor=decorLayer(false);
    const facePlacement={eyes:{x:0,y:blank?-16:0},mouth:{x:0,y:blank?-16:0}};
    let faceSettings:FaceSettings|undefined,faceImages:Awaited<ReturnType<typeof loadFaceImages>>|undefined,faceVersion=0,disposed=false;
    keep({dispose(){disposed=true;faceVersion++;}});
    const makeTexture=(keys:string[],fill?:string,eyes:'original'|'sleep'|'squeeze'='original',target?:T.Texture)=>{
        // Supersample only the facial atlas, preserving the original 472px
        // artwork coordinates. This avoids extra loss when positioning features.
        const facial=keys.includes('eyes'),resolution=facial?2:1;
        const canvas=target?.image as HTMLCanvasElement||document.createElement('canvas'); canvas.width=canvas.height=472*resolution;
        const ctx=canvas.getContext('2d')!;
        ctx.scale(resolution,resolution);ctx.imageSmoothingQuality='high';
        if(fill){ctx.fillStyle=fill;ctx.fillRect(0,0,472,472);}
        const splitFace=faceSettings?.enabled&&faceImages?composeFace(faceSettings,faceImages,eyes==='sleep'?'closed':eyes==='squeeze'?'happy':faceSettings.eyeState):undefined;
        keys.forEach(k=>{
            const drawable=k==='faceDecor'?faceDecor:k==='outfit'?garment:k==='eyes'&&splitFace?splitFace.eyes:k==='mouth'&&splitFace?splitFace.mouth:parts[k];
            if(!drawable)return;
            ctx.save();
            if(k==='eyes'||k==='mouth')ctx.translate(facePlacement[k].x,-facePlacement[k].y);
            // Keep marks and accessories aligned with the -16 facial baseline.
            if(blank&&(k==='facemark'||k==='faceDecor'))ctx.translate(0,16);
            // Move the fringe artwork down while keeping its shell fitted to the head.
            if(blank&&k==='fronthair')ctx.translate(0,16);
            // Lift the facial cluster by 8 creator pixels and gently compact it.
            // Garments/hair retain their original registration against the body.
            if(k==='eyes'||k==='mouth'||k==='facemark')ctx.transform(.97,0,0,.96,237*.03,268*.04-8);
            if(k==='eyes'&&!splitFace&&eyes==='squeeze'){
                ctx.strokeStyle='#514747';ctx.lineWidth=7;ctx.lineCap='round';ctx.lineJoin='round';
                // Draw > on the left and < on the right in the original eye area.
                for(const [x,direction] of [[177,1],[297,-1]]){
                    ctx.beginPath();ctx.moveTo(x-direction*18,252);ctx.lineTo(x+direction*18,270);ctx.lineTo(x-direction*18,288);ctx.stroke();
                }
            }else if(k==='eyes'&&!splitFace&&eyes==='sleep'){
                ctx.strokeStyle='#514747';ctx.lineWidth=6;ctx.lineCap='round';
                for(const x of [177,297]){ctx.beginPath();ctx.moveTo(x-25,270);ctx.quadraticCurveTo(x,288,x+25,270);ctx.stroke();}
            }else ctx.drawImage(drawable,0,0,472,472);
            ctx.restore();
        });
        const texture=target??keep(new T.CanvasTexture(canvas));texture.colorSpace=T.SRGBColorSpace;texture.needsUpdate=true;
        if(facial){texture.anisotropy=4;texture.magFilter=T.LinearFilter;texture.minFilter=T.LinearMipmapLinearFilter;}
        return texture;
    };
    const garmentMap=(rear:boolean)=>{
        const canvas=clothingCanvas(garment,skin,rear);
        // Body decorations overlay the front garment; do not smear their colors
        // across the back when extending the garment's original edge colors.
        if(!rear)canvas.getContext('2d')!.drawImage(bodyDecor,0,0);
        const map=keep(new T.CanvasTexture(canvas));map.colorSpace=T.SRGBColorSpace;return map;
    };
    const frontCloth=keep(new T.MeshStandardMaterial({map:appearance==='outfit'?garmentMap(false):makeTexture([],skin),roughness:1}));
    const faceKeys=appearance==='outfit'&&!blank?['facemark','eyes','mouth','outfit','faceDecor']:['facemark','eyes','mouth','faceDecor'];
    const front=keep(new T.MeshStandardMaterial({map:makeTexture(faceKeys,skin),roughness:1}));
    const awakeMap=front.map;
    const asleepMap=makeTexture(faceKeys,skin,'sleep');
    const cuteMap=makeTexture(faceKeys,skin,'squeeze');
    const setFacePlacement=(placement:typeof facePlacement)=>{
        for(const key of ['eyes','mouth'] as const)for(const axis of ['x','y'] as const){
            const value=placement[key][axis];facePlacement[key][axis]=Number.isFinite(value)?T.MathUtils.clamp(value,-80,80):0;
        }
        makeTexture(faceKeys,skin,'original',awakeMap!);
        makeTexture(faceKeys,skin,'sleep',asleepMap);
        makeTexture(faceKeys,skin,'squeeze',cuteMap);
    };
    const setFaceSettings=async(value?:FaceSettings)=>{
        const version=++faceVersion,next=value?cleanFace(value):undefined;
        const loaded=next?.enabled?await loadFaceImages(next):undefined;
        if(disposed||version!==faceVersion)return;
        faceSettings=next;faceImages=loaded;
        makeTexture(faceKeys,skin,'original',awakeMap!);
        makeTexture(faceKeys,skin,'sleep',asleepMap);
        makeTexture(faceKeys,skin,'squeeze',cuteMap);
        front.map=awakeMap;front.needsUpdate=true;
    };
    const updateFace=(time:number)=>{
        if(!faceSettings?.enabled||!faceImages)return;
        const canBlink=faceSettings.blink&&(faceSettings.eyeState==='open'||faceSettings.eyeState==='half')&&faceSettings.upper!=='04';
        front.map=canBlink&&time%4.3>4.12?asleepMap:awakeMap;
    };
    const back=keep(new T.MeshStandardMaterial({color:skin,roughness:1}));
    const backCloth=keep(new T.MeshStandardMaterial({map:appearance==='outfit'?garmentMap(true):makeTexture([],skin),roughness:1}));
    const root=new T.Group(), body=new T.Group();root.add(body);
    const hairPivot=new T.Group();hairPivot.position.y=.64;body.add(hairPivot);
    source.updateMatrixWorld(true);
    const bounds=new T.Box3().setFromObject(source), center=bounds.getCenter(new T.Vector3());
    const scale=2/bounds.getSize(new T.Vector3()).y;
    const surfaces:T.Mesh[]=[];
    const hands:Array<{mesh:T.Mesh; side:number}>=[];
    const deformers:Array<{geometry:T.BufferGeometry; rest:Float32Array; smoothNormals:()=>void}>=[];
    source.traverse(o=>{
        if(!(o instanceof T.Mesh))return;
        let geo=o.geometry.clone();geo.applyMatrix4(o.matrixWorld);
        geo.translate(-center.x,-bounds.min.y,-center.z);geo.scale(scale,scale,scale);
        if(geo.index){const expanded=geo.toNonIndexed();geo.dispose();geo=expanded;}
        keep(geo);
        const p=geo.getAttribute('position');const uv=new Float32Array(p.count*2);
        // FBX triangle corners are duplicated. Average normals by rest position
        // without welding away material/UV seams or changing the body silhouette.
        const shared=new Map<string,number[]>();
        for(let i=0;i<p.count;i++){
            const key=[p.getX(i),p.getY(i),p.getZ(i)].map(v=>Math.round(v*100000)).join(',');
            const group=shared.get(key);if(group)group.push(i);else shared.set(key,[i]);
        }
        const smoothNormals=()=>{
            geo.computeVertexNormals();const normals=geo.getAttribute('normal');
            for(const ids of shared.values()){
                let x=0,y=0,z=0;for(const i of ids){x+=normals.getX(i);y+=normals.getY(i);z+=normals.getZ(i);}
                const length=Math.hypot(x,y,z)||1;for(const i of ids)normals.setXYZ(i,x/length,y/length,z/length);
            }
            normals.needsUpdate=true;
        };
        smoothNormals();
        for(let i=0;i<p.count;i++){
            uv[i*2]=(237+p.getX(i)/1.875*325)/472;
            uv[i*2+1]=1-(424-p.getY(i)/2*336)/472;
        }
        geo.setAttribute('uv',new T.BufferAttribute(uv,2));geo.clearGroups();
        for(let i=0;i<p.count;i+=3){
            const z=(p.getZ(i)+p.getZ(i+1)+p.getZ(i+2))/3;
            const y=(p.getY(i)+p.getY(i+1)+p.getY(i+2))/3;
            const x=(p.getX(i)+p.getX(i+1)+p.getX(i+2))/3;
            // Tint the existing scalp only. Keep the protruding ears and the
            // forward facial surface skin-colored; bare comparison stays unpainted.
            const ear=Math.abs(x)>.81&&y>.86&&y<1.23&&Math.abs(z)<.25;
            const scalp=appearance!=='skin'&&!ear&&y>.72&&(z<0||y>1.72||(Math.abs(x)>.55&&z<.38));
            geo.addGroup(i,3,scalp?(z>0?4:5):y<.60?(z>0?3:2):(z>0?0:1));
        }
        // Reduce only head depth, keeping frontal proportions and original UVs.
        // Blend at the neck so the body and short hands retain their dimensions.
        for(let i=0;i<p.count;i++){
            const weight=T.MathUtils.smoothstep(p.getY(i),.62,.84);
            p.setZ(i,p.getZ(i)*(1-(1-headDepth)*weight));
        }
        p.needsUpdate=true;smoothNormals();
        const mesh=new T.Mesh(geo,[front,back,backCloth,frontCloth,frontScalp,rearScalp]);mesh.name='chibi-body';mesh.castShadow=true;body.add(mesh);surfaces.push(mesh);
        // Separate original hand triangles so gestures are rigid transforms:
        // no vertex displacement can elongate the little hand or its sleeve.
        const groups=geo.groups.map((g:{start:number;count:number;materialIndex?:number})=>({...g}));
        const buckets=[[],[],[]] as number[][];
        for(let i=0;i<p.count;i+=3){
            const x=(p.getX(i)+p.getX(i+1)+p.getX(i+2))/3,y=(p.getY(i)+p.getY(i+1)+p.getY(i+2))/3;
            buckets[Math.abs(x)>.415&&y>.36&&y<.65?(x>0?2:1):0].push(i);
        }
        const subset=(g:T.BufferGeometry,triangles:number[])=>{
            const indices:number[]=[];g.clearGroups();
            for(let material=0;material<6;material++){const start=indices.length;for(const i of triangles)if(groups[i/3].materialIndex===material)indices.push(i,i+1,i+2);if(indices.length>start)g.addGroup(start,indices.length-start,material);}g.setIndex(indices);
        };
        for(const side of blank?[]:[-1,1]){
            const handGeo=keep(geo.clone());subset(handGeo,buckets[side>0?2:1]);
            handGeo.translate(-side*.415,-.51,0);
            const hand=new T.Mesh(handGeo,mesh.material);hand.name=`chibi-hand-${side}`;hand.position.set(side*.415,.51,0);body.add(hand);hands.push({mesh:hand,side});
        }
        subset(geo,buckets[0]);
        deformers.push({geometry:geo,rest:Float32Array.from(p.array),smoothNormals});
    });
    body.updateMatrixWorld(true);
    // Action-only toy limbs: four independent round pieces, with no stretched
    // upper arms or legs. Standing idle retains the original chibi silhouette.
    const actionLimbs:Array<{mesh:T.Mesh;side:number;foot:boolean}>=[];
    const ballGeometry=keep(new T.SphereGeometry(.105,16,12));
    const handMaterial=keep(new T.MeshStandardMaterial({color:skin,roughness:1}));
    for(const side of [-1,1]){
        const shoeCanvas=frontCloth.map?.image as HTMLCanvasElement|undefined;
        let shoeColor=skin;
        if(shoeCanvas?.getContext){const pixels=shoeCanvas.getContext('2d')!.getImageData(Math.round(237+side*.19/1.875*325)-2,413,5,5).data;let r=0,g=0,b=0;for(let i=0;i<pixels.length;i+=4){r+=pixels[i];g+=pixels[i+1];b+=pixels[i+2];}shoeColor=`rgb(${r/25},${g/25},${b/25})`;}
        const shoeMaterial=keep(new T.MeshStandardMaterial({color:shoeColor,roughness:1}));
        for(const foot of [false,true]){const mesh=new T.Mesh(ballGeometry,foot?shoeMaterial:handMaterial);mesh.name=`chibi-action-${foot?'foot':'hand'}-${side}`;mesh.visible=false;body.add(mesh);actionLimbs.push({mesh,side,foot});}
    }
    if(appearance!=='skin'){
        // Front and rear are two halves of one shared, zero-thickness surface.
        // Both use identical seam positions at +/- PI/2; only their texture differs.
        const contoursFor=(image:HTMLImageElement)=>{
            let contours=contourCache.get(image);
            if(!contours){
                const canvas=document.createElement('canvas');canvas.width=canvas.height=192;
                const ctx=canvas.getContext('2d')!;ctx.drawImage(image,0,0,192,192);
                const pixels=ctx.getImageData(0,0,192,192).data,alpha=new Uint8Array(192*192);
                for(let i=0;i<alpha.length;i++)alpha[i]=pixels[i*4+3];
                contours=hairContours(alpha,192,192);contourCache.set(image,contours);
            }
            return contours;
        };
        const ringHalf=(keys:string[],rear:boolean,settings=defaultHairLayer,full=false)=>{
            const solidRear=keys.includes('back1');
            const rearShade=solidRear&&parts[keys[0]]?average(parts[keys[0]]):undefined;
            if(settings.mode==='project'&&parts[keys[0]]){
                const image=parts[keys[0]];
                const contours=contoursFor(image);
                if(!contours.length)return;
                const geometry=keep(createHairShell(contours,settings.puff??.16)),p=geometry.getAttribute('position');
                for(let i=0;i<p.count;i++){
                    const x=p.getX(i),y=p.getY(i);
                    p.setXYZ(i,x*settings.width,2.2+(y-2.2)*settings.length+settings.offsetY,p.getZ(i)+(rear?-1:1)*(.58+settings.distance-.10*Math.min(1.5,Math.abs(x))));
                }
                geometry.computeVertexNormals();
                const face=keep(new T.MeshStandardMaterial({map:makeTexture(keys),alphaTest:.2,side:T.DoubleSide,roughness:1}));
                const rim=keep(new T.MeshStandardMaterial({color:average(image),side:T.DoubleSide,roughness:1}));
                const sheet=new T.Mesh(geometry,[face,rim]);sheet.name=rear?'rear-hair-sheet':'front-hair-sheet';sheet.userData.hairConstruction='paired-sheets';sheet.position.set(settings.offsetX??0,-.64,settings.offsetZ??0);hairPivot.add(sheet);
                return;
            }
            const geometry=keep(new T.PlaneGeometry(1,1,64,80));
            const p=geometry.getAttribute('position'),uv=geometry.getAttribute('uv');
            for(let i=0;i<p.count;i++){
                const u=uv.getX(i),v=uv.getY(i);
                const sourceY=(1-v)*472;
                const theta=(u-.5)*(full?Math.PI*2:Math.PI);
                // Same 472px registration as skin/clothes: never fit the opaque
                // hair bounds to the full sheet, which would lengthen short styles.
                const y=Math.min(2.20,(424-sourceY)/336*2);
                const crown=Math.sqrt(Math.max(0,1-Math.max(0,(y-1.25)/.95)**2));
                const x=.99*crown*Math.sin(theta);
                const z=(rear?-1:1)*.86*headDepth*crown*Math.cos(theta);
                p.setXYZ(i,x*settings.width*(1+settings.distance),2.2+(y-2.2)*settings.length+settings.offsetY,z*(1+settings.distance));
                // Project original coordinates onto the shared ring so the central
                // bangs keep their 2D width instead of stretching with arc length.
                uv.setXY(i,full?u:(237+x/1.875*325)/472,v);
            }
            geometry.computeVertexNormals();
            const map=makeTexture(keys);
            // Keep the new authored back-hair strands and shading. The inner
            // liner still uses an average color to avoid mirrored texture seams.
            const material=keep(new T.MeshStandardMaterial({map,alphaTest:.2,side:T.DoubleSide,roughness:1}));
            const sheet=new T.Mesh(geometry,material);sheet.name=rear?'rear-hair-sheet':'front-hair-sheet';sheet.position.set(settings.offsetX??0,-.64,settings.offsetZ??0);hairPivot.add(sheet);
            if(solidRear&&!full){
                const contours=parts[keys[0]]?contoursFor(parts[keys[0]]):[];
                if(!contours.length)return;
                const surface=createHairShell(simplifyLinerContours(contours),.022,.1);
                const linerMaterial=keep(new T.MeshStandardMaterial({color:rearShade,side:T.DoubleSide,roughness:1}));
                const liner=new T.Mesh(keep(createRearHairLiner(settings,headDepth,surface)),linerMaterial);
                liner.name='rear-hair-wisp-liner';liner.position.copy(sheet.position);hairPivot.add(liner);
            }
        };
        for(const [key,rear,index] of [['back2',true,0],['back1',true,1],['earhair',false,0],['fronthair',false,1]] as const){
            const settings=hair?.layers[key]??defaultHairLayer;
            ringHalf([key],rear,{...settings,mode:hairMode(hair,key),distance:settings.distance+index*.002});
        }
        for(const layer of hair?.extras??[]){
            if(parts[layer.source])ringHalf([layer.source],layer.mode==='project',layer,true);
        }
        // Continue the adjacent painted colors, not the average of the entire
        // hairstyle. Vertex colors carry only a soft color field, never stretched
        // strands or highlights from the original texture.
        const colorField=(keys:string[])=>{
            const first=parts[keys[0]],second=parts[keys[1]]??first;
            const cached=first&&second?hairColorCache.get(first)?.get(second):undefined;
            if(cached)return cached;
            const c=document.createElement('canvas');c.width=c.height=118;
            const ctx=c.getContext('2d')!;for(const key of keys)if(parts[key])ctx.drawImage(parts[key],0,0,118,118);
            const pixels=ctx.getImageData(0,0,118,118).data;
            const opaque:Array<{x:number;y:number;color:T.Color}>=[];
            for(let y=0;y<118;y++)for(let x=0;x<118;x++){
                const i=(y*118+x)*4;if(pixels[i+3]<200)continue;
                opaque.push({x,y,color:new T.Color().setRGB(pixels[i]/255,pixels[i+1]/255,pixels[i+2]/255,T.SRGBColorSpace)});
            }
            const samples=new Map<string,T.Color>();
            const sample=(x:number,y:number)=>{
                const key=`${Math.round(x*200)},${Math.round(y*200)}`;
                const existing=samples.get(key);if(existing)return existing.clone();
                const px=(237+x/1.875*325)/4,py=(424-y/2*336)/4;
                let nearest=Infinity,anchor:typeof opaque[number]|undefined;
                for(const point of opaque){const d=(point.x-px)**2+(point.y-py)**2;if(d<nearest){nearest=d;anchor=point;}}
                if(!anchor)return new T.Color(average(parts.fronthair));
                // A nearest opaque pixel can be the dark painted outline. Take
                // a small opaque neighborhood instead of extending that line
                // across the entire side of the head.
                const color=new T.Color(0,0,0);let weight=0;
                for(const point of opaque){const d=(point.x-anchor.x)**2+(point.y-anchor.y)**2;if(d>16)continue;const w=1/(1+d);color.r+=point.color.r*w;color.g+=point.color.g*w;color.b+=point.color.b*w;weight+=w;}
                const result=weight?color.multiplyScalar(1/weight):anchor.color.clone();samples.set(key,result);return result.clone();
            };
            if(first&&second){let bySecond=hairColorCache.get(first);if(!bySecond){bySecond=new WeakMap();hairColorCache.set(first,bySecond);}bySecond.set(second,sample);}
            return sample;
        };
        const frontColor=colorField(['earhair','fronthair']);
        const rearBase=new T.Color(average(parts.back1||parts.back2||parts.fronthair));
        const rearColor=(_x:number,_y:number)=>rearBase.clone();
        const joinMaterial=keep(new T.MeshStandardMaterial({vertexColors:true,side:T.DoubleSide,roughness:1}));
        const finishUnderlay=(geometry:T.BufferGeometry,name:string)=>{
            const p=geometry.getAttribute('position'),colors:number[]=[],normals:number[]=[];
            for(let i=0;i<p.count;i++){
                const x=p.getX(i),y=p.getY(i),z=p.getZ(i);
                const radius=Math.sqrt(Math.max(0,1-Math.max(0,(y-1.25)/.95)**2));
                // Mirror the positive-x side's color field onto the other side.
                // Only the filler is symmetric; original hair artwork, geometry
                // and ear openings retain their own silhouettes and lighting.
                const sidePatch=name.startsWith('plain-hair-gap');
                const sampleX=sidePatch?.984*radius*Math.cos(.56):Math.abs(x);
                const angle=Math.atan2(z/(.854*headDepth),Math.abs(x)/.984);
                const blend=sidePatch?T.MathUtils.smoothstep(angle,-.56,.56):T.MathUtils.smoothstep(z,-.24,.24);
                const color=rearColor(sampleX,y).lerp(frontColor(sampleX,y),blend);colors.push(color.r,color.g,color.b);
                const normal=new T.Vector3(x/(.984*.984),Math.max(0,y-1.25)/(.95*.95),z/(.854*headDepth)**2).normalize();
                normals.push(normal.x,normal.y,normal.z);
            }
            geometry.setAttribute('color',new T.Float32BufferAttribute(colors,3));
            geometry.setAttribute('normal',new T.Float32BufferAttribute(normals,3));geometry.deleteAttribute('uv');
            const join=new T.Mesh(geometry,joinMaterial);join.name=name;join.position.y=-.64;hairPivot.add(join);
        };
        for(const side of [-1,1] as const){
            const geometry=keep(createHairSeam(side,headDepth));
            finishUnderlay(geometry,`plain-hair-gap-${side}`);
        }
        // A shallow, closed crown sheet sits just under both hair halves. The
        // shared apex removes the old minimum-radius tube and its open top.
        const crown=keep(new T.SphereGeometry(1,64,18,0,Math.PI*2,0,Math.acos((1.94-1.25)/.947)));
        crown.scale(.982,.947,.852*headDepth);crown.translate(0,1.25,0);
        finishUnderlay(crown,'plain-hair-crown');
    }
    let rig:ReturnType<typeof bindBlankBody>|undefined;
    if(blank){
        const mesh=body.getObjectByName('chibi-body') as T.Mesh;
        const {headSize}=bodyProportions(hair);
        mesh.geometry=keep(createBlankBody(appearance,hair));
        hairPivot.position.y=fitBlankHeadY(BLANK_HAIR_PIVOT,hair);
        hairPivot.scale.set(BLANK_HEAD_SCALE.x*headSize,BLANK_HAIR_Y_SCALE*BLANK_HEAD_SCALE.y*headSize,BLANK_HAIR_Z_SCALE*BLANK_HEAD_SCALE.z*headSize);
        rig=bindBlankBody(mesh,hairPivot,true);keep(rig.skeleton);
    }
    const smooth=(a:number,b:number,v:number)=>T.MathUtils.smoothstep(v,a,b);
    const blankAnimate=rig?createBlankMotion(rig,body):undefined;
    const animate=(time:number,motion:Motion,posture:Posture='standing',activity?:ActivityPose)=>{
        if(blankAnimate){
            blankAnimate(time,motion,posture,activity);
            if(faceSettings?.enabled)updateFace(time);else front.map=motion==='sleep'?asleepMap:motion==='wave-cute'?cuteMap:awakeMap;
            return;
        }
        const cute=motion==='wave-cute',calm=motion==='wave-calm'||motion==='wave';
        const mirror=motion==='mirror-admire'||motion==='mirror-outfit'?mirrorFrame(motion,time):null;
        const sleeping=motion==='sleep',angry=motion==='angry',sitting=posture==='seated'||motion==='sit';
        const floatingLimbs=sitting||!!activity||['wave','wave-cute','wave-calm','angry','dance','water'].includes(motion);
        const rhythm=motion==='rhythm'&&!sitting?rhythmFrame(activity,time):null;
        const enter=smooth(0,.35,time);
        const beat=time%2.2;
        // Squash -> airborne -> soft landing, with a rest between little hops.
        const jump=cute&&!sitting?Math.max(0,Math.sin(Math.min(1,Math.max(0,(beat-.18)/.75))*Math.PI))*.24:0;
        const crouch=cute&&!sitting&&beat<.18?Math.sin(beat/.18*Math.PI)*.045:0;
        const headTilt=cute?(-.10+Math.sin(time*3)*.035)*enter:sleeping?.055:angry?Math.sin(time*15)*.022:motion==='dance'?Math.sin(time*3)*.055:Math.sin(time*1.8)*.008;
        const inBed=posture==='lying',lying=sleeping&&!sitting&&!inBed;
        body.position.set(lying?.94:0,lying?.98+Math.sin(time*1.8)*.012:jump-crouch,0);
        if(rhythm)body.position.fromArray(rhythm.offset);
        body.rotation.set(inBed?-Math.PI/2:0,0,inBed||sitting?0:lying?Math.PI/2-.10:angry?Math.sin(time*14)*.025:motion==='dance'?Math.sin(time*3)*.045:0);
        if(inBed)body.position.set(0,Math.sin(time*1.8)*.009,0);
        body.scale.set(1,lying?1+Math.sin(time*1.8)*.012:1,1);
        const headNod=sitting&&sleeping?.10+Math.sin(time*1.6)*.025:motion==='stream'?.025*Math.sin(time*3):motion==='eat'?.018+.018*Math.sin(time*4):0;
        hairPivot.rotation.z=headTilt;
        hairPivot.rotation.x=headNod;
        if(motion==='bath-laundry'){hairPivot.rotation.set(Math.sin(time*2.5)*.08,Math.sin(time*1.8)*.16,Math.sin(time*2)*.08);body.rotation.z=Math.sin(time*2)*.04;}
        if(motion==='bath-shower'){hairPivot.rotation.x=.08;body.rotation.y=Math.sin(time*2)*.06;}
        if(mirror){body.rotation.y=mirror.yaw;hairPivot.rotation.z=mirror.tilt;hairPivot.rotation.x=mirror.nod;}
        if(faceSettings?.enabled)updateFace(time);else {const faceMap=sleeping?asleepMap:cute?cuteMap:awakeMap;if(front.map!==faceMap){front.map=faceMap;front.needsUpdate=true;}}
        for(const {mesh,side} of hands){
            mesh.visible=!floatingLimbs;
            const waving=(cute||calm)&&side>0;
            const swing=Math.sin(time*(cute?7:5));
            mesh.position.set(side*.415,.51,0);
            mesh.rotation.set(0,0,0);
            if(sitting){mesh.rotation.x=-.55;mesh.rotation.z=side*.16;mesh.position.set(side*.39,.46,.11);}
            if(motion==='water'){mesh.rotation.x=-.45;mesh.rotation.z=side*.16;mesh.position.set(side*.30,.53,.26);}
            if(activity){
                const target=(mirror?.hands||rhythm?.hands||activity.hands)[side<0?0:1];
                if(target){mesh.position.fromArray(target);mesh.rotation.x=-.5;
                    if(motion==='eat'){mesh.position.fromArray(eatingHand(target,time,side));}
                    if(motion==='computer'){mesh.position.y+=Math.max(0,Math.sin(time*9+side*1.5))*.032;}
                    if(motion==='stream'){mesh.position.y+=side>0?.07+.035*Math.sin(time*4):.012*Math.sin(time*5);mesh.rotation.z=side>0?.18*Math.sin(time*4):0;}
                    if(motion==='race'){const turn=Math.sin(time*1.9)*.15;mesh.position.y+=side*turn;mesh.position.x-=side*(1-Math.cos(turn))*.3;mesh.rotation.z=turn;}
                    if(motion==='rhythm'&&!rhythm){mesh.position.y+=Math.max(0,Math.sin(time*4.8+side*Math.PI/2))*.016;mesh.position.z-=Math.max(0,Math.cos(time*4.8+side*Math.PI/2))*.045;}
                }
            }
            if(waving){mesh.rotation.z=(.20+swing*.24)*enter;mesh.position.y+=(cute?.055:.025)*enter;mesh.position.z+=.025*enter;}
            else if(angry){mesh.rotation.z=side*(.18+Math.sin(time*13)*.08);mesh.position.y+=.02;}
            else if(motion==='walk'||motion==='dance')mesh.rotation.x=Math.sin(time*4+side)*.16;
        }
        for(const {mesh,side,foot} of actionLimbs){
            mesh.visible=foot?sitting:floatingLimbs;
            if(foot){mesh.position.set(side*.19,sitting?-.10+.018*Math.sin(time*2.6+side):.055,sitting?.68:.27);mesh.rotation.set(0,0,0);}
            else{const hand=hands.find(h=>h.side===side)?.mesh;if(hand){mesh.position.copy(hand.position);mesh.rotation.copy(hand.rotation);}
                // A round hand has no readable rotation: wave its center in a
                // small arc, without changing its radius or growing an arm.
                if((cute||calm)&&side>0){
                    // Lift beside the large head, outside the hair silhouette.
                    mesh.position.x+=((cute?.98:.92)+Math.sin(time*(cute?7:5))*.08-mesh.position.x)*enter;
                    mesh.position.y+=((cute?.82:.76)-mesh.position.y)*enter;
                    mesh.position.z+=(.46-mesh.position.z)*enter;
                }
            }
        }
        for(const {geometry,rest,smoothNormals} of deformers){
            const p=geometry.getAttribute('position');
            for(let i=0;i<p.count;i++){
                const x=rest[i*3],y=rest[i*3+1],z=rest[i*3+2],side=Math.sign(x);
                let nx=x,ny=y,nz=z;
                // Tuck only the original tiny toes while the action feet show.
                // Never curl the rounded lower torso into a pedestal.
                if(sitting)nz*=1-.6*(1-smooth(.035,.105,y));
                if(motion==='walk'&&!sitting)nz+=Math.sin(time*4+side*Math.PI/2)*.055*(1-smooth(.12,.30,y));
                if(angry&&side<0&&!sitting)ny+=Math.max(0,Math.sin(time*7))*.05*(1-smooth(.12,.30,y));
                const headWeight=smooth(.62,.84,y),ha=headTilt*headWeight;
                const hx=nx,hy=ny-.64;
                nx=hx*Math.cos(ha)-hy*Math.sin(ha);ny=.64+hx*Math.sin(ha)+hy*Math.cos(ha);
                const nod=headNod*headWeight,dy=ny-.64;
                ny=.64+dy*Math.cos(nod)-nz*Math.sin(nod);nz=dy*Math.sin(nod)+nz*Math.cos(nod);
                p.setXYZ(i,nx,ny,nz);
            }
            p.needsUpdate=true;smoothNormals();
        }
    };
    animate(0,'idle');
    return {root,resources,animate,rig,setFacePlacement,setFaceSettings,updateFace};
}
