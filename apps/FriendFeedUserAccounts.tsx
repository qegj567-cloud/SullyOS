import React from 'react';
import {createLocalId} from '../utils/localId.js';
import type {FriendFeedSettings} from '../utils/friendFeedSettings';

export default function FriendFeedUserAccounts({value,onChange,disabled}:{value:FriendFeedSettings;onChange:(value:FriendFeedSettings)=>void;disabled:boolean}) {
    const accounts=value.userAccounts||[];
    return <section className="ff-preferences-section" aria-label="我的账号与小号">
        <p className="friend-feed-settings-hint">在哔哔里使用不同的网上身份。公开简介只随相关哔哔内容提供，不修改你的档案或常驻私聊人设。</p>
        <label className="ff-setting-field">哔哔网名<input aria-label="我的哔哔网名" value={value.userNickname||''} maxLength={40} disabled={disabled} placeholder="留空使用档案里的名字" onChange={e=>onChange({...value,userNickname:e.target.value})}/></label>
        <label className="ff-setting-field">主号网上人设 / 公开简介<textarea aria-label="我的主号公开简介" value={value.userBio||''} maxLength={1000} rows={3} disabled={disabled} placeholder="例如：记录两个人生活的情侣博主。只填写希望网友知道的内容。" onChange={e=>onChange({...value,userBio:e.target.value})}/></label>
        {accounts.map((account,index)=><fieldset className="ff-account-editor" key={account.id} disabled={disabled}>
            <legend>我的小号 {index+1}</legend>
            <label className="ff-setting-field">账号名<input aria-label={`我的小号 ${index+1} 账号名`} value={account.name} required maxLength={40} onChange={e=>onChange({...value,userAccounts:accounts.map(a=>a.id===account.id?{...a,name:e.target.value}:a)})}/></label>
            <label className="ff-setting-field">网上人设 / 公开简介<textarea aria-label={`我的小号 ${index+1} 公开简介`} value={account.bio||''} maxLength={1000} rows={3} placeholder="这个账号公开经营什么内容、呈现什么形象？不要填写想对网友保密的身份。" onChange={e=>onChange({...value,userAccounts:accounts.map(a=>a.id===account.id?{...a,bio:e.target.value}:a)})}/></label>
            <label className="ff-setting-field">话题标签<input value={account.tags.join('，')} maxLength={240} placeholder="摄影，咖啡，日常" onChange={e=>onChange({...value,userAccounts:accounts.map(a=>a.id===account.id?{...a,tags:e.target.value.split(/[,，、]/).slice(0,8)}:a)})}/></label>
            <button className="ff-setting-link" type="button" onClick={()=>onChange({...value,userAccounts:accounts.filter(a=>a.id!==account.id)})}>移除这个小号</button>
        </fieldset>)}
        <button className="ff-setting-button ff-setting-secondary" type="button" disabled={disabled||accounts.length>=3} onClick={()=>onChange({...value,userAccounts:[...accounts,{id:createLocalId(),name:`我的小号 ${accounts.length+1}`,bio:'',purpose:'',tags:[]}]})}>添加我的小号 · {accounts.length}/3</button>
        <p className="friend-feed-settings-hint">新小号默认没人知道是你，互关也不会自动掉马。保存后到「关注与身份关系」，选中这个账号，设置哪些角色知道。明确自报身份或私聊告知后，角色也能认出。</p>
        <p className="friend-feed-settings-hint">发帖和评论时可选择自己的账号。小号属于当前用户，不另建聊天记忆；移除后保留历史内容。模型不会代替你的任何账号发言。</p>
    </section>;
}
