import React,{useState} from 'react';
import type {HomeEditor} from './editor.js';
import {hasRomanticPair} from './homeRomance';

export function HomeRomanceSettings({editor,members}:{editor:HomeEditor;members:Array<{id:string;label:string}>}){
 const [,refresh]=useState(0),[error,setError]=useState('');
 const pairs=members.flatMap((a,i)=>members.slice(i+1).map(b=>({a,b})));
 return <fieldset><legend>浪漫关系</legend><p>只勾选确实有浪漫关系的两位。未勾选默认禁止拥抱、牵手、公主抱等亲密动作；高好感不会自动开启。此设置用于当前家园，也约束拍照。</p>
 {pairs.map(({a,b})=><label key={JSON.stringify([a.id,b.id])}><input type="checkbox" checked={hasRomanticPair(editor.getState(),a.id,b.id)} onChange={e=>{try{editor.setRomanticRelation(a.id,b.id,e.target.checked);setError('');refresh(n=>n+1);}catch(error){setError(error instanceof Error?error.message:'关系保存失败');}}}/>{a.label} ↔ {b.label}</label>)}
 {!pairs.length&&<p>邀请另一位成员后，可以设置两人的关系。</p>}{error&&<p role="alert">{error}</p>}</fieldset>;
}
