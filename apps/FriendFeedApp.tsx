import {FRIEND_POST_TEXT_LIMIT, FRIEND_COMMENT_TEXT_LIMIT} from '../utils/friendFeedLimits';
import {friendPostMediaCount} from '../utils/friendFeedImages';
import React, {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {trackBibiEntry, trackBibiFeature} from '../utils/octoberAnalytics';
import {ArrowLeft, ChatCircle, CircleNotch, ArrowClockwise, GearSix, Plus} from '@phosphor-icons/react';
import BibiIcon from '../components/os/BibiIcon';
import FriendFeedImagePicker from './FriendFeedImagePicker';
import FriendFeedSetup from './FriendFeedSetup';
import FriendFeedCoverEditor from './FriendFeedCover';
import FriendFeedApi from './FriendFeedApi';
import FriendFeedInbox, {FriendFeedInboxButton} from './FriendFeedInbox';
import {friendUserInbox, markFriendInboxRead, consumeFriendInbox, subscribeFriendInboxOpen} from '../utils/friendFeedInbox';
import './friendFeedInbox.css';
import {readFriendFeedApi} from '../utils/friendFeedApi';
import type {DialogueApiConfig} from '../types';
import {putImageBlob} from '../utils/blobRef';
import {AppID} from '../types';
import './friendFeedCompose.css';
import {useOS} from '../context/OSContext';
import {useLocalBackHandler} from '../hooks/useLocalBackHandler';
import {commentOnFriendPost, editFriendComment, deleteFriendComment, deleteFriendPost, emptyFriendFeed, publishFriendPost, readFriendFeed,
    ensurePublicFriendFeed, mutateFriendFeed, saveFriendFeedSettings, subscribeFriendFeed} from '../utils/friendFeed';
import type {FriendReplyTarget} from '../utils/friendFeed';
import {defaultFriendFeedSettings, resolveFriendFeedSettings} from '../utils/friendFeedSettings';
import {ClassicHeader, ClassicCover, ClassicProfile, ClassicPost, ClassicComposer} from './FriendFeedClassicUI';
import FriendFeedPreferences from './FriendFeedPreferences';
import FriendFeedSettingsMenu, {preferenceTitles, type PreferenceSection} from './FriendFeedSettingsMenu';
import {FriendFeedDirectoryProvider} from './FriendFeedGroupedList';
import FriendFeedRelations from './FriendFeedRelations';
import {friendAccountName,friendAccountRef} from '../utils/friendFeedGraph';
import {FriendFeedWeiboConnection,FriendFeedProfileControls,FriendFeedWeiboTimeline} from './FriendFeedWeibo';
import FriendFeedWeiboBrowser from './FriendFeedWeiboBrowser';
import FriendFeedWeiboHome,{openWeiboOriginalProfile,type WeiboHomeBatch} from './FriendFeedWeiboHome';
import FriendFeedMyWeibo from './FriendFeedMyWeibo';
import type {FriendFeedSource} from '../utils/friendFeedSource';
import {syncedPostEnabled} from '../utils/friendFeedActivity';
import {runImmediateFriendReplies} from '../utils/friendFeedReplies';
import {SocialHeader,SocialBottomNav,SocialProfile,SocialToolbar,SocialComposer,SocialPost} from './FriendFeedSocialUI';
import FriendFeedPostDetail from './FriendFeedPostDetail';
import FriendFeedSharePanel from './FriendFeedSharePanel';
import FriendFeedFollowing, {useWeiboFollowing} from './FriendFeedFollowing';
import {useFriendFeedPullRefresh} from './useFriendFeedPullRefresh';
import 'animal-island-ui/style';
import './friendFeed.css';
import './friendFeedSettings.css';
import './friendFeedSocialThemes.css';
import './friendFeedClassicThemes.css';
import './friendFeedNavigation.css';

export interface FriendFeedProps {embedded?: boolean; initialCharacterId?: string; onBack?: () => void}
type Panel = {kind: 'post'; circleId: string}
    | {kind:'weibo-detail';post:FriendFeedSource} | {kind:'weibo-home'}
    | {kind:'cover';ownerId:string}
    | {kind:'edit-comment'|'delete-comment';postId:string;commentId:string;original:string;authorName:string}
    | {kind: 'comment'; postId: string; replyTarget?:FriendReplyTarget} | {kind:'share';postId:string} | {kind:'detail';postId:string;focusComment?:{id:string}} | {kind: 'delete'; postId: string} | {kind: 'settings'; section?: PreferenceSection} | {kind:'inbox'} | {kind:'api'} | {kind: 'weibo'} | {kind:'sources'} | {kind:'following'} | {kind:'relations'};

export default function FriendFeedApp({embedded = false, initialCharacterId, onBack}: FriendFeedProps) {
    const {characters, characterGroups = [], userProfile, closeApp, openApp, apiConfig, realtimeConfig} = useOS();
    const [feed, setFeed] = useState(emptyFriendFeed), [loaded, setLoaded] = useState(false);
    const [limit, setLimit] = useState(5);
    const [panel, setPanel] = useState<Panel>(), [body, setBody] = useState('');
    const [draftImages,setDraftImages]=useState<Blob[]>([]),[processingImages,setProcessingImages]=useState(false);
    const [showSetup,setShowSetup]=useState(false);
    const [appApi,setAppApi]=useState<DialogueApiConfig|null>(null);
    const [settingsSection,setSettingsSection]=useState('');
    const [returnToInbox,setReturnToInbox]=useState(false);
    const panelHistory = useRef<{panel?: Panel; profileId: string; showSetup: boolean; section: string; scrollTop: number}[]>([]);
    const restoredScroll = useRef<number>();
    const [profileFromFollowing,setProfileFromFollowing]=useState(false);
    const profileFromPanel = useRef(false);
    const [relationsOwner,setRelationsOwner]=useState('user');
    const [weiboBindingOwner,setWeiboBindingOwner]=useState('user');
    const [returnToPost,setReturnToPost]=useState(''),[profileReturnPost,setProfileReturnPost]=useState('');
    const detailOriginProfile=useRef('');
    const weiboFollowing=useWeiboFollowing();
    const weiboHomeCache=useRef<WeiboHomeBatch>();
    const [profileId,setProfileId]=useState('');
    const [refreshing,setRefreshing]=useState(false), [refreshStatus,setRefreshStatus]=useState('');
    const [refreshTarget,setRefreshTarget]=useState('');
    const refreshRunning=useRef(false);
    const weiboRefreshRunning=useRef(false);
    const hasWeiboSources=feed.weiboStreams?.some(s=>s.enabled)||feed.weiboBindings?.some(b=>b.enabled)||weiboFollowing.connection&&!feed.weiboStreams?.length;
    const refreshHome=async(postId?:string)=>{
        if(refreshRunning.current||feed.refreshLease&&feed.refreshLease.until>Date.now()){
            if(postId||!hasWeiboSources||weiboRefreshRunning.current)return;
            weiboRefreshRunning.current=true;setError('');
            try{const {refreshFriendWeibo}=await import('../utils/friendFeedRefresh');const result=await refreshFriendWeibo(status=>{if(alive.current)setRefreshStatus(status);});
                if(alive.current){setRefreshStatus(result.message+'；角色 API 仍在处理');if(result.warnings.length)setError(result.warnings.join('；'));}}
            catch(e){if(alive.current)setError(e instanceof Error?e.message:'微博刷新失败');}
            finally{weiboRefreshRunning.current=false;}
            return;
        }
        refreshRunning.current=true;setRefreshing(true);setError('');
        setRefreshTarget(postId||'');setRefreshStatus('正在刷新…');
        try {const {refreshFriendFeed}=await import('../utils/friendFeedRefresh');const result=await refreshFriendFeed(userProfile,apiConfig,realtimeConfig,status=>{if(alive.current)setRefreshStatus(status);},Math.random,postId);
            if(alive.current){setRefreshStatus(result.message);if(result.warnings.length)setError([...new Set(result.warnings)].join('；'));setLimit(5);}}
        catch(e){if(alive.current){setRefreshStatus('');setError(e instanceof Error?e.message:'刷新失败');}}
        finally{refreshRunning.current=false;if(alive.current)setRefreshing(false);}
    };
    const [settingsDraft, setSettingsDraft] = useState(defaultFriendFeedSettings);
    const preferenceSection = panel?.kind === 'settings' ? panel.section : undefined;
    const settingsPageTitle = panel?.kind === 'settings' ? (preferenceSection ? preferenceTitles[preferenceSection] : '哔哔设置')
        : panel?.kind === 'api' ? '哔哔 API 设置' : panel?.kind === 'sources' ? '微博与真实内容'
        : panel?.kind === 'weibo-detail' ? '微博详情' : panel?.kind === 'weibo-home' ? '微博首页'
        : panel?.kind === 'weibo' ? '微博连接' : panel?.kind === 'relations' ? '关注与身份关系' : panel?.kind === 'cover' ? '主页封面' : '';
    const settings = preferenceSection ? settingsDraft : resolveFriendFeedSettings(feed.settings);
    const displayUser={...userProfile,name:settings.userNickname||settings.weiboProfile?.name||userProfile.name,
        avatar:settings.weiboProfile?.avatar||userProfile.avatar};
    const displayCharacters=characters.map(c=>({...c,name:settings.identities[c.id]?.nickname||c.name}));
    const theme = embedded ? 'island' : settings.theme;
    const social=theme==='weibo'||theme==='twitter';
    const [postFilter,setPostFilter]=useState<'all'|'photos'>('all');
    // Presentation only: never persisted as a model-reading or source permission.
    const [sourceFilter,setSourceFilter]=useState<'all'|'weibo'|'local'>('all');
    useEffect(()=>{setSourceFilter(settings.hideRealPosts?'local':'all');},[settings.hideRealPosts]);
    const [error, setError] = useState(''), [busy, setBusy] = useState(false);
    const alive = useRef(true), saving = useRef(false), loadVersion = useRef(0), actionButton = useRef<HTMLButtonElement>(null);
    const scroller = useRef<HTMLDivElement>(null);
    const pullDistance=useFriendFeedPullRefresh(scroller,loaded&&(!panel&&!profileId||panel?.kind==='detail')&&(!refreshing&&!(feed.refreshLease&&feed.refreshLease.until>Date.now())||!panel&&!profileId&&!!hasWeiboSources),()=>void refreshHome(panel?.kind==='detail'?panel.postId:undefined));
    const navigateProfile=(id:string)=>{
        if(!id&&!profileId&&!panel)void refreshHome();
        panelHistory.current=[];
        profileFromPanel.current=false;
        setProfileId(id);setProfileFromFollowing(false);setProfileReturnPost('');setPanel(undefined);setPostFilter('all');
        if(scroller.current)scroller.current.scrollTop=0;
    };
    useEffect(()=>{if(!refreshStatus||refreshing)return;const timer=setTimeout(()=>setRefreshStatus(''),6000);return()=>clearTimeout(timer);},[refreshStatus,refreshing]);
    const [retry, setRetry] = useState(0);
    const countedEntry = useRef(false);
    useEffect(() => {
        if (loaded && !countedEntry.current) { countedEntry.current = true; trackBibiEntry(embedded ? 'phone' : 'app'); }
    }, [loaded, embedded]);
    const [replying, setReplying] = useState('');
    const replyRunning = useRef(false);
    const runReplies = async (postId: string, triggerId?: string) => {
        if (replyRunning.current) return;
        replyRunning.current = true; setReplying(postId); setError('');
        try {const result = await runImmediateFriendReplies(postId, userProfile, apiConfig, realtimeConfig, triggerId);
            if(alive.current)setRefreshStatus(result.commentCount ? '新回复已送达' : '这次没有人接话');}
        catch (e) {if (alive.current) setError(e instanceof Error ? e.message : '接话失败，可稍后重试');}
        finally {replyRunning.current = false; if (alive.current) setReplying('');}
    };
    useEffect(() => {
        alive.current = true;
        const refresh = async () => {
            const version = ++loadVersion.current;
            try { const next = await readFriendFeed(); if (alive.current && version === loadVersion.current) {setFeed(next); setLoaded(true);} }
            catch (e) { if (alive.current && version === loadVersion.current) setError(e instanceof Error ? e.message : '读取失败，请重试'); }
        };
        void ensurePublicFriendFeed().then(refresh).catch(e=>{if(alive.current)setError(e instanceof Error?e.message:'公共广场初始化失败');});
        const stop = subscribeFriendFeed(() => void refresh());
        return () => {alive.current = false; loadVersion.current++; stop();};
    }, [retry]);
    useEffect(()=>{if(!feed.refreshLease)return;const timer=setTimeout(()=>setFeed(current=>({...current})),Math.max(0,feed.refreshLease.until-Date.now())+50);return()=>clearTimeout(timer);},[feed.refreshLease?.until]);
    const circle = feed.circles[0];
    const profileRef=feed.accountGraph?.accounts.find(a=>a.id===profileId);
    const profileOwner=profileRef?.ownerId||profileId, profileAccount=profileRef?.accountId||'main';
    const accountProfile=(id:string,accountId='main')=>id==='user'?'user':friendAccountRef(feed,{authorId:id,accountId})?.id||id;
    const profileAvatar=profileAccount==='main'?(profileOwner==='user'?displayUser.avatar:characters.find(c=>c.id===profileOwner)?.avatar):undefined;
    const profilePosts = feed.posts.filter(p => (!profileId || p.authorId===profileOwner&&(p.accountId||'main')===profileAccount) && syncedPostEnabled(feed,p)
        && (!settings.hideRealPosts || sourceFilter==='weibo' || !(p.synced || p.authorKind==='external'))).sort((a,b)=>b.createdAt-a.createdAt);
    const posts=profilePosts.filter(p=>(!social||postFilter==='all'||!!friendPostMediaCount(p))
        &&(sourceFilter==='all'||sourceFilter==='weibo'&&p.source?.platform==='weibo'&&(p.synced||p.authorKind==='external')
            ||sourceFilter==='local'&&!(p.synced||p.authorKind==='external')));
    const profileName=profileRef?friendAccountName(feed,profileRef,characters,displayUser.name):profileOwner==='user'?displayUser.name||'我':displayCharacters.find(c=>c.id===profileOwner)?.name||feed.posts.find(p=>p.authorId===profileOwner)?.authorName||'主页';
    useEffect(() => {setLimit(5);}, [circle?.id]);
    useLayoutEffect(() => {
        if (scroller.current) scroller.current.scrollTop = restoredScroll.current ?? 0;
        restoredScroll.current = undefined;
    }, [circle?.id, panel?.kind, preferenceSection, profileId, showSetup]);
    useLayoutEffect(()=>{if(panel?.kind!=='settings'||!settingsSection)return;
        const target=scroller.current?.querySelector<HTMLElement>(`[data-setup-section="${settingsSection}"]`);
        target?.scrollIntoView?.({block:'start'});target?.focus({preventScroll:true});
    },[panel?.kind,preferenceSection,settingsSection]);
    useEffect(()=>{let active=true;void readFriendFeedApi().then(value=>{if(active)setAppApi(value);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[panel?.kind]);
    useEffect(() => {setLimit(5);}, [profileId]);
    useEffect(()=>{setPostFilter('all');},[profileId,circle?.id]);
    useEffect(()=>{setProfileId('');},[circle?.id]);
    const rememberPage = () => panelHistory.current.push({panel, profileId, showSetup, section: settingsSection, scrollTop: scroller.current?.scrollTop ?? 0});
    const restorePage = () => {
        const previous = panelHistory.current.pop();
        if (!previous) return false;
        restoredScroll.current = previous.scrollTop;
        setPanel(previous.panel); setProfileId(previous.profileId); setShowSetup(previous.showSetup);
        setSettingsSection(previous.section); setError('');
        return true;
    };
    const back = () => {if (saving.current||processingImages) return;
        if ((panel || showSetup) && restorePage()) return;
        if (!panel && profileFromPanel.current) {profileFromPanel.current=false; if (restorePage()) return;}
        if (showSetup && !panel) {setShowSetup(false); setError('');}
        else if((panel?.kind==='comment'||panel?.kind==='share')&&returnToPost){setPanel({kind:'detail',postId:returnToPost});setReturnToPost('');setError('');}
        else if(panel?.kind==='detail'&&returnToInbox){setPanel({kind:'inbox'});setReturnToInbox(false);setError('');}
        else if (panel) {setPanel(undefined); setError(''); actionButton.current?.focus();}
        else if(profileReturnPost){setPanel({kind:'detail',postId:profileReturnPost});setProfileId(detailOriginProfile.current);setProfileReturnPost('');}
        else if(profileId&&profileFromFollowing){setProfileId('user');setPanel({kind:'following'});setProfileFromFollowing(false);}
        else if(profileId)setProfileId('');else (onBack || closeApp)();};
    useLocalBackHandler(() => {back(); return true;}, embedded ? 75 : 30, embedded || !!panel || !!profileId || showSetup);
    const open = (requested: Panel) => {
        const next:Panel=requested.kind==='weibo'||requested.kind==='settings'&&requested.section==='content'?{kind:'sources'}:requested;
        if(next.kind==='sources'&&panel?.kind==='sources'){scroller.current?.querySelector('.friend-feed-weibo-connection')?.scrollIntoView?.({block:'start'});return;}
        if(next.kind==='sources')setWeiboBindingOwner(profileOwner==='user'||characters.some(c=>c.id===profileOwner)?profileOwner:'user');
        trackBibiFeature(next.kind);
        rememberPage();
        setSettingsSection('');
        if(next.kind==='detail'){detailOriginProfile.current=profileId;setReturnToInbox(panel?.kind==='inbox');}
        setReturnToPost((next.kind==='comment'||next.kind==='share')&&panel?.kind==='detail'?panel.postId:'');
        setError(''); setBody(''); setDraftImages([]); setPanel(next);
        if (next.kind === 'settings') setSettingsDraft(resolveFriendFeedSettings(feed.settings));
    };
    const openRealProfile=(id:string)=>{
        const owner=feed.accountGraph?.accounts.find(a=>a.id===id)?.ownerId||id;
        const uid=/^weibo:(\d{4,25})$/.exec(owner)?.[1]||(owner.startsWith('external:weibo:')?feed.posts.find(p=>p.authorId===owner)?.source?.accountId:undefined);
        if(!uid)return false;
        openWeiboOriginalProfile(uid);return true;
    };
    const saveRealContent=async(next:typeof settings)=>{
        if(saving.current)return;saving.current=true;setBusy(true);setError('');
        try{await mutateFriendFeed(state=>{state.settings={...resolveFriendFeedSettings(state.settings),realContentEnabled:next.realContentEnabled,shareImagesEnabled:next.shareImagesEnabled,hideRealPosts:next.hideRealPosts};});}
        catch(e){if(alive.current)setError(e instanceof Error?e.message:'保存失败');}
        finally{saving.current=false;if(alive.current)setBusy(false);}
    };
    const inbox=friendUserInbox(feed), unread=inbox.filter(row=>!row.notice.read).length;
    useEffect(()=>{
        if(embedded||!loaded)return;
        const receive=()=>{const target=consumeFriendInbox();if(!target)return;
            panelHistory.current=[];
            setProfileId('');setPostFilter('all');setError('');setReturnToPost('');setReturnToInbox(!!target.postId);
            detailOriginProfile.current='';setPanel(target.postId?{kind:'detail',postId:target.postId,focusComment:target.commentId?{id:target.commentId}:undefined}:{kind:'inbox'});
        };
        const stop=subscribeFriendInboxOpen(receive);receive();return stop;
    },[embedded,loaded]);
    const readVisibleComments=useCallback((commentIds:string[])=>{
        if(panel?.kind!=='detail'||!loaded)return;
        const visible=new Set(commentIds);
        const ids=friendUserInbox(feed).filter(row=>row.notice.postId===panel.postId&&!row.notice.read&&visible.has(row.notice.commentId)).map(row=>row.notice.id);
        if(ids.length)void markFriendInboxRead(ids).catch(e=>{if(alive.current)setError(e instanceof Error?e.message:'标记已读失败');});
    },[panel,loaded,feed]);
    const inboxButton=<FriendFeedInboxButton unread={unread} onClick={()=>open({kind:'inbox'})}/>;
    const submit = async (event: React.FormEvent) => {
        event.preventDefault();
        if (!panel || saving.current || processingImages) return;
        if (panel.kind === 'settings' && !panel.section) return;
        saving.current = true; setBusy(true); setError('');
        try {
            if (panel.kind === 'settings') await saveFriendFeedSettings(settingsDraft);
            else if (panel.kind === 'post') {
                const images=[];
                for(const blob of draftImages){const url=await putImageBlob(blob);images.push({url,thumbnail:url});}
                await publishFriendPost(panel.circleId, userProfile.name || '我', body, undefined, images);
                if(alive.current)setDraftImages([]);
            }
            else if (panel.kind === 'comment') {
                if (replyRunning.current) throw new Error('上一条评论正在接话，请等完成后再发送');
                const triggerId = await commentOnFriendPost(panel.postId, userProfile.name || '我', body, undefined, Math.random, panel.replyTarget);
                void runReplies(panel.postId, triggerId);
            }
            else if (panel.kind === 'edit-comment') await editFriendComment(panel.postId, panel.commentId, body, panel.original);
            else if (panel.kind === 'delete-comment') await deleteFriendComment(panel.postId, panel.commentId, panel.original);
            else if (panel.kind === 'delete') await deleteFriendPost(panel.postId);
            if (alive.current) {if (!restorePage()) setPanel(panel.kind==='comment'&&returnToPost?{kind:'detail',postId:returnToPost}:undefined); setReturnToPost('');setBody(''); actionButton.current?.focus();}
        } catch (e) {if (alive.current) setError(e instanceof Error ? e.message : '保存失败，请重试');}
        finally {saving.current = false; if (alive.current) setBusy(false);}
    };
    const commentPost=panel?.kind==='comment'?feed.posts.find(p=>p.id===panel.postId):undefined;
    const replyTarget=panel?.kind==='comment'?panel.replyTarget:undefined;
    const replyComment=replyTarget?.kind==='local'?commentPost?.comments.find(c=>c.id===replyTarget.id):replyTarget?.kind==='source'?commentPost?.weiboComments?.rows.find(c=>c.id===replyTarget.id):undefined;
    const followingProps=profileOwner==='user'?{onFollowing:()=>open({kind:'following'}),followingCount:feed.accountGraph?.follows[friendAccountRef(feed,{authorId:'user'})?.id||'']?.length||0}:{};
    const finishSetup=async()=>{
        if(saving.current)return;saving.current=true;setBusy(true);setError('');
        try{await mutateFriendFeed(state=>{state.setupSeen=true;});if(alive.current){if (!showSetup || !restorePage()) setShowSetup(false);}}
        catch(e){if(alive.current)setError(e instanceof Error?e.message:'保存失败');}
        finally{saving.current=false;if(alive.current)setBusy(false);}
    };
    return <FriendFeedDirectoryProvider><section className={`friend-feed${embedded ? ' friend-feed-embedded' : ''}`} aria-label="哔哔"
        data-layout={settings.layout} data-cover={settings.showCover} data-theme={theme}
        style={{'--ff-body-size': `${settings.fontSize}px`} as React.CSSProperties}>
        {social&&!panel ? <SocialHeader notifications={inboxButton} theme={theme} profileId={profileId} profileName={profileName} count={profilePosts.length}
            onBack={back} onProfile={navigateProfile} onSettings={()=>open({kind:'settings'})}/> : !panel ? <ClassicHeader backLabel={profileId || showSetup ? '返回上一级' : undefined} notifications={inboxButton} theme={theme as 'island'|'moments'|'insta'|'journal'} onBack={back} onSettings={()=>open({kind:'settings'})} onProfile={()=>navigateProfile('user')} onHome={()=>navigateProfile('')}/> : <header className={`friend-feed-header${settingsPageTitle?' ff-preferences-header':''}`}>
            <button type="button" aria-label="返回上一级" onClick={back} disabled={busy}><ArrowLeft size={21}/></button>
            <div>{settingsPageTitle?<h1>{settingsPageTitle}</h1>:<><h1><BibiIcon size={28}/>{panel.kind==='inbox'?'互动提醒':panel.kind==='detail'?'动态':panel.kind==='following'?'我的关注':'哔哔'}</h1><span>{panel.kind === 'inbox' ? '回复与留言' : panel.kind === 'detail' ? '评论区' : panel.kind === 'following' ? '角色与微博账号' : panel.kind === 'share' ? '分享给角色' : panel.kind === 'comment' ? '回应这条动态' : panel.kind === 'edit-comment' ? '编辑评论' : panel.kind === 'delete-comment' ? '删除评论' : panel.kind === 'delete' ? '删除动态' : '记录日常'}</span></>}</div>
            <div className="friend-feed-header-actions">{panel.kind!=='inbox'&&inboxButton}{!panel && loaded && <>
                <button type="button" aria-label="哔哔设置" onClick={() => open({kind: 'settings'})}><GearSix size={21}/></button>
                <button ref={actionButton} type="button" aria-label="发布新动态" disabled={!circle} onClick={() => circle&&open({kind: 'post',circleId:circle.id})}><Plus size={21}/></button>
            </>}</div>
        </header>}
        <div className="friend-feed-scroll" ref={scroller} tabIndex={0} aria-label="哔哔内容">
            {(pullDistance>0||!panel&&!profileId&&!refreshTarget&&refreshStatus)&&<div className="ff-pull-status" role="status" style={pullDistance?{height:pullDistance}:undefined}>
                <ArrowClockwise size={16} className={refreshing?'friend-feed-spinner':''}/>{pullDistance?(pullDistance>=42?'松开刷新':'下拉刷新'):refreshStatus}
            </div>}
            {error && <div className="friend-feed-error" role="alert">{error}{!loaded && <button onClick={() => {setError(''); setRetry(v => v + 1);}}>重试</button>}</div>}
            {!loaded && !error && <p className="friend-feed-loading" role="status"><CircleNotch className="friend-feed-spinner"/>正在读取哔哔…</p>}
            {loaded&&!panel&&(showSetup||!feed.setupSeen)&&<FriendFeedSetup characters={characters} api={apiConfig} appApi={appApi} settings={settings} busy={busy}
                onApi={()=>open({kind:'api'})} onCharacters={()=>openApp(AppID.Character)}
                onPreferences={section=>{open({kind:'settings',section});setSettingsSection(section);}} onWeibo={()=>open({kind:'weibo'})} onDone={()=>void finishSetup()}/>}
            {panel?.kind==='inbox'?<FriendFeedInbox feed={feed} onOpen={(postId,commentId)=>open({kind:'detail',postId,focusComment:{id:commentId}})} onReadAll={ids=>{void markFriendInboxRead(ids).catch(e=>setError(e instanceof Error?e.message:'标记已读失败'));}}/>
            : panel?.kind==='detail'?<FriendFeedPostDetail onReadVisible={readVisibleComments} key={panel.postId} focusComment={panel.focusComment} post={feed.posts.find(p=>p.id===panel.postId&&syncedPostEnabled(feed,p)&&(!settings.hideRealPosts||sourceFilter==='weibo'||!(p.synced||p.authorKind==='external')))} characters={displayCharacters} user={displayUser}
                onProfile={(id,accountId)=>{if(openRealProfile(id))return;setProfileReturnPost(panel.postId);setProfileId(accountProfile(id,accountId));setPanel(undefined);}} onComment={()=>open({kind:'comment',postId:panel.postId})}
                onShare={()=>open({kind:'share',postId:panel.postId})}
                onEdit={comment=>{open({kind:'edit-comment',postId:panel.postId,commentId:comment.id,original:comment.text,authorName:comment.authorName});setBody(comment.text);}}
                onDelete={comment=>open({kind:'delete-comment',postId:panel.postId,commentId:comment.id,original:comment.text,authorName:comment.authorName})}
                onReply={replyTarget=>open({kind:'comment',postId:panel.postId,replyTarget})}
                onRefresh={()=>void refreshHome(panel.postId)} busy={refreshing||!!feed.refreshLease&&feed.refreshLease.until>Date.now()} status={refreshTarget===panel.postId?refreshStatus:''}
                replying={replying===panel.postId}/>
            : panel?.kind==='share'?<FriendFeedSharePanel key={panel.postId} post={feed.posts.find(p=>p.id===panel.postId)} characters={characters} groups={characterGroups} imagesEnabled={settings.shareImagesEnabled} onBack={back}
                onBusy={value=>{saving.current=value;setBusy(value);}}/>
            : panel?.kind==='relations'?<FriendFeedRelations feed={feed} characters={characters} groups={characterGroups} user={userProfile} initialOwner={relationsOwner} onOwnerChange={setRelationsOwner} onProfile={id=>{rememberPage();profileFromPanel.current=true;setPanel(undefined);setProfileId(id);}}/>
            : panel?.kind==='following'?<FriendFeedFollowing feed={feed} user={displayUser} onManage={()=>open({kind:'relations'})} characters={characters} groups={characterGroups} weibo={weiboFollowing} onConnect={()=>open({kind:'weibo'})}
                onProfile={id=>{if(openRealProfile(id))return;setPanel(undefined);setProfileId(id);setProfileFromFollowing(true);}}/>
            : panel?.kind==='weibo-home'&&circle?<FriendFeedWeiboHome circleId={circle.id} mode={settings.weiboHomeMode} theme={theme} user={displayUser} cache={weiboHomeCache} scroller={scroller}
                hiddenIds={(feed.hiddenSources||[]).filter(key=>key.startsWith(circle.id+':')).map(key=>key.split(':').at(-1)!)}
                onSettings={()=>open({kind:'sources'})} onPost={source=>{const saved=feed.posts.find(p=>p.circleId===circle.id&&p.source?.externalId===source.externalId&&syncedPostEnabled(feed,p));open(saved&&!settings.hideRealPosts?{kind:'detail',postId:saved.id}:{kind:'weibo-detail',post:source});}}/>
            : panel?.kind==='weibo-detail'?<FriendFeedWeiboBrowser key={panel.post.externalId} post={panel.post} theme={theme} user={displayUser} onConnect={()=>open({kind:'sources'})}/>
            : panel?.kind==='sources'&&circle ? <div className="friend-feed-form ff-settings-page" aria-label="微博与真实内容设置">
                <FriendFeedWeiboConnection circleId={circle.id} onTimeline={()=>{panelHistory.current=[];setPanel(undefined);setProfileId('');setPostFilter('all');}}/>
                <FriendFeedWeiboTimeline feed={feed} circleId={circle.id} onConnect={()=>open({kind:'weibo'})} showConnectionLink={false}/>
                <button className="ff-settings-navigation" type="button" onClick={()=>open({kind:'weibo-home'})}>打开微博首页</button>
                <button className="ff-settings-navigation" type="button" onClick={()=>open({kind:'following'})}>查看微博关注名单与主页</button>
                <section className="ff-settings-section"><h2>主页绑定</h2><p>额外同步指定账号发过的微博。首页关注流不需要逐个绑定。</p>
                    <label className="ff-setting-field">绑定到谁的主页<select aria-label="微博主页绑定对象" value={weiboBindingOwner} onChange={e=>setWeiboBindingOwner(e.target.value)}><option value="user">我的主页</option>{characters.filter(c=>circle.memberIds.includes(c.id)).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
                    <FriendFeedProfileControls key={weiboBindingOwner} feed={feed} ownerId={weiboBindingOwner} circleId={circle.id} characters={characters} groups={characterGroups} onConnect={()=>open({kind:'weibo'})}/>
                </section>
                <section className="ff-settings-section"><h2>真实内容与阅读权限</h2><FriendFeedPreferences section="content" value={settings} onChange={next=>void saveRealContent(next)} disabled={busy} embedded={embedded}/><p className="ff-setting-status">开关修改后立即保存。</p></section>
</div>
            : panel?.kind === 'cover' ? <FriendFeedCoverEditor key={panel.ownerId} ownerId={panel.ownerId} value={settings.coverImages?.[panel.ownerId]} onBack={back} onSaved={back} onBusy={value=>{saving.current=value;setBusy(value);}}/>
            : panel?.kind === 'api' ? <FriendFeedApi onSaved={back} onBack={back}/>
            : panel?.kind === 'weibo' ? <div className="friend-feed-form ff-settings-page"><FriendFeedWeiboConnection circleId={circle?.id} onTimeline={()=>{setPanel(undefined);setProfileId('');setPostFilter('all');}}/></div> : panel ? <form className={`friend-feed-form${panel.kind==='settings'?' ff-settings-page':''}`} onSubmit={submit}>
                {panel.kind === 'settings' ? preferenceSection
                    ? <FriendFeedPreferences section={preferenceSection} value={settingsDraft} onChange={setSettingsDraft} disabled={busy} embedded={embedded} characters={characters} groups={characterGroups}/>
                    : <FriendFeedSettingsMenu disabled={busy} onPreferences={section=>open({kind:'settings',section})}
                        onApi={()=>open({kind:'api'})} onSources={()=>open({kind:'sources'})} onRelations={()=>open({kind:'relations'})}
                        onSetup={()=>{rememberPage();setShowSetup(true);setPanel(undefined);}}/>
                : panel.kind === 'delete-comment' ? <><p>删除 {panel.authorName} 的这条评论？其他人的回复会保留。</p><blockquote>{panel.original}</blockquote></> : panel.kind === 'delete' ? <p>删除这条动态及其评论？删除后两个入口都会更新。</p> : <>
                    <p className="friend-feed-author-label">{panel.kind === 'edit-comment' ? `编辑 ${panel.authorName} 的评论` : `以 ${displayUser.name || '我'} 的身份`}{panel.kind === 'edit-comment' ? '' : panel.kind === 'post' ? '发布' : '评论'}</p>
                    {panel.kind === 'comment' && <blockquote>{replyTarget?<><strong>{replyComment?`回复 ${replyComment.authorName}${replyTarget.kind==='source'?'（仅本地）':''}`:'该评论已不可用'}</strong><p>{replyComment?.text}</p></>:commentPost?.text}</blockquote>}
                    <label>{panel.kind === 'post' ? '今天有什么想说的？' : '写下评论'}<textarea autoFocus required={panel.kind!=='post'||!draftImages.length} value={body} onChange={e => setBody(e.target.value)}
                        maxLength={panel.kind === 'post' ? FRIEND_POST_TEXT_LIMIT : FRIEND_COMMENT_TEXT_LIMIT} rows={6} disabled={busy}/></label>
                    <small>{body.length} / {panel.kind === 'post' ? FRIEND_POST_TEXT_LIMIT : FRIEND_COMMENT_TEXT_LIMIT}</small>
                    {panel.kind === 'post' && <small>发布到「{feed.circles.find(c => c.id === panel.circleId)?.name}」</small>}
                    {panel.kind === 'post' && <FriendFeedImagePicker value={draftImages} onChange={setDraftImages} disabled={busy} onBusy={setProcessingImages} onError={setError}/>}
                    {panel.kind === 'comment' && <small>发表后立即调用一次 API，由角色或路人接话；帖主私聊会收到评论记录。</small>}
                </>}
                {(panel.kind !== 'settings' || preferenceSection) && <div className="friend-feed-form-actions"><button type="button" onClick={back} disabled={busy}>取消</button>
                    <button className="friend-feed-primary" disabled={busy||processingImages} type="submit">
                        {busy ? '正在保存…' : panel.kind === 'settings' ? '保存设置' : panel.kind === 'edit-comment' ? '保存修改' : panel.kind === 'delete' || panel.kind === 'delete-comment' ? '确认删除' : panel.kind === 'comment' ? '发表评论' : '发布动态'}</button></div>}
            </form> : loaded && circle ? <>
                {profileId&&profileOwner!=='user'&&<nav className="ff-account-tabs" aria-label="此角色的账号（管理视角）">{feed.accountGraph?.accounts.filter(a=>a.ownerId===profileOwner&&(a.accountId==='main'||settings.identities[profileOwner]?.accounts.some(alias=>alias.id===a.accountId))).map(a=><button key={a.id} aria-pressed={a.accountId===profileAccount} onClick={()=>setProfileId(a.id)}>{friendAccountName(feed,a,characters,displayUser.name)}</button>)}</nav>}
                {social ? <>{profileId&&<SocialProfile theme={theme} name={profileName} avatar={profileAvatar}
                    posts={profilePosts} circle={circle} canManage={profileOwner==='user'||circle.memberIds.includes(profileOwner)} onSettings={()=>open({kind:'sources'})} coverImage={settings.coverImages?.[profileOwner]} onEditCover={()=>open({kind:'cover',ownerId:profileOwner})} {...followingProps}/>}
                    <SocialToolbar theme={theme} filter={postFilter} onFilter={next=>{setPostFilter(next);setLimit(5);}}/>
                    {!profileId&&postFilter==='all'&&<SocialComposer theme={theme} user={displayUser} onCompose={()=>open({kind:'post',circleId:circle.id})}/>}</>
                : profileId ? <ClassicProfile theme={theme} name={profileName} avatar={profileAvatar} posts={profilePosts} onSettings={()=>open({kind:'sources'})} coverImage={settings.coverImages?.[profileOwner]} onEditCover={profileOwner==='user'||circle.memberIds.includes(profileOwner)?()=>open({kind:'cover',ownerId:profileOwner}):undefined} {...followingProps}/>
                : <ClassicCover theme={theme} user={displayUser} count={profilePosts.length} onProfile={()=>navigateProfile('user')} coverImage={settings.coverImages?.user} onEditCover={()=>open({kind:'cover',ownerId:'user'})}/>}
                {!social&&(!profileId||profileOwner==='user') && <ClassicComposer user={displayUser} onCompose={()=>open({kind:'post',circleId:circle.id})}/>}
                {profileOwner==='user'&&<FriendFeedMyWeibo feed={feed} circleId={circle.id} scroller={scroller} onSettings={()=>open({kind:'sources'})}/>}
                {!profileId&&<nav className="ff-weibo-home-entry"><button className="ff-setting-link" onClick={()=>open({kind:'weibo-home'})}>微博首页 <span>›</span></button></nav>}
                <nav className="ff-source-filter" aria-label="动态来源显示筛选" title="仅筛选页面显示，不改变角色阅读范围">{([['all','全部'],['weibo','真实微博'],['local','本地动态']] as const).map(([value,label])=><button key={value} type="button" aria-pressed={sourceFilter===value} onClick={()=>{setSourceFilter(value);setLimit(5);}}>{label}</button>)}</nav>
                {!posts.length && <div className="friend-feed-empty friend-feed-empty-small"><ChatCircle size={35} weight="light"/><h2>{sourceFilter==='weibo'?'还没有读取到微博':social&&postFilter==='photos'?'还没有图文动态':'第一条日常，留给你'}</h2><p>{sourceFilter==='weibo'?(profileOwner==='user'?'连接后会自动读取我的微博，也可以点「刷新我的微博」重试。':'在「微博与真实内容」连接账号并同步微博。'):'发一条动态，或同步微博。'}</p></div>}
                {!!posts.length&&theme==='island' && <div className="friend-feed-list-heading"><span>最近的日常</span><span>{posts.length} 条动态</span></div>}
                <div className="friend-feed-posts">{posts.slice(0, limit).map(post => social ? <SocialPost key={post.id} theme={theme} post={post} user={displayUser} characters={displayCharacters}
                    onProfile={(id,accountId)=>{if(!openRealProfile(id))setProfileId(accountProfile(id,accountId));}} onComment={()=>open({kind:'detail',postId:post.id})} onDelete={()=>open({kind:'delete',postId:post.id})}>
                    {replying===post.id&&<p role="status">朋友们正在接话…</p>}
                </SocialPost> : <ClassicPost key={post.id} index={posts.indexOf(post)} theme={theme} post={post} user={displayUser} characters={displayCharacters}
                    onProfile={(id,accountId)=>{if(!openRealProfile(id))setProfileId(accountProfile(id,accountId));}} onComment={()=>open({kind:'detail',postId:post.id})} onDelete={()=>open({kind:'delete',postId:post.id})}>
                    {replying===post.id&&<p role="status">朋友们正在接话…</p>}
                </ClassicPost>)}</div>
                {posts.length > limit && <button className="friend-feed-more" onClick={() => setLimit(n => n + 5)}>更早的日常</button>}
                {!!posts.length && posts.length <= limit && <p className="friend-feed-end"><span aria-hidden="true">✿</span> 今天的日常，都在这里啦</p>}
            </> : null}
        </div>
        {social&&!panel&&loaded&&circle&&<SocialBottomNav theme={theme} profileId={profileId} canPost={true} onProfile={navigateProfile}
            onCircle={()=>open({kind:'settings'})} onSources={()=>open({kind:'sources'})} onCompose={()=>open({kind:'post',circleId:circle.id})}/>}
    </section></FriendFeedDirectoryProvider>;
}
