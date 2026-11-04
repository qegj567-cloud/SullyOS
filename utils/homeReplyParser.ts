import type {HomeScene} from '../apps/room3d/types';

export interface HomeReply {text:string;silent?:boolean;actionId?:string;actionIds?:string[]}

// Only remove trailing commas outside strings. Never rewrite spoken content.
function decode(source:string):unknown {
 let clean='',quoted=false,escaped=false;
 for(let i=0;i<source.length;i++){
  const c=source[i];
  if(quoted){clean+=c;if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
  if(c==='"')quoted=true;
  if(c===','&&/^\s*[}\]]/.test(source.slice(i+1)))continue;
  clean+=c;
 }
 return JSON.parse(clean);
}

export function parseHomeReply(raw:string,scene:HomeScene,onAction?:(info:{requested:string|number|null;selected:string|null})=>void):HomeReply {
 const text=raw.replace(/<think\b[^>]*>[\s\S]*?(?:<\/think\s*>|$)/gi,'').trim();
 if(!text)throw Error('回复为空，请重试');
 const body=text.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();
 let value:any;
 try{value=decode(body);}catch{
  // Find complete objects without mistaking braces inside dialogue for delimiters.
  const objects:string[]=[];let depth=0,start=-1,quoted=false,escaped=false;
  for(let i=0;i<body.length;i++){
   const c=body[i];
   if(start<0){if(c==='{'){start=i;depth=1;}continue;}
   if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
   if(c==='"')quoted=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0){objects.push(body.slice(start,i+1));start=-1;}
  }
  if(objects.length===1&&start<0){try{value=decode(objects[0]);}catch{/* Reject malformed structured output below. */}}
  if(value===undefined){
   if(objects.length||start>=0||/^[\[{]|```|["'](?:text|actionId)["']\s*:/.test(body))throw Error('回复没有完整生成，请重试');
   onAction?.({requested:null,selected:null});
   return {text:body.slice(0,8000)};
  }
 }
 if(value?.silent===true&&value.text===''&&Array.isArray(value.actionIds)&&!value.actionIds.length&&(scene.participants?.filter(p=>p.id!=='user').length||0)>1)return {text:'',silent:true,actionIds:[]};
 if(!value||Array.isArray(value)||typeof value.text!=='string'||!value.text.trim())throw Error('回复为空，请重试');
 const resolve=(input:unknown)=>{
  const id=typeof input==='string'?input.trim():input;
  const number=typeof id==='number'?id:typeof id==='string'&&/^[1-9]\d*$/.test(id)?Number(id):NaN;
  const named=typeof id==='string'?scene.actions.filter(a=>a.label===id):[];
  const action=Number.isSafeInteger(number)&&number>0?scene.actions[number-1]:typeof id==='string'?scene.actions.find(a=>a.id===id)||(named.length===1?named[0]:undefined):undefined;
  onAction?.({requested:typeof id==='number'?id:typeof id==='string'?id.slice(0,120):null,selected:scene.present?action?.id??null:null});
  return scene.present?action?.id:undefined;
 };
 if(value.actionIds!==undefined&&!Array.isArray(value.actionIds))throw Error('动作计划格式不正确，请重试');
 if(Array.isArray(value.actionIds)){
  // A missing middle step must not silently turn into a different plan.
  if(value.actionIds.length>8)throw Error('动作计划过长，请重试');
  const ids:(string|undefined)[]=value.actionIds.map(resolve);
  if(scene.present&&ids.some(id=>!id))throw Error('动作计划包含无效编号，请重试');
  return {text:value.text.trim().slice(0,8000),actionIds:ids.filter((id):id is string=>!!id)};
 }
 return {text:value.text.trim().slice(0,8000),actionId:resolve(value.actionId)};
}
