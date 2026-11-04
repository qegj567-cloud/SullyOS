import React, {useState} from 'react';
import type {CharacterGroup, CharacterProfile} from '../types';
import FriendFeedCharacterPicker, {FriendFeedGroupedList} from './FriendFeedGroupedList';
import {createLocalId} from '../utils/localId.js';
import type {FriendFeedSettings, FriendIdentity} from '../utils/friendFeedSettings';

const tags = (text: string) => text.split(/[,，、\n]/).map(t => t.trim()).filter(Boolean).slice(0, 8);
export default function FriendFeedAccounts({value, onChange, characters, groups = [], disabled, section}: {
    value: FriendFeedSettings; onChange: (next: FriendFeedSettings) => void; characters: CharacterProfile[]; groups?: CharacterGroup[]; disabled: boolean; section: 'profile' | 'weights' | 'accounts';
}) {
    const [selected, setSelected] = useState(characters[0]?.id || '');
    const char = characters.find(c => c.id === selected) || characters[0];
    const identity = value.identities[char?.id] || {tags: [], accounts: []};
    const update = (patch: Partial<FriendIdentity>) => char && onChange({...value, identities: {...value.identities, [char.id]: {...identity, ...patch}}});
    return <>
        {section === 'profile' && <section className="ff-preferences-section" aria-label="我的账号">
            <label className="ff-setting-field">哔哔网名<input aria-label="我的哔哔网名" value={value.userNickname||''} maxLength={40} disabled={disabled} placeholder="留空使用档案里的名字" onChange={e=>onChange({...value,userNickname:e.target.value})}/></label>
            <p className="friend-feed-settings-hint">只改变哔哔里的公开名字，不改私聊档案。模型不能使用你的账号发言。</p>
        </section>}
        {section === 'weights' && <section className="ff-preferences-section" tabIndex={-1} aria-label="刷新与抽取">
            <p className="friend-feed-settings-hint">首页先同步微博再生成动态，评论区只刷新当前帖子的讨论。每次抽一位角色、抽一种内容，只调用这位角色的 API。数值越大越容易被抽中，0 表示不参与；角色权重也用于用户评论后的接话。</p>
            <fieldset disabled={disabled} className="ff-weight-list"><legend>角色权重</legend>
                <FriendFeedGroupedList items={characters.map(c=>({...c,searchText:`${c.name} ${value.identities[c.id]?.nickname??''}`}))} groups={groups} label="角色权重" disabled={disabled} renderItem={c => <label key={c.id}><span>{c.name}</span><input aria-label={`${c.name}的抽取权重`} type="number" min={0} max={100}
                    value={value.characterWeights[c.id] ?? 10} onChange={e => onChange({...value, characterWeights: {...value.characterWeights, [c.id]: Math.max(0, Math.min(100, Number(e.target.value)))}})}/></label>}/>
                {!characters.length && <p>创建角色后即可设置。</p>}
            </fieldset>
            <fieldset disabled={disabled} className="ff-weight-list"><legend>内容权重</legend>
                {([['self', '角色本人'], ['related', '身边的路人 / NPC'], ['stranger', '无关的陌生网友']] as const).map(([key, label]) => <label key={key}><span>{label}</span>
                    <input aria-label={`${label}的内容权重`} type="number" min={0} max={100} disabled={key !== 'self' && !value.npcEnabled}
                        value={value.contentWeights[key]} onChange={e => onChange({...value, contentWeights: {...value.contentWeights, [key]: Math.max(0, Math.min(100, Number(e.target.value)))}})}/></label>)}
            </fieldset>
            <p className="friend-feed-settings-hint">评论可有 3–6 位路人。关闭路人串场后，只抽角色本人；全部设为 0 时只同步微博。</p>
        </section>}
        {section === 'accounts' && <section className="ff-preferences-section" data-setup-section="accounts" tabIndex={-1} aria-label="角色账号">
            <p className="friend-feed-settings-hint">每位角色有一个主号、最多三个小号。填写各账号的用途，角色会自己选用；发帖和评论都记到原角色的上下文。</p>
            {char && <><FriendFeedCharacterPicker characters={characters} groups={groups} label="编辑角色账号" value={char.id} onChange={setSelected} disabled={disabled}/>
                <label className="ff-setting-field">主号网名<input aria-label="角色主号网名" value={identity.nickname||''} maxLength={40} disabled={disabled} placeholder={char.name} onChange={e=>update({nickname:e.target.value})}/></label>
                <label className="ff-setting-field">主号话题 / 俱乐部<input key={`${char.id}:${identity.tags.join(',')}`} disabled={disabled} defaultValue={identity.tags.join('，')} maxLength={240}
                    placeholder="咖啡师，夜猫子，摄影" onBlur={e => update({tags: tags(e.target.value)})}/></label>
                {identity.accounts.map((account, index) => <fieldset className="ff-account-editor" key={account.id} disabled={disabled}>
                    <legend>小号 {index + 1}</legend>
                    <label className="ff-setting-field">账号名<input value={account.name} maxLength={40} required onChange={e => update({accounts: identity.accounts.map(a => a.id === account.id ? {...a, name: e.target.value} : a)})}/></label>
                    <label className="ff-setting-field">用途与身份<textarea value={account.purpose} maxLength={300} rows={2} placeholder="例如：职业账号，只发工作；匿名吐槽号，不透露主号身份。"
                        onChange={e => update({accounts: identity.accounts.map(a => a.id === account.id ? {...a, purpose: e.target.value} : a)})}/></label>
                    <label className="ff-setting-field">标签<input key={account.tags.join(',')} defaultValue={account.tags.join('，')} maxLength={240} placeholder="用逗号分开"
                        onBlur={e => update({accounts: identity.accounts.map(a => a.id === account.id ? {...a, tags: tags(e.target.value)} : a)})}/></label>
                    <button className="ff-setting-link" type="button" onClick={() => update({accounts: identity.accounts.filter(a => a.id !== account.id)})}>移除这个小号</button>
                </fieldset>)}
                <button className="ff-setting-button ff-setting-secondary" type="button" disabled={disabled || identity.accounts.length >= 3}
                    onClick={() => update({accounts: [...identity.accounts, {id: createLocalId(), name: `未命名账号 ${identity.accounts.length + 1}`, purpose: '', tags: []}]})}>添加小号 · {identity.accounts.length}/3</button>
                <p className="friend-feed-settings-hint">小号是本地社交身份，不会注册真实微博账号。移除小号保留已发布内容和记忆。</p>
                <p className="friend-feed-settings-hint">相同标签就是共同话题，例如摄影、咖啡、夜猫子。评论区优先抽联系人或同话题角色；同话题不代表已经认识，也不会隔离首页。路人仍只从本次抽中角色的上下文衍生，或作为纯陌生网友出现。</p>
            </>}
        </section>}
    </>;
}
