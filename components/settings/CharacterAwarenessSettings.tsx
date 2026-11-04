import React, {useState} from 'react';
import {Check, MagnifyingGlass, MapPin, PencilSimple} from '@phosphor-icons/react';
import type {CharacterProfile} from '../../types';
import {isImageValue, useBlobRefUrl} from '../../utils/blobRef';
import './characterAwarenessSettings.css';

type Character = Pick<CharacterProfile, 'id'|'name'|'avatar'>;
const searchable = (value: string) => value.normalize('NFKC').toLocaleLowerCase();
function Avatar({character}: {character: Character}) {
    const url = useBlobRefUrl(isImageValue(character.avatar) ? character.avatar : undefined);
    const [failed, setFailed] = useState<string>();
    return <span className="ca-avatar" aria-hidden="true">{url && failed !== url
        ? <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={()=>setFailed(url)}/>
        : !isImageValue(character.avatar) && character.avatar || Array.from(character.name || '友')[0]}</span>;
}
function CharacterList({characters, children}: {characters: Character[]; children: (char: Character)=>React.ReactNode}) {
    const [query, setQuery] = useState(''), [limit, setLimit] = useState(40);
    const words = searchable(query).trim().split(/\s+/).filter(Boolean);
    const filtered = characters.filter(c=>words.every(word=>searchable(c.name).includes(word)));
    return <><label className="ca-search"><MagnifyingGlass size={17}/><input type="search" aria-label="搜索角色" placeholder="搜索角色名字" value={query} onChange={e=>{setQuery(e.target.value);setLimit(40);}}/></label>
        <div className="ca-list">{filtered.slice(0,limit).map(c=><React.Fragment key={c.id}>{children(c)}</React.Fragment>)}</div>
        {!filtered.length&&<p className="ca-empty">{characters.length?'没有找到这个名字，换个关键词试试。':'添加角色后，就可以在这里设置。'}</p>}
        {filtered.length>limit&&<button type="button" className="ca-more" onClick={()=>setLimit(v=>v+40)}>显示更多角色（还有 {filtered.length-limit} 位）</button>}</>;
}

export function CharacterLocationAudience({characters, value, onChange}: {characters: Character[]; value?: string[]; onChange:(ids:string[]|undefined)=>void}) {
    const all = value === undefined;
    const selected = new Set(value || []);
    const count = characters.filter(c=>selected.has(c.id)).length;
    return <div className="character-awareness" aria-label="定位可见角色">
        <div className="ca-intro"><span className="ca-symbol"><MapPin size={23}/></span><h3>把位置分享给谁</h3><p>只向你允许的角色提供本次位置。<br/>隐藏地点规则对所有角色生效。</p></div>
        <div className="ca-segments" aria-label="定位分享范围"><button type="button" aria-pressed={all} onClick={()=>onChange(undefined)}>所有角色</button><button type="button" aria-pressed={!all} onClick={()=>{if(all)onChange([]);}}>仅选中的角色</button></div>
        {all?<p className="ca-note">当前及之后新增的角色都可见。想单独授权，请选择「仅选中的角色」。</p>:<>
            <div className="ca-list-heading"><strong>已选 {count} / {characters.length}</strong><div><button type="button" onClick={()=>onChange(characters.map(c=>c.id))}>全选</button><button type="button" onClick={()=>onChange([])}>清空</button></div></div>
            {!count&&<p className="ca-note">还没有授权任何角色；保存后，聊天不会获取或发送你的位置。</p>}
            <CharacterList characters={characters}>{c=><label className="ca-row" data-selected={selected.has(c.id)}><Avatar character={c}/><span className="ca-name">{c.name}</span><input type="checkbox" aria-label={`向${c.name}分享定位`} checked={selected.has(c.id)} onChange={e=>onChange(e.target.checked?[...(value||[]),c.id]:(value||[]).filter(id=>id!==c.id))}/><span className="ca-check" aria-hidden="true">{selected.has(c.id)&&<Check size={15} weight="bold"/>}</span></label>}</CharacterList>
        </>}
    </div>;
}

export function CharacterWeatherCities({characters, value, defaultCity, onChange}: {characters:Character[];value:Record<string,string>;defaultCity:string;onChange:(cities:Record<string,string>)=>void}) {
    const [editing,setEditing] = useState('');
    const setCity = (id:string, city:string) => {const next={...value};if(city)next[id]=city;else delete next[id];onChange(next);};
    const count=characters.filter(c=>value[c.id]?.trim()).length;
    return <details className="character-awareness ca-weather"><summary><span><strong>按角色设置城市</strong><small>{count?`${count} 位角色使用专属城市`:'所有角色沿用默认城市'}</small></span><span aria-hidden="true">＋</span></summary>
        <p className="ca-note">默认：{defaultCity.trim()||'尚未设置'}。城市用于天气感知，不改变角色时区，也不使用你的真实定位。</p>
        <CharacterList characters={characters}>{c=><div className="ca-weather-person"><button type="button" className="ca-row" aria-label={`设置${c.name}的天气城市`} aria-expanded={editing===c.id} onClick={()=>setEditing(editing===c.id?'':c.id)}><Avatar character={c}/><span className="ca-name">{c.name}<small>{value[c.id]?.trim()||`默认 · ${defaultCity.trim()||'未设置'}`}</small></span><PencilSimple size={17}/></button>
            {editing===c.id&&<div className="ca-city-editor"><label>天气城市<input aria-label={`${c.name}的天气城市`} value={value[c.id]||''} maxLength={100} placeholder={defaultCity||'例如 上海 / London'} onChange={e=>setCity(c.id,e.target.value)}/></label><div><button type="button" onClick={()=>setCity(c.id,'')}>恢复默认</button><button type="button" onClick={()=>setEditing('')}>完成</button></div></div>}</div>}</CharacterList>
    </details>;
}
