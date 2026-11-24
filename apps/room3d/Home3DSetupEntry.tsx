import React, {useEffect, useRef, useState} from 'react';
import {useOS} from '../../context/OSContext';
import Home3DEntry from './Home3DEntry';
import HomeFigureStudio from '../../components/character/HomeFigureStudio';
import {isHomeDefinition} from './homeDefinition';
import {isScheduleFeatureOn, generateDailyScheduleForChar, isScheduleGeneratingFor} from '../../utils/scheduleGenerator';
import {getDailyScheduleForChar} from '../../utils/dailySchedule';
import {hasHomeSchedulePositions} from '../../utils/homeSchedule';
import {createStarterHome} from './starterHome.js';
import {HomePalettePicker} from './HomePalettePicker';
import {markAmsgStateDirty} from '../../utils/amsgStateSync';
import TokenImg from '../../components/os/TokenImg';
import {UserCircle,CheckCircle} from '@phosphor-icons/react';

export default function Home3DSetupEntry(props: React.ComponentProps<typeof Home3DEntry>) {
    const {userProfile, apiConfig, groups, realtimeConfig} = useOS();
    const char = props.character;
    const homely = props.presentation === 'homely';
    const [figureOwner, setFigureOwner] = useState<'user' | 'char' | 'choose' | null>(null);
    const [needsSchedule, setNeedsSchedule] = useState<boolean | null>(null);
    const [skipSchedule, setSkipSchedule] = useState(false);
    const [busy, setBusy] = useState(false), [error, setError] = useState('');
    const [retry, setRetry] = useState(0);
    const alive = useRef(true);
    useEffect(() => {alive.current = true; return () => {alive.current = false;};}, []);
    const defined = isHomeDefinition(char?.homeDefinition);
    const hasRooms = !!char?.home3D?.rooms.length;
    const onChange = useRef(props.onChange); onChange.current = props.onChange;
    const choosePalette = async (palette:string) => {
        if(busy)return;setBusy(true);setError('');
        try {
            const response=await fetch(`${import.meta.env.BASE_URL}room3d/catalog.json`);
            if(!response.ok)throw Error('房间素材加载失败');
            const catalog=await response.json();
            if(alive.current)onChange.current(createStarterHome(catalog,palette));
        }catch(e){if(alive.current)setError(String(e));}
        finally{if(alive.current)setBusy(false);}
    };
    const roomKey = char?.home3D?.rooms.map(room => room.id).join('|');
    useEffect(() => {
        let cancelled = false; setNeedsSchedule(null);
        if (!char || !defined || !hasRooms) return;
        if (!isScheduleFeatureOn(char)) {setNeedsSchedule(false); return;}
        getDailyScheduleForChar(char).then(schedule => {if (!cancelled) setNeedsSchedule(!hasHomeSchedulePositions(schedule, char));})
            .catch(() => {if (!cancelled) {setError('日程读取失败，请重试。'); setNeedsSchedule(null);}});
        return () => {cancelled = true;};
    }, [char?.id, char?.scheduleFeatureEnabled, char?.scheduleStyle, defined, roomKey, retry]);
    const regenerate = async () => {
        if (!char || busy) return;
        // 聊天那边（含云端）正在生成这个角色的日程时不另起一份：晚到的那份会把这里刚生成的盖掉。
        if (isScheduleGeneratingFor(char.id)) {setError('这个角色的日程正在生成，稍等片刻再试。'); return;}
        if (!apiConfig.apiKey || !apiConfig.baseUrl || !apiConfig.model) {setError('请先在设置中配置聊天 API，再补全日程。'); return;}
        setBusy(true); setError('');
        try {
            const result = await generateDailyScheduleForChar(char, userProfile, apiConfig, true);
            if (!result) throw Error('生成未完成或部分日程缺少房间，原日程已保留。请重试。');
            markAmsgStateDirty({char, userProfile, groups, realtimeConfig});
            if (alive.current) setNeedsSchedule(false);
        } catch (e) {if (alive.current) setError(e instanceof Error ? e.message : String(e));}
        finally {if (alive.current) setBusy(false);}
    };
    if (!char) return <Home3DEntry {...props} />;
    const charReady = !!char.chibiStudio?.home3D?.state, userReady = homely || !!userProfile.chibiStudio?.home3D?.state;
    const residents = homely ? [] : [
        ...(userReady ? [{id: 'user', label: userProfile.name || '你', state: userProfile.chibiStudio!.home3D!.state, hair: userProfile.chibiStudio!.home3D!.hair}] : []),
        ...(props.residents ?? []).filter(resident => resident.id !== 'user'),
    ];
    let gate: React.ReactNode;
    const button = 'min-h-[48px] w-full rounded-xl border border-[#b0b0b0] px-4 py-3 mt-3 disabled:opacity-40';
    if (!charReady || !userReady || !hasRooms || needsSchedule === null || needsSchedule && !skipSchedule) {
        gate = <section className="home-definition"><div className="home-definition-content">
            <button className="home-definition-back" disabled={busy} onClick={props.onBack}>返回</button>
            <p className="home-definition-eyebrow">入住 · {!charReady || !userReady?'认识住客':'安排日常'}</p>
            <h1>{!charReady || !userReady ? '谁住在这里？' : '让日程找到房间'}</h1>
            {!charReady || !userReady ? <><p className="home-definition-intro">{homely?'为角色准备一份家园形象，就可以面对面相处。':'各选一份形象，也可以沿用手办柜里的自己。'}</p>
                <div className="home-resident-choices">{[{id:'char' as const,name:char.name,ready:charReady,img:char.chibiStudio?.home3D?.img??char.sprites?.chibi},{id:'user' as const,name:userProfile.name||'你',ready:userReady,img:userProfile.chibiStudio?.home3D?.img??userProfile.vrState?.chibi?.img}].filter(owner=>!homely||owner.id==='char').map(owner=><button key={owner.id} onClick={()=>setFigureOwner(owner.id)} aria-label={`${owner.id==='char'?char.name:'你'}的形象 · ${owner.ready?'已准备好，可修改':'去捏人'}`}><span className="home-resident-preview">{owner.img?<TokenImg value={owner.img}/>:<UserCircle size={76} weight="thin"/>}</span><strong>{owner.name}</strong><span>{owner.ready?<><CheckCircle/>准备好了</>:'选择形象'}</span></button>)}</div><p className="home-onboarding-footnote">{homely?'你就是镜头另一边的人。':'保存一位，就接着准备另一位。'}</p></> : !hasRooms || needsSchedule === null ? <p>正在读取房间与日程…</p> : <>
                <p className="home-definition-intro">{char.name}的旧日程还没标房间。补全后，在家和外出都会同步到这里。</p>
                <p className="home-onboarding-footnote">调用一次 API；成功后替换今天的日程。</p>
                <button className="home-definition-submit" disabled={busy} onClick={() => void regenerate()}>{busy ? '正在生成日程…' : '重新生成并补全位置'}</button>
                <button className={button} disabled={busy} onClick={() => setSkipSchedule(true)}>稍后再生成，先看看家园</button></>}
            {error && <div role="alert" className="mt-4 text-sm text-red-700">{error}<button className={button} disabled={busy} onClick={() => {setError(''); setRetry(n => n + 1);}}>重新检查</button></div>}
        </div></section>;
    }
    if(!hasRooms&&charReady&&userReady)gate=<section className="home-definition"><div className="home-definition-content"><button className="home-definition-back" onClick={props.onBack}>返回</button><HomePalettePicker busy={busy} onChoose={id=>void choosePalette(id)}/>{error&&<p role="alert">{error}</p>}</div></section>;
    return <><Home3DEntry {...props} suspended={props.suspended||figureOwner!==null} user={userProfile} api={apiConfig} conversationContext={{groups,realtimeConfig}} residents={residents} beforeEnter={gate} onFigures={() => setFigureOwner(homely?'char':'choose')} />
        {figureOwner==='choose'?<div className="home-cabinet-choose" role="dialog" aria-label="双方手办柜"><button className="home-definition-back" onClick={()=>setFigureOwner(null)}>返回家园</button><h2>打开谁的手办柜？</h2><div className="home-resident-choices"><button onClick={()=>setFigureOwner('char')}><UserCircle size={52}/><strong>{char.name}</strong></button><button onClick={()=>setFigureOwner('user')}><UserCircle size={52}/><strong>{userProfile.name||'你'}</strong></button></div></div>:figureOwner&&<HomeFigureStudio key={figureOwner} charId={figureOwner === 'char' ? char.id : undefined} onClose={() => setFigureOwner(null)} startEditing={figureOwner === 'char' ? !charReady : !userReady} />}
    </>;
}
