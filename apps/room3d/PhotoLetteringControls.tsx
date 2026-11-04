import React from 'react';
import {photoFonts,type PhotoLettering} from './photoLettering';

export default function PhotoLetteringControls({value,onChange,onReset}:{value:PhotoLettering;onChange:(value:PhotoLettering)=>void;onReset:()=>void}){
 return <details className="photo-lettering">
  <summary>相纸文字与字体</summary>
  <label>主文案<input aria-label="相纸主文案" value={value.title} maxLength={40} placeholder="留空隐藏文字" onChange={e=>onChange({...value,title:e.target.value})}/></label>
  <label>底部小字<input aria-label="相纸底部小字" value={value.footer} maxLength={64} placeholder="留空隐藏文字" onChange={e=>onChange({...value,footer:e.target.value})}/></label>
  <label>字体<select aria-label="相纸字体" value={value.font} onChange={e=>onChange({...value,font:e.target.value as PhotoLettering['font']})}>{Object.entries(photoFonts).map(([id,font])=><option key={id} value={id}>{font.label}</option>)}</select></label>
  <p>跟随系统可使用已导入的字体；其他字体以设备支持为准。留空可隐藏文字。</p>
  <button onClick={onReset}>恢复这款相纸的文字</button>
 </details>;
}
