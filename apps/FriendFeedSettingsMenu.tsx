import React from 'react';
import {CaretRight} from '@phosphor-icons/react';

export const preferenceTitles = {
    appearance: '外观与阅读',
    interaction: '互动方式',
    content: '真实内容',
    profile: '我的网名',
    accounts: '角色与小号',
    weights: '角色与内容权重',
    advanced: '更多设置',
} as const;
export type PreferenceSection = keyof typeof preferenceTitles;

export default function FriendFeedSettingsMenu({onPreferences, onApi, onSources, onRelations, onSetup, disabled}: {
    onPreferences: (section: PreferenceSection) => void; onApi: () => void; onSources: () => void;
    onRelations: () => void; onSetup: () => void; disabled: boolean;
}) {
    const row = (title: string, action: () => void, hint?: string) => <button key={title} type="button" disabled={disabled} onClick={action}>
        <span>{title}</span>{hint && <small>{hint}</small>}<CaretRight size={16}/>
    </button>;
    const preference = (section: PreferenceSection, hint?: string) => row(preferenceTitles[section], () => onPreferences(section), hint);
    return <nav className="ff-settings-directory" aria-label="设置目录">
        <section><h2>阅读与外观</h2><div className="ff-settings-menu">
            {preference('appearance', '主题 · 字号 · 排版')}
        </div></section>
        <section><h2>账号与互动</h2><div className="ff-settings-menu">
            {preference('profile')}
            {preference('accounts')}
            {row('关注与身份关系', onRelations)}
            {preference('interaction', '接话 · 提示词')}
            {preference('weights', '谁来发 · 发什么')}
        </div></section>
        <section><h2>内容与连接</h2><div className="ff-settings-menu">
            {row('哔哔 API 设置', onApi)}
            {row('微博与真实内容', onSources, '连接 · 同步 · 主页 · 阅读权限')}
        </div></section>
        <section><h2>帮助与其他</h2><div className="ff-settings-menu">
            {row('重新查看入门引导', onSetup)}
            {preference('advanced')}
        </div></section>
    </nav>;
}
