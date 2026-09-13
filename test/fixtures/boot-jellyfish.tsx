import React, {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import BootSequence from '../../components/os/BootSequence';
function Preview(){
  const [ready,setReady]=useState(new URLSearchParams(location.search).has('ready'));
  const [done,setDone]=useState(false);
  useEffect(()=>{const ready=()=>setReady(true);window.addEventListener('boot-ready',ready);return()=>window.removeEventListener('boot-ready',ready);},[]);
  return done?<p>已进入桌面</p>:<BootSequence dataReady={ready} onDone={()=>setDone(true)}/>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
