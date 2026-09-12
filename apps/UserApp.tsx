
import React, { useRef, useState } from 'react';
import { useOS } from '../context/OSContext';
import { processImage } from '../utils/file';
import { migrateDataUrlToRef } from '../utils/blobRef';
import LifeRecordPanel from '../components/lifeRecord/LifeRecordPanel';
import PerCharAvatarPicker from '../components/user/PerCharAvatarPicker';
import TokenImg from '../components/os/TokenImg';
import { trackEvent } from '../utils/analytics';

const UserApp: React.FC = () => {
    const { closeApp, userProfile, updateUserProfile, addToast } = useOS();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [tab, setTab] = useState<'profile' | 'life'>('profile');

    const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            try {
                const base64 = await processImage(file);
                // 头像存令牌，二进制单独躺在 blob_assets 里（省掉 base64 那 ~33% 的膨胀）。
                // 同一张图之前存过就复用它的令牌；转不动时原样还回这条 data URL，图不会丢。
                updateUserProfile({ avatar: await migrateDataUrlToRef(base64) });
                addToast('头像已更新', 'success');
            } catch (err: any) {
                addToast(err.message, 'error');
            }
        }
    };

    return (
        <div className="h-full w-full bg-slate-50 flex flex-col animate-fade-in">
            {/* Header */}
            <div className="bg-white/70 backdrop-blur-md border-b border-slate-100 shrink-0 sticky top-0 z-10" style={{ paddingTop: 'var(--safe-top)' }}>
                <div className="flex items-center px-4 py-3 gap-2">
                    <button onClick={closeApp} className="p-2 -ml-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" className="w-6 h-6 text-slate-600">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
                        </svg>
                    </button>
                    <h1 className="text-lg font-bold text-slate-700 tracking-wide">个人档案</h1>
                </div>
                <p className="px-4 pb-2 text-[10px] leading-relaxed text-slate-400">生理期、药盒、记账与锻炼，也可以让角色帮你记。</p>
                {/* Tab：我的档案 / 生活记录 */}
                <div className="flex gap-1.5 px-4 pb-2.5">
                    {([['profile', '我的档案'], ['life', '生活记录']] as const).map(([key, label]) => (
                        <button
                            key={key}
                            onClick={() => { setTab(key); trackEvent('切换个人档案标签页', { tab: key }); }}
                            className={`px-4 py-1.5 rounded-full text-xs font-bold transition-colors ${
                                tab === key ? 'bg-primary text-white shadow-sm' : 'bg-slate-100 text-slate-400'
                            }`}
                        >
                            {label}
                        </button>
                    ))}
                </div>
            </div>

            <div className="flex-1 overflow-y-auto px-5 pb-10 pt-5 space-y-5">
                {tab === 'life' && <LifeRecordPanel />}
                {tab === 'profile' && <>

                {/* Profile name card */}
                <div className="bg-white rounded-[1.75rem] shadow-[0_10px_30px_-12px_rgba(80,70,120,0.25)] border border-slate-100 overflow-hidden">
                    {/* Cover banner */}
                    <div className="relative h-24" style={{ background: 'linear-gradient(135deg, hsl(var(--primary-hue),var(--primary-sat),72%) 0%, hsl(var(--primary-hue),var(--primary-sat),60%) 100%)' }}>
                        {/* soft decorative blobs */}
                        <div className="absolute -top-6 -right-4 w-28 h-28 rounded-full" style={{ background: 'rgba(255,255,255,0.18)' }} />
                        <div className="absolute top-6 left-6 w-16 h-16 rounded-full" style={{ background: 'rgba(255,255,255,0.12)' }} />
                    </div>

                    {/* Avatar overlapping the banner */}
                    <div className="px-6 pb-6 -mt-12">
                        <div
                            onClick={() => fileInputRef.current?.click()}
                            className="relative w-24 h-24 rounded-full cursor-pointer group mx-auto"
                        >
                            <div className="w-full h-full rounded-full ring-4 ring-white bg-slate-100 overflow-hidden shadow-md">
                                <TokenImg value={userProfile.avatar} className="w-full h-full object-cover group-hover:opacity-80 transition-opacity" />
                            </div>
                            {/* camera badge */}
                            <div className="absolute bottom-0.5 right-0.5 w-7 h-7 rounded-full bg-primary text-white flex items-center justify-center ring-2 ring-white shadow-sm">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" className="w-4 h-4">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-5.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z" />
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Z" />
                                </svg>
                            </div>
                        </div>
                        <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={handleAvatarChange} />
                        <p className="mt-2 text-center text-[10px] text-slate-400">整体头像：所有聊天的默认。想在某个角色那儿换一副面孔？下面「分角色聊天头像」里设。</p>

                        {/* Name field */}
                        <div className="mt-4">
                            <label className="text-[11px] font-bold text-slate-400 tracking-widest block text-center mb-1">你的名字</label>
                            <div className="relative">
                                <input
                                    value={userProfile.name}
                                    onChange={(e) => updateUserProfile({ name: e.target.value })}
                                    placeholder="点击输入名字"
                                    className="w-full bg-slate-50 focus:bg-white border border-transparent focus:border-primary/30 rounded-2xl px-4 py-3 text-xl font-bold text-slate-800 text-center outline-none transition-all placeholder:text-slate-300 placeholder:font-normal"
                                />
                            </div>
                        </div>
                    </div>
                </div>

                {/* 分角色聊天头像：上面的整体头像是宏观默认，这里可给每个角色的私聊单独换「你」的头像 */}
                <PerCharAvatarPicker />

                {/* About / setting card */}
                <div className="bg-white rounded-[1.75rem] shadow-[0_10px_30px_-12px_rgba(80,70,120,0.18)] border border-slate-100 p-5">
                    <div className="flex items-center gap-2 mb-1">
                        <span className="w-7 h-7 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" className="w-4 h-4">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125" />
                            </svg>
                        </span>
                        <h2 className="text-sm font-bold text-slate-700">关于我 / 设定</h2>
                    </div>
                    <p className="text-[11px] text-slate-400 mb-3 leading-relaxed">这些信息会发送给 AI，以便它更好地了解你（例如：大学生、喜欢吃辣、性格内向）。</p>
                    <textarea
                        value={userProfile.bio}
                        onChange={(e) => updateUserProfile({ bio: e.target.value })}
                        className="w-full h-52 bg-slate-50 focus:bg-white border border-slate-100 focus:border-primary/30 rounded-2xl px-4 py-3 text-sm text-slate-700 leading-relaxed resize-none outline-none transition-all placeholder:text-slate-300"
                        placeholder="描述你自己..."
                    />
                </div>
                </>}
            </div>
        </div>
    );
};

export default UserApp;
