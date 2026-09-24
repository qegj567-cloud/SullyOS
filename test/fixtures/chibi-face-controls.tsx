import React,{useState,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {HairEditor} from '../../experiments/chibi/HairEditor';
import {CreatorRollBridge} from '../../apps/room3d/chibi/CreatorRollBridge';
import {decodeParts} from '../../apps/room3d/chibi/visitor';
import {cleanFace} from '../../apps/room3d/chibi/faceAppearance';
import {selectedHairAssets,type HairSettings,type Parts} from '../../apps/room3d/chibi/types';
import '../../experiments/chibi/style.css';
import '../../experiments/chibi/wardrobe-studio.css';
// Read an existing character once; all edits here stay in React memory.
function QA(){
 const [saved]=useState(()=>JSON.parse(localStorage.getItem('chibi-wardrobe-appearance-draft-v1')||'null'));
 const initial:HairSettings={layers:{},extras:[],bodyShape:'blank',wardrobeStyle:'normal',face:cleanFace()};
 const [hair,setHair]=useState(initial),[parts,setParts]=useState<Parts>(),[assets,setAssets]=useState<Record<string,string>>({}),[image,setImage]=useState('');
 const [request,setRequest]=useState(0),[editing,setEditing]=useState(false),[capture,setCapture]=useState(false),[error,setError]=useState('');
 const undo=useRef<HairSettings[]>([]),redo=useRef<HairSettings[]>([]);
 const change=(next:HairSettings)=>{undo.current.push(hair);redo.current=[];setHair(next);};
 return <><header className="wardrobe-studio-top"><strong>独立验收 · 不写草稿</strong>{editing?<button onClick={()=>{setCapture(true);setRequest(n=>n+1);}}>完成形象</button>:<output aria-label="已存嘴型">{JSON.stringify(cleanFace(hair.face).mouths)}</output>}</header>
 <CreatorRollBridge savedState={saved??undefined} request={request} onReady={()=>setRequest(1)} editing={editing} captureOnly={capture} onError={setError} onResult={async result=>{setParts(await decodeParts(result));setAssets(selectedHairAssets(result.state));setImage(result.image);setEditing(false);}}/>
 {parts&&!editing&&<HairEditor hair={hair} previewHair={hair} parts={parts} assets={assets} appearanceImage={image} onEditAppearance={()=>setEditing(true)} onChange={change} onBegin={()=>{}} onEnd={()=>{}} onReset={()=>change(initial)} canUndo={!!undo.current.length} canRedo={!!redo.current.length} onUndo={()=>{const v=undo.current.pop();if(v){redo.current.push(hair);setHair(v);}}} onRedo={()=>{const v=redo.current.pop();if(v){undo.current.push(hair);setHair(v);}}}/>}{error&&<p role="alert">{error}</p>}</>;
}
createRoot(document.getElementById('root')!).render(<QA/>);
