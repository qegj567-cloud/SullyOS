import React from 'react';
import {beautyShareContents,type BeautyShareSelection} from '../../utils/beautyShareContents';
export default function BeautyShareContents({pack,selection,onChange}:{pack:unknown;selection:BeautyShareSelection;onChange:(next:BeautyShareSelection)=>void}){
  const contents=beautyShareContents(pack);
  if(!contents.length)return null;
  return <fieldset className="beauty-share-contents"><legend>本次分享包含</legend>
    <p>作品包含以下内容，默认全部勾选。请取消不想分享的部分，本机原预设不变。</p>
    {contents.map(item=><label className="beauty-share-check" key={item.key}><input type="checkbox" disabled={item.required} checked={selection[item.key]!==false} onChange={e=>onChange({...selection,[item.key]:e.target.checked})}/>包含{item.label}{item.key==='sound'?'（会影响接收者的消息提示音）':''}</label>)}
    <small>手写 CSS 中未独立保存的效果，随「白框 / 自定义样式」一起分享；气泡内嵌头像框随该气泡一起分享。</small>
  </fieldset>;
}
