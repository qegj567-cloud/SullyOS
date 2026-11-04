import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {OSPreviewProvider} from '../../context/OSContext';
import DateApp from '../../apps/DateApp';
import BankAnalytics from '../../components/bank/BankAnalytics';
import DecorationDraftEditor from '../../components/chat/DecorationDraftEditor';
import {CreatorIframe} from '../../components/Like520Event';
import {DB} from '../../utils/db';
import {appShortcutLaunch} from '../../utils/appShortcutLaunch';
import {makeWorkshopPreset} from '../../utils/decorationWorkshop';
import {AppID, type CharacterProfile, type BankTransaction} from '../../types';

const char = {id:'qa-community-history',name:'示例角色',avatar:'',systemPrompt:''} as CharacterProfile;
const transactions: BankTransaction[] = [
 {id:'qa-old',dateStr:'2025-01-02',timestamp:new Date(2025,0,2,9).getTime(),amount:12.35,note:'旧年度午餐',category:'food'},
 {id:'qa-income',dateStr:'2026-10-27',timestamp:new Date(2026,9,27,10).getTime(),amount:3000,type:'income',note:'稿费到账',category:'general'},
 {id:'qa-expense',dateStr:'2026-10-27',timestamp:new Date(2026,9,27,11).getTime(),amount:25.5,type:'expense',note:'打车',category:'transport'},
];
function App() {
 const [surface,setSurface]=useState('bank'); const [ready,setReady]=useState(false); const [notice,setNotice]=useState('仅使用本地示例数据');
 const os = {theme:{},apiConfig:{},characters:[char],characterGroups:[],groups:[],activeCharacterId:char.id,setActiveCharacterId:()=>{},userProfile:{name:'测试用户'},virtualTime:{hours:10,minutes:0},registerBackHandler:()=>()=>{},addToast:setNotice,updateCharacter:()=>{},updateUserProfile:()=>{},closeApp:()=>setSurface('bank'),openApp:()=>{},consumeDateAutoStart:()=>{}} as any;
 const showHistory=async()=>{
  if(!ready){ for(let i=0;i<530;i++)await DB.saveMessage({charId:char.id,role:i%2?'user':'assistant',type:'text',content:`原始记录 ${i+1} [括号原文]`,timestamp:new Date(2025,0,i+1,10).getTime(),metadata:{source:'date',dateEncounterId:`qa-${i}`}});setReady(true); }
  appShortcutLaunch.request({appId:AppID.Date,entryId:'history',characterId:char.id});setSurface('date');
 };
 return <OSPreviewProvider value={os}><nav className="qa-nav"><button onClick={()=>setSurface('bank')}>账本</button><button onClick={()=>void showHistory()}>530 条见面</button><button onClick={()=>setSurface('story')}>剧情制作器</button><button onClick={()=>setSurface('chibi')}>捏人恢复</button></nav><div className="qa-phone">
  {surface==='bank'&&<BankAnalytics transactions={transactions} goals={[]} currency="¥" onDeleteTx={()=>{}}/>}
  {surface==='date'&&<DateApp/>}
  {surface==='story'&&<DecorationDraftEditor preset={makeWorkshopPreset('story')} origin={{kind:'self'} as any} theme={{} as any} sources={[]} maker="story" onOpenWorkshop={()=>{}} onClose={()=>setSurface('bank')} onSaved={()=>setNotice('已保存预设')}/>}
  {surface==='chibi'&&<CreatorIframe mode="char" charName="示例角色" draftKey="qa-community-chibi" savedState={{selected:{skin:'skin_1',eyes:'eyes_1',mouth:'mouth_1'},tintColor:{},itemColor:{},flipped:{},hairLinked:{},activeItemFocus:{}}} onConfirm={()=>setNotice('已出件')}/>}
 </div><output style={{position:'fixed',bottom:0,right:0,fontSize:10,pointerEvents:'none'}}>{notice}</output></OSPreviewProvider>;
}
createRoot(document.getElementById('root')!).render(<App/>);
