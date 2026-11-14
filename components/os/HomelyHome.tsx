import React, {useEffect, useState} from 'react';
import {CaretDown, House, Palette, X, LockSimple, LockSimpleOpen, Phone, DeviceMobile, Heart, Check} from '@phosphor-icons/react';
import {HOMELY_PALETTES, homelyPalette, homelyPaletteStyle} from './homelyPalette';
import {resolveHomelyResident} from '../../utils/homelyResident';
import {useOS} from '../../context/OSContext';
import {AppID} from '../../types';
import {INSTALLED_APPS} from '../../constants';
import Home3DSetupEntry from '../../apps/room3d/Home3DSetupEntry';
import TokenImg from './TokenImg';
import {roomLaunch} from '../../utils/roomLaunch';
import AppIcon from './AppIcon';
import './homelyHome.css';
import type {HomeEditor} from '../../apps/room3d/editor';

export default function HomelyHome({onEditor}:{onEditor?:(editor:HomeEditor)=>void} = {}) {
  const {characters, activeCharacterId, setActiveCharacterId, updateCharacter, openApp, isLocked, theme, updateTheme} = useOS();
  const character = resolveHomelyResident(characters, activeCharacterId, theme.homelyLockedCharacterId);
  const pinned = !!character && character.id === theme.homelyLockedCharacterId;
  const [drawer, setDrawer] = useState<'apps' | 'residents' | 'palette' | null>(null);
  const [appSearch, setAppSearch] = useState('');
  useEffect(() => {if(drawer!=='apps')setAppSearch('');}, [drawer]);
  const apps = INSTALLED_APPS.filter(app => app.id!==AppID.Launcher && app.name.toLocaleLowerCase().includes(appSearch.trim().toLocaleLowerCase()));
  const launchForResident = (app:AppID) => {
    if (!character) return;
    setActiveCharacterId(character.id);
    openApp(app);
  };
  const visit = () => {
    if (!character) return;
    roomLaunch.request({tab:'home3D', charId:character.id});
    openApp(AppID.Room);
  };
  return <main className="homely-desktop home-island" aria-label="居家桌面" style={homelyPaletteStyle(theme.homelyPalette)}>
    {character ? <Home3DSetupEntry key={character.id} presentation="homely" character={character}
      suspended={isLocked} value={character.home3D} onEditor={onEditor}
      onChange={home3D => updateCharacter(character.id, {home3D})}
      onDefinitionChange={homeDefinition => updateCharacter(character.id, {homeDefinition})}
      onBack={() => openApp(AppID.Appearance)} /> : <div className="homely-empty"><House size={48} weight="thin"/><h1>让这里住进一个人</h1><p>选择角色，布置小屋，把日常留在桌面。</p><button onClick={() => openApp(AppID.Character)}>选择角色</button></div>}
    <nav className="homely-launcher" aria-label="桌面导航">
      <div className="homely-quick-apps" aria-label="常用应用">
        <button onClick={()=>launchForResident(AppID.Call)} disabled={!character}><Phone size={21}/><span>电话</span></button>
        <button onClick={()=>launchForResident(AppID.CheckPhone)} disabled={!character}><DeviceMobile size={21}/><span>查手机</span></button>
        <button onClick={()=>launchForResident(AppID.Date)} disabled={!character}><Heart size={21}/><span>见面</span></button>
      </div>
      <button className="homely-resident-launch" onClick={() => setDrawer('residents')} aria-label="切换居家角色"><span className="homely-avatar">{character?.avatar ? <TokenImg value={character.avatar}/> : <House size={22}/>}</span><span>{character?.name ?? '选择角色'}</span>{pinned?<LockSimple size={13} aria-label="已锁定"/>:<CaretDown size={12}/>}</button>
      <button className="homely-apps-launch" onClick={() => setDrawer('apps')} aria-label="打开全部应用" title="全部应用" aria-haspopup="dialog" aria-expanded={drawer==='apps'}><span className="homely-apps-dots" aria-hidden="true"><i/><i/><i/><i/></span></button>
      <div className="homely-shortcuts">
      <button onClick={visit} disabled={!character} aria-label="进入 3D 家园"><House size={22}/><span>小屋</span></button>
      <button onClick={() => setDrawer(drawer==='palette'?null:'palette')} aria-label="更换居家配色" aria-expanded={drawer==='palette'}><Palette size={22}/><span>配色</span></button>
      </div>
    </nav>
    {drawer && <div className={`homely-drawer-backdrop ${drawer==='palette'?'homely-palette-backdrop':''}`} onClick={e => {if(e.target===e.currentTarget)setDrawer(null);}}>
      <section className={`homely-drawer ${drawer==='palette'?'homely-palette-sheet':''}`} role="dialog" aria-modal="true" aria-label={drawer==='apps'?'全部应用':drawer==='palette'?'居家配色':'选择居家角色'} onKeyDown={e => {if(e.key==='Escape')setDrawer(null); if(e.key==='Tab'){const nodes=[...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)')];const first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}}}>
        <header><h2>{drawer==='apps'?'全部应用':drawer==='palette'?'居家配色':'和谁一起待着？'}</h2><button autoFocus onClick={() => setDrawer(null)} aria-label="关闭"><X size={22}/></button></header>
        {drawer==='palette' ? <div className="homely-palette-options" role="group" aria-label="居家配色">{HOMELY_PALETTES.map(p=><button key={p.id} aria-pressed={homelyPalette(theme.homelyPalette).id===p.id} onClick={()=>void updateTheme({homelyPalette:p.id})}><span style={{background:`linear-gradient(135deg,${p.paper} 50%,${p.accent} 50%)`,color:p.ink}}>{homelyPalette(theme.homelyPalette).id===p.id&&<Check size={18} weight="bold"/>}</span><small>{p.name}</small></button>)}</div> : <>
        {drawer==='residents'&&character&&<button className="homely-resident-lock" aria-pressed={pinned} onClick={()=>void updateTheme({homelyLockedCharacterId:pinned?undefined:character.id})}>{pinned?<LockSimple size={22}/>:<LockSimpleOpen size={22}/>}<span><strong>{pinned?`已锁定 ${character.name}`:`锁定 ${character.name}`}</strong><small>{pinned?'去和别人聊天，回家仍然是 TA。':'锁定后，居家不随聊天对象切换。'}</small></span></button>}
        {drawer==='apps'&&<input className="homely-app-search" type="search" aria-label="搜索应用" placeholder="搜索应用" value={appSearch} onChange={e=>setAppSearch(e.target.value)}/>}
        <div className="homely-app-grid">{drawer==='apps' ? apps.map(app => <AppIcon key={app.id} app={app} contentColorOverride={homelyPalette(theme.homelyPalette).ink} onClick={() => {setDrawer(null);openApp(app.id);}} size="sm"/>) : characters.map(c => <button key={c.id} aria-pressed={c.id===character?.id} onClick={() => {if(pinned)void updateTheme({homelyLockedCharacterId:c.id});else setActiveCharacterId(c.id);setDrawer(null);}}><span className="homely-person-icon"><TokenImg value={c.avatar}/></span><span>{c.name}</span></button>)}</div>
        {drawer==='apps'&&!apps.length&&<p className="homely-search-empty">没有找到这个应用</p>}
        </>}
        {drawer==='residents'&&!characters.length&&<button onClick={() => openApp(AppID.Character)}>添加角色</button>}
      </section>
    </div>}
  </main>;
}
