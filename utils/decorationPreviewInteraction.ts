/** In-memory visual states only. No message handlers, DB, audio or app navigation. */
export interface DecorationPreviewState {
 psyche?:Record<string,boolean>;
 transfers?:Record<string,'accepted'|'returned'>;
 transferOpen?:string;
 panel?:boolean;
 actionsPage?:number;
}
export function bindDecorationPreview(body:HTMLElement,state:DecorationPreviewState,expanded:boolean,update:(next:DecorationPreviewState)=>void, selectScene?:(id:string)=>void){
 const bind=(element:Element|null,action:string,label?:string)=>{
  if(!element)return;
  element.setAttribute('data-preview-action',action);
  element.setAttribute('tabindex','0');
  if(element.tagName!=='BUTTON')element.setAttribute('role','button');
  if(label)element.setAttribute('aria-label',label);
 };
 body.querySelectorAll('[data-preview-message]').forEach(row=>{
  const id=row.getAttribute('data-preview-message')!;
  const psyche=row.querySelector('.sully-psyche');
  bind(psyche,'psyche:'+id,'心象：展开或折叠');psyche?.setAttribute('aria-expanded',String(state.psyche?.[id]??expanded));
  bind(row.querySelector('.sully-chat-transfer-card'),'transfer:'+id,'查看示例转账');
  bind(row.querySelector('.sully-chat-transfer-accept'),'accept:'+id);
  bind(row.querySelector('.sully-chat-transfer-return'),'return:'+id);
  const overlay=row.querySelector('.sully-chat-transfer-overlay');
  // The backdrop is handled separately so taps inside the dialog never dismiss it.
  overlay?.setAttribute('data-preview-backdrop','true');
  const dialog=row.querySelector('.sully-chat-transfer-dialog');
  dialog?.setAttribute('role','dialog');dialog?.setAttribute('aria-label','示例转账详情');
  dialog?.querySelectorAll('button').forEach(button=>{if(button.textContent==='关闭')bind(button,'close-transfer');});
 });
 if(selectScene)body.querySelectorAll<HTMLButtonElement>('.chat-profile-tabs [data-preview-scene]').forEach(button=>{
  button.setAttribute('data-preview-action','scene:'+button.dataset.previewScene);
  button.tabIndex=0;
 });
 bind(body.querySelector('.sully-chat-actions-button'),'panel','聊天功能');
 body.querySelectorAll('button[aria-label]').forEach(button=>{const match=button.getAttribute('aria-label')?.match(/^第 (\d+) 页$/);if(match)bind(button,'page:'+String(Number(match[1])-1));});
 // Inert controls remain visibly previews and never focus/trigger real handlers.
 body.querySelectorAll('button,input,textarea,[role=button],a').forEach(element=>{
  if(element.hasAttribute('data-preview-action'))return;
  element.setAttribute('tabindex','-1');element.setAttribute('aria-disabled','true');
 });
 const act=(action:string)=>{
  const [type,id]=action.split(':');
  if(type==='scene')selectScene?.(id);
  if(type==='psyche')update({...state,psyche:{...state.psyche,[id]:!(state.psyche?.[id]??expanded)}});
  if(type==='transfer')update({...state,transferOpen:id});
  if(type==='accept'||type==='return')update({...state,transferOpen:undefined,transfers:{...state.transfers,[id]:type==='accept'?'accepted':'returned'}});
  if(type==='close-transfer')update({...state,transferOpen:undefined});
  if(type==='panel')update({...state,panel:!state.panel});
  if(type==='page')update({...state,actionsPage:Number(id)});
 };
 const click=(event:Event)=>{const target=event.target as Element;event.preventDefault();event.stopPropagation();const action=target.closest('[data-preview-action]')?.getAttribute('data-preview-action');if(action)act(action);else if(target.hasAttribute('data-preview-backdrop'))act('close-transfer');};
 const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();update({...state,panel:false,transferOpen:undefined});return;}if(event.key!=='Enter'&&event.key!==' ')return;const action=(event.target as Element).closest('[data-preview-action]')?.getAttribute('data-preview-action');if(action){event.preventDefault();event.stopPropagation();act(action);}};
 body.addEventListener('click',click);body.addEventListener('keydown',key);
 return ()=>{body.removeEventListener('click',click);body.removeEventListener('keydown',key);};
}
