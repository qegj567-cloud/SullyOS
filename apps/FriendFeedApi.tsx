import React, {useEffect, useRef, useState} from 'react';
import type {DialogueApiConfig} from '../types';
import {useOS} from '../context/OSContext';
import {pickDialogueApi} from '../utils/characterApi';
import {readFriendFeedApi, saveFriendFeedApi} from '../utils/friendFeedApi';
import {configFromPreset, findActivePresetId} from '../utils/apiPresetSwitch';
import {extractModelIds} from '../utils/modelList';
import DialogueApiFields from '../components/settings/DialogueApiFields';
import ApiPresetGroups from '../components/settings/ApiPresetGroups';
import ModelPicker from '../components/settings/ModelPicker';

export default function FriendFeedApi({onSaved, onBack}: {onSaved:()=>void;onBack:()=>void}) {
    const {apiConfig, apiPresets=[]} = useOS();
    const [draft,setDraft]=useState<DialogueApiConfig>({baseUrl:'',apiKey:'',model:''});
    const [independent,setIndependent]=useState(false),[loaded,setLoaded]=useState(false),[saving,setSaving]=useState(false);
    const [models,setModels]=useState<string[]>([]),[loading,setLoading]=useState(false),[picker,setPicker]=useState(false),[model,setModel]=useState('');
    const [error,setError]=useState('');
    const version=useRef(0);
    useEffect(()=>{let alive=true;void readFriendFeedApi().then(value=>{if(alive){setIndependent(!!value);setDraft(pickDialogueApi(value||apiConfig||{baseUrl:'',apiKey:'',model:''}));setLoaded(true);}}).catch(e=>{if(alive){setError(e.message);setLoaded(true);}});return()=>{alive=false;version.current++;};},[]);
    const change=(patch:Partial<DialogueApiConfig>)=>{version.current++;setLoading(false);setError('');if(patch.baseUrl!==undefined||patch.apiKey!==undefined)setModels([]);setDraft(v=>({...v,...patch}));};
    const fetchModels=async()=>{
        const config=pickDialogueApi(draft),id=++version.current;setLoading(true);setError('');
        try{const res=await fetch(`${config.baseUrl}/models`,{headers:{Authorization:`Bearer ${config.apiKey||'sk-none'}`}});
            if(!res.ok)throw Error(`HTTP ${res.status}`);
            const next=extractModelIds(await res.json());if(id!==version.current)return;
            setModels(next);setModel(config.model||next[0]||'');setPicker(true);
        }catch(e){if(id===version.current)setError(`读取模型失败：${e instanceof Error?e.message:'请检查配置'}`);}
        finally{if(id===version.current)setLoading(false);}
    };
    const save=async()=>{
        if(saving||!loaded)return;
        const config=pickDialogueApi(draft);
        if(independent){try{const url=new URL(config.baseUrl);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||!config.model)throw Error();}
            catch{setError('请填写有效的 HTTP / HTTPS API 地址和模型');return;}}
        setSaving(true);setError('');
        try{await saveFriendFeedApi(independent?config:null);onSaved();}catch(e){setError(e instanceof Error?e.message:'保存失败');}finally{setSaving(false);}
    };
    const active=findActivePresetId(apiPresets,draft);
    return <div className="friend-feed-form ff-settings-page" aria-label="哔哔 API 配置">
        <header className="ff-settings-intro"><h2>哔哔用哪个 API？</h2><p>用于首页刷新、刷新评论区和用户评论后的即时接话。</p></header>
        <label className="ff-toggle-row"><span>使用哔哔独立 API<small>关闭时优先使用本次角色的独立 API，未设置则使用全局 API。</small></span><input type="checkbox" checked={independent} disabled={!loaded||saving} onChange={e=>{version.current++;setLoading(false);setIndependent(e.target.checked);setError('');}}/></label>
        {independent&&<fieldset disabled={!loaded||saving} className="space-y-4 border-0 min-w-0">
            {!!apiPresets.length&&<div><h3>从已有预设选一份</h3><ApiPresetGroups presets={apiPresets}>{preset=><button type="button" key={preset.id} className="ff-setting-link" aria-pressed={active===preset.id} onClick={()=>change(pickDialogueApi(configFromPreset(preset)))}>{preset.name}{active===preset.id?' · 已选':''}</button>}</ApiPresetGroups><small>选择后点保存才生效，不修改全局或角色配置。</small></div>}
            <DialogueApiFields value={draft} onChange={change} fetchModels={()=>void fetchModels()} isLoadingModels={loading} openModelPicker={()=>{setModel(draft.model);setPicker(true);}}/>
            {picker&&<section aria-label="选择哔哔模型"><ModelPicker availableModels={models} localModel={model} setLocalModel={setModel} confirmModelPicker={value=>{change({model:value});setPicker(false);}}/><button type="button" onClick={()=>setPicker(false)}>取消选模型</button></section>}
        </fieldset>}
        <p className="friend-feed-settings-hint">主回复里顺带互动仍用本次主 API；20% 自主浏览仍搭情绪副 API 的便车。分享图片沿聊天的识图配置处理。</p>
        {error&&<p role="alert" className="friend-feed-error">{error}</p>}
        <div className="friend-feed-form-actions"><button type="button" disabled={saving} onClick={onBack}>取消</button><button type="button" className="friend-feed-primary" disabled={!loaded||saving} onClick={()=>void save()}>{saving?'正在保存…':'保存 API 设置'}</button></div>
    </div>;
}
