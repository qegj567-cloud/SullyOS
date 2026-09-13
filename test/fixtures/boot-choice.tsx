import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {OSProvider,useOS} from '../../context/OSContext';
import BootAnimationSettings from '../../components/appearance/BootAnimationSettings';
import BootSequence from '../../components/os/BootSequence';
function Settings(){
  const {theme,updateTheme,isDataLoaded}=useOS(); const [preview,setPreview]=useState(false); const [saved,setSaved]=useState(false);
  if(!isDataLoaded)return <p>加载中</p>;
  return <main style={{maxWidth:420,padding:20,margin:'auto'}}>
    <BootAnimationSettings theme={theme} updateTheme={async patch=>{setSaved(false);await updateTheme(patch);setSaved(true);}}/>
    {saved&&<p>已保存</p>}
    <button onClick={()=>setPreview(true)}>预览所选开场</button>
    {preview&&<BootSequence dataReady={false} style={theme.bootAnimationStyle} wallpaper={theme.wallpaper} onDone={()=>setPreview(false)}/>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<OSProvider><Settings/></OSProvider>);
