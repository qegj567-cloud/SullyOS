import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import FriendFeedSetup from '../../apps/FriendFeedSetup';
import FriendFeedImagePicker from '../../apps/FriendFeedImagePicker';
import {defaultFriendFeedSettings} from '../../utils/friendFeedSettings';
import type {CharacterProfile} from '../../types';
import '../../apps/friendFeed.css';
import '../../apps/friendFeedCompose.css';
const photo=await(await fetch('/anniversary/cake-stripes.jpg')).blob();
function Preview(){
    const [tab,setTab]=useState('post'),[images,setImages]=useState<Blob[]>([photo]),[busy,setBusy]=useState(false),[error,setError]=useState('');
    return <><style>{`body{margin:0;background:#e8ede5;font-family:system-ui,sans-serif}main{max-width:440px;margin:20px auto;padding:0 14px}nav{display:flex;gap:10px;margin-bottom:14px}nav button{border:0;border-radius:20px;padding:9px 16px;background:#fff;color:#267d69;cursor:pointer}nav button[aria-pressed=true]{background:#267d69;color:white}.friend-feed{height:auto;min-height:520px;border-radius:24px}.friend-feed-form{padding:24px!important}.friend-feed-form h2{margin:0 0 20px;font-size:21px}.friend-feed-form textarea{width:100%;box-sizing:border-box}.ff-setup{margin-bottom:0!important}`}</style>
    <main><nav aria-label="预览页面"><button aria-pressed={tab==='post'} onClick={()=>setTab('post')}>带图发布</button><button aria-pressed={tab==='setup'} onClick={()=>setTab('setup')}>首次引导</button></nav>
    <section className="friend-feed" data-theme="island">{tab==='post'?<div className="friend-feed-form"><h2>今天有什么想说的？</h2><p className="friend-feed-author-label">以 小雨 的身份发布</p><textarea aria-label="动态正文" rows={3} defaultValue="给今天留一块甜的。🍰"/>
        <FriendFeedImagePicker value={images} onChange={setImages} disabled={false} onBusy={setBusy} onError={setError}/>{error&&<p role="alert">{error}</p>}<div className="friend-feed-form-actions"><button onClick={()=>setImages([])}>清空配图</button><button className="friend-feed-primary" disabled={busy} onClick={()=>setError('这是独立预览，未发布或调用 API。')}>发布动态</button></div></div>
        :<FriendFeedSetup characters={[{id:'preview',name:'小白'} as CharacterProfile]} settings={defaultFriendFeedSettings()} busy={false} onApi={()=>setError('请在主项目设置中配置 API')} onCharacters={()=>{}} onPreferences={()=>setError('请在主项目哔哔设置中调整')} onWeibo={()=>setError('请在主项目连接微博')} onDone={()=>setTab('post')}/>}</section>{tab==='setup'&&error&&<p role="status">{error}</p>}</main></>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
