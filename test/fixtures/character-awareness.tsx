import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import UserLocationSettings,{type UserLocationSettingsPage} from '../../components/settings/UserLocationSettings';
import {CharacterWeatherCities} from '../../components/settings/CharacterAwarenessSettings';
import FriendFeedPostDetail from '../../apps/FriendFeedPostDetail';
import type {UserLocationConfig} from '../../utils/userLocationPrivacy';
import '../../apps/friendFeed.css';
import '../../apps/friendFeedSocialThemes.css';
import '../../apps/friendFeedNavigation.css';
const characters=[{id:'a',name:'小白',avatar:'☁️'},{id:'b',name:'小绿',avatar:'🌿'},{id:'c',name:'Charlie',avatar:'🐈'},{id:'d',name:'林间晚风与很长很长的名字',avatar:'🍃'}];
function Preview(){
    const [tab,setTab]=useState('location'),[page,setPage]=useState<UserLocationSettingsPage>('characters');
    const [value,setValue]=useState<UserLocationConfig>({enabled:true,regions:[],characterIds:['a','c']});
    const [cities,setCities]=useState<Record<string,string>>({a:'上海',c:'London'});
    return <main className="qa-phone"><h1>实时感知</h1><nav className="qa-tabs">{[['location','定位'],['weather','天气'],['comments','评论']].map(([id,label])=><button key={id} aria-pressed={tab===id} onClick={()=>setTab(id)}>{label}</button>)}</nav>
        {tab==='location'?<UserLocationSettings characters={characters} value={value} onChange={setValue} page={page} onNavigate={setPage} onSave={()=>true}/>:tab==='weather'?<section style={{background:'#f3faf6',padding:16,borderRadius:16}}><h2 style={{fontWeight:650,color:'#047857'}}>天气感知</h2><label style={{display:'block',fontSize:12,marginTop:14}}>默认天气城市<input aria-label="默认天气城市" readOnly value="北京" style={{display:'block',background:'white',padding:12,borderRadius:10,width:'100%',marginTop:6}}/></label><CharacterWeatherCities characters={characters} value={cities} defaultCity="北京" onChange={setCities}/></section>
        :<div className="friend-feed" data-theme="weibo"><FriendFeedPostDetail characters={characters as any} user={{name:'小雨'} as any} busy={false} replying={false} status="" onComment={()=>{}} onProfile={()=>{}} onRefresh={()=>{}} onReply={()=>{}} onEdit={()=>{}} onDelete={()=>{}} post={{id:'p',circleId:'public',audienceIds:['a'],authorId:'user',authorName:'小雨',text:'今天的电影好好看！',createdAt:1,comments:[{id:'c',authorId:'a',authorName:'小白',text:'我也喜欢最后那个镜头，下次一起去看吧。',createdAt:1,editedAt:2}]}}/></div>}
    </main>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
