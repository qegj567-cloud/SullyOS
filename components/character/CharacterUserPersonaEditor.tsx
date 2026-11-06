import React from 'react';
import type { CharacterUserPersona } from '../../utils/userPersona';
export default function CharacterUserPersonaEditor({ value = {}, onChange }: { value?: CharacterUserPersona; onChange: (value: CharacterUserPersona) => void }) {
    return <section className="border-t border-slate-100 pt-4 mt-4">
        <h3 className="text-sm font-bold text-slate-700">额外信息</h3>
        <p className="text-xs text-slate-400 my-3">留空沿用个人档案。这里只补充同一个人的不同侧面，原有经历与关系继续保留；另一个身份请使用新用户空间。</p>
        {([['name', '名字 / 称呼'], ['appearance', '外貌'], ['supplement', '补充设定']] as const).map(([key, label]) => <label key={key} className="block text-xs text-slate-500 my-2">{label}
            <textarea value={value[key] || ''} onChange={e => onChange({ ...value, [key]: e.target.value })} rows={key === 'name' ? 1 : 3} className="block w-full rounded-lg bg-slate-50 mt-1 p-2 text-slate-800" />
        </label>)}
        <p className="text-[10px] text-slate-400 mt-3">修改自动保存，仅对当前角色生效。</p>
    </section>;
}
