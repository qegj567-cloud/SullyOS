import {photoFrames,photoSize,type PhotoFrame,type PhotoRenderOptions} from './photoFrame';
import {defaultPhotoLettering,photoFontFamily,type PhotoLettering} from './photoLettering';

/** Normalized rectangles drive both the photographed area and exported paper. */
export function photoWindows(format:PhotoFrame){
 const aspect=photoFrames[format].aspect;
 if(format==='polaroid')return [{x:.06,y:.048,w:.88,h:.88*aspect}];
 if(format==='sticker')return [{x:.07,y:.12,w:.86,h:.86*aspect}];
 if(format==='collage')return [0,1,2,3].map(i=>({x:.055+(i%2)*.46,y:.075+Math.floor(i/2)*.46*aspect,w:.43,h:.43*aspect}));
 return [{x:0,y:0,w:1,h:1}];
}
export function photoCaptureAspect(format:PhotoFrame){const r=photoWindows(format)[0];return photoFrames[format].aspect*r.w/r.h;}
export function isPhotoPaper(format:PhotoFrame){return ['polaroid','sticker','collage'].includes(format);}

/** The same compositor paints the live preview and the saved PNG. */
export function composePhoto(source:HTMLCanvasElement,output:HTMLCanvasElement,format:PhotoFrame,quality:PhotoRenderOptions['quality'],lettering:PhotoLettering=defaultPhotoLettering(format)){
 const {width,height}=photoSize(photoFrames[format].aspect,quality);output.width=width;output.height=height;
 const ctx=output.getContext('2d');if(!ctx)throw Error('无法绘制照片');
 ctx.fillStyle=format==='polaroid'?'#fff9ed':format==='collage'?'#fff1ec':'#fbe9f0';ctx.fillRect(0,0,width,height);
 const windows=photoWindows(format);
 for(const r of windows)ctx.drawImage(source,Math.round(r.x*width),Math.round(r.y*height),Math.round(r.w*width),Math.round(r.h*height));
 if(!isPhotoPaper(format))return;
 const heart=(x:number,y:number,size:number)=>{
  ctx.save();ctx.translate(x*width,y*height);ctx.scale(size*width,size*width);ctx.beginPath();ctx.moveTo(0,.3);ctx.bezierCurveTo(-1,-.35,-.55,-1,.0,-.5);ctx.bezierCurveTo(.55,-1,1,-.35,0,.3);ctx.fill();ctx.restore();
 };
 const star=(x:number,y:number,size:number)=>{ctx.save();ctx.translate(x*width,y*height);ctx.beginPath();for(let i=0;i<8;i++){const angle=i*Math.PI/4,r=(i%2?.28:1)*size*width;const px=Math.cos(angle)*r,py=Math.sin(angle)*r;i?ctx.lineTo(px,py):ctx.moveTo(px,py);}ctx.closePath();ctx.fill();ctx.restore();};
 ctx.fillStyle=format==='polaroid'?'#c08275':'#c97c97';
 if(format==='polaroid'){heart(.83,.87,.035);ctx.fillStyle='#6c5c53';}
 else {heart(.09,.09,.035);heart(.91,.85,.033);star(.86,.06,.022);star(.13,.85,.022);}
 ctx.textAlign='center';ctx.textBaseline='middle';
 const family=photoFontFamily(lettering.font);
 const text=(value:string,size:number,y:number,maxWidth:number)=>{
  if(!value)return;
  ctx.font=`${size}px ${family}`;
  const measured=ctx.measureText(value).width;
  if(measured>maxWidth)ctx.font=`${size*maxWidth/measured}px ${family}`;
  ctx.fillText(value,width*.5,y,maxWidth);
 };
 text(lettering.title,width*.034,height*.87,width*.58);
 ctx.fillStyle='#a28a8e';text(lettering.footer,width*.018,height*.925,width*.82);
}
