import React, {useEffect, useRef, useState} from 'react';
import BibiIcon from '../components/os/BibiIcon';
import type {APIConfig, CharacterProfile, DialogueApiConfig} from '../types';
import type {FriendFeedSettings} from '../utils/friendFeedSettings';
import {resolveDialogueApi} from '../utils/characterApi';

export default function FriendFeedSetup({characters,api,appApi,settings,onApi,onCharacters,onPreferences,onWeibo,onDone,busy}: {
    characters:CharacterProfile[];api?:APIConfig;appApi?:DialogueApiConfig|null;settings:FriendFeedSettings;busy:boolean;
    onApi:()=>void;onCharacters:()=>void;onPreferences:(section:'accounts'|'interaction')=>void;onWeibo:()=>void;onDone:()=>void;
}) {
    const deadline=useRef(performance.now()+10_000);
    const [remaining,setRemaining]=useState(10);
    useEffect(()=>{
        const tick=()=>{const seconds=Math.max(0,Math.ceil((deadline.current-performance.now())/1000));setRemaining(seconds);return seconds;};
        const timer=setInterval(()=>{if(tick()===0)clearInterval(timer);},250);
        return()=>clearInterval(timer);
    },[]);
    const participants=characters.filter(c=>(settings.characterWeights[c.id]??10)>0);
    const ready=participants.filter(c=>{const config=resolveDialogueApi(api||{} as APIConfig,c,appApi);return !!config.baseUrl?.trim()&&!!config.model?.trim();}).length;
    const emotion=participants.filter(c=>c.emotionConfig?.enabled).length;
    return <section className="ff-setup" aria-label="哔哔入门引导">
        <header><BibiIcon size={60}/><div><small>第一次来，先打个招呼</small><h2>把你的小广场准备好</h2></div></header>
        <p>自己发图文不用 API。想让朋友们发动态、接话，先选好 API；其余按自己的喜好调整。</p>
        <ol>
            <li><div><strong>哔哔 API</strong><span>{appApi?'已使用哔哔独立 API。':'当前跟随角色 API，未设置则跟随全局。'}{participants.length?`${ready}/${participants.length} 位参与角色已填写地址和模型`:'添加角色后检查配置'}，尚未测试连通性。可以在这里单独选一份。</span></div><button type="button" onClick={onApi}>选择 API</button></li>
            <li><div><strong>朋友与小号</strong><span>当前 {participants.length} 位角色参与。可以设置抽取权重、话题标签、小号和路人比例；权重为 0 的角色不参与抽取。</span></div><button type="button" onClick={characters.length?()=>onPreferences('accounts'):onCharacters}>{characters.length?'调整朋友':'添加角色'}</button></li>
            <li><div><strong>互动与图片</strong><span>刷新首页、发表评论会调用一次对话 API。自主刷帖搭情绪副 API 的便车，概率 20%；当前 {emotion} 位参与角色已开启情绪功能。分享配图需要模型支持识图。</span></div><button type="button" onClick={()=>onPreferences('interaction')}>设置互动</button></li>
            <li><div><strong>真实微博 · 可选</strong><span>想混入真实帖子再扫码连接自己的账号。使用公共代理无需自己部署；角色阅读真实内容需另行开启；评论只留在本地。</span></div><button type="button" onClick={onWeibo}>连接微博</button></li>
        </ol>
        <p className="ff-setup-note">角色实际发帖、评论和转发会留下轻量记忆卡；单纯同步微博不会写成角色记忆。这里只检查配置，不会自动生成内容或测试 API。</p>
        <button type="button" className="friend-feed-primary" disabled={busy||remaining>0} onClick={()=>{if(!busy&&performance.now()>=deadline.current)onDone();}}>{busy?'正在保存…':remaining>0?`请先阅读 · ${remaining}s`:'知道了，开始逛'}</button>
        <small>以后可以从哔哔设置重新打开这份引导。</small>
    </section>;
}
