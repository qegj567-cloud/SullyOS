import { loadCharacterContextMessages } from '../../utils/chatContextRange';

import React, { useState, useEffect, useRef } from 'react';
import { BankShopState, CharacterProfile, UserProfile, APIConfig, ShopStaff } from '../../types';
import { SHOP_RECIPES } from './BankGameConstants';
import BankAssetIcon from './BankAssetIcon';
import TokenImg from '../os/TokenImg';
import { isBlobRef } from '../../utils/blobRef';
import { ContextBuilder } from '../../utils/context';
import { useOS } from '../../context/OSContext';
import { DB } from '../../utils/db';
import { safeResponseJson } from '../../utils/safeApi';
import { PawPrint, Bell, Sparkle, Book } from '@phosphor-icons/react';
import { injectMemoryPalace } from '../../utils/memoryPalace/pipeline';

interface Props {
    shopState: BankShopState;
    characters: CharacterProfile[];
    userProfile: UserProfile;
    apiConfig: APIConfig;
    updateState: (s: BankShopState) => Promise<void>;
    onStaffClick?: (staff: ShopStaff) => void;
    onMoveStaff?: (x: number, y: number) => void;
    onOpenGuestbook: () => void;
}

const BankShopScene: React.FC<Props> = ({
    shopState, characters, userProfile, apiConfig, updateState,
    onStaffClick, onMoveStaff, onOpenGuestbook
}) => {
    const { addToast } = useOS();
    const [visitor, setVisitor] = useState<{char: CharacterProfile, x: number, y: number, msg: string, scale: number, foundPet?: boolean} | null>(null);
    const [isInviting, setIsInviting] = useState(false);
    const [showLoveEffect, setShowLoveEffect] = useState(false);
    const sceneRef = useRef<HTMLDivElement>(null);
    const [visitorScale, setVisitorScale] = useState(1);

    // Check if visitor has a pet working here
    const getVisitorPet = (charId: string) => {
        return shopState.staff.find(s => s.isPet && s.ownerCharId === charId);
    };

    // Initialize Visitor from State
    useEffect(() => {
        if (shopState.activeVisitor) {
            const char = characters.find(c => c.id === shopState.activeVisitor!.charId);
            if (char) {
                setVisitor({
                    char,
                    x: 50,
                    y: 60,
                    msg: shopState.activeVisitor.message,
                    scale: 1,
                });
                setVisitorScale(1);
            }
        } else {
            setVisitor(null);
        }
    }, [shopState.activeVisitor]);

    // Handle Stage Click (Movement)
    const handleStageClick = (e: React.MouseEvent) => {
        if ((e.target as HTMLElement).closest('button')) return;

        if (!sceneRef.current || !onMoveStaff) return;
        const rect = sceneRef.current.getBoundingClientRect();

        // Calculate percentages
        const x = ((e.clientX - rect.left) / rect.width) * 100;
        const y = ((e.clientY - rect.top) / rect.height) * 100;

        // Floor constraint (Floor roughly starts at 40% in new design)
        const floorY = Math.max(40, Math.min(90, y));

        onMoveStaff(x, floorY);
    };

    // Push system message to chat history via DB (uses [系统: ...] format for bell display)
    const pushVisitorSystemMessage = async (charId: string, message: string) => {
        try {
            await DB.saveMessage({
                charId,
                role: 'system',
                type: 'text',
                content: `[系统: ${message}]`,
            });
        } catch (e) {
            console.error('Failed to push visitor system message', e);
        }
    };

    // Handle Invite Logic - Enhanced with context + chat history
    const handleInvite = async () => {

        const COST = 30;
        if (shopState.actionPoints < COST) {
            addToast(`AP不足 (需${COST})`, 'error');
            return;
        }
        if (!apiConfig.apiKey) {
            addToast('请配置 API Key', 'error');
            return;
        }

        setIsInviting(true);
        try {
            const char = characters[Math.floor(Math.random() * characters.length)];
            await injectMemoryPalace(char);
            const characterContextInput = { char, user: userProfile, includeDetailedMemories: true };


            // Load recent chat history for richer context
            const recentMsgs = await loadCharacterContextMessages(char);
            const chatSnippet = recentMsgs
                .filter(m => m.type === 'text')
                .map(m => `${m.role === 'user' ? userProfile.name : char.name}: ${m.content.substring(0, 80)}`)
                .join('\n');

            // Check if this character has a pet working here
            const pet = getVisitorPet(char.id);
            const hasPetHere = !!pet;

            let prompt = `

### Recent Chat History (for context only)
${chatSnippet || '(No recent chats)'}

### Scenario: Visiting User's Savings App Café
${userProfile.name} has a savings/budgeting app (记账App). Inside the app there's a virtual café mini-game, similar to how Alipay has "蚂蚁庄园" or how friends visit each other's farms in QQ Farm.
You (${char.name}) are visiting ${userProfile.name}'s café as a friend/player — like visiting someone's virtual pet farm.
Café Name: "${shopState.shopName}"
Shop Appeal Level: ${shopState.appeal}
`;

            if (hasPetHere) {
                prompt += `
### SPECIAL EVENT: APP PET REUNION!
You just discovered that your APP PET "${pet!.name}" is working here!
This is YOUR digital pet from this savings app — like QQ Farm chickens or Alipay's virtual pet.
The pet is working as a ${pet!.role === 'chef' ? '小帮厨' : pet!.role === 'manager' ? '吉祥物' : '店小二'} in ${userProfile.name}'s virtual café.

### Task
Express your SURPRISE and JOY at finding your APP PET here!
- React to seeing your virtual pet working
- Comment on the café AND your pet reunion
- Stay in character based on your personality and recent chat context

Output JSON: { "action": "...", "comment": "你的反应和评论" }
Language: Chinese. Be in character!`;
            } else {
                prompt += `
### Task
You're visiting this virtual café. Describe your entrance and leave a comment.
- React naturally based on your personality
- You can comment on the shop, the vibe, or reference recent chats with the user
- Be in character!

Output JSON: { "action": "...", "comment": "你进店后说的话" }
Language: Chinese.`;
            }

            const res = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({ model: apiConfig.model, messages: (await ContextBuilder.buildCharacterRequest(characterContextInput, [{ role: 'user', content: prompt }])) }),
                __sullyMeta: { appId: 'bank', appName: '银行', charId: char.id, charName: char.name, purpose: '咖啡馆邀约互动' },
            } as RequestInit);

            if (res.ok) {
                const data = await safeResponseJson(res);
                let jsonStr = data.choices[0].message.content.replace(/```json/g, '').replace(/```/g, '').trim();
                const result = JSON.parse(jsonStr);
                const comment = result.comment || '来逛逛~';

                await updateState({
                    ...shopState,
                    actionPoints: shopState.actionPoints - COST,
                    activeVisitor: {
                        charId: char.id,
                        message: comment,
                        timestamp: Date.now()
                    }
                });

                // Push system message to chat history for ALL visitors
                if (hasPetHere) {
                    setShowLoveEffect(true);
                    setTimeout(() => setShowLoveEffect(false), 3000);
                    addToast(`${char.name} 发现了 ${pet!.name}！`, 'success');
                    await pushVisitorSystemMessage(
                        char.id,
                        `${char.name} 拜访了${userProfile.name}的记账App咖啡馆，惊喜地发现自己的App宠物 ${pet!.name} 正在这里打工！${char.name}表示："${comment}"`
                    );
                } else {
                    addToast(`${char.name} 进店了！`, 'success');
                    await pushVisitorSystemMessage(
                        char.id,
                        `${char.name} 拜访了${userProfile.name}的记账App咖啡馆，并表示："${comment}"`
                    );
                }
            }
        } catch (e) {
            console.error(e);
            addToast('邀请失败', 'error');
        } finally {
            setIsInviting(false);
        }
    };

    // Render Staff - Enhanced with Pet indicators
    const renderStaff = () => {
        return shopState.staff.map((s, idx) => {
            let left = s.x || 0;
            let top = s.y || 0;

            if (!s.x) {
                const total = shopState.staff.length;
                const step = 60 / (total + 1);
                left = step * (idx + 1) + 20;
                top = 65;
            }

            const isPet = s.isPet;
            const ownerChar = isPet ? characters.find(c => c.id === s.ownerCharId) : null;
            const isOwnerVisiting = visitor && s.ownerCharId === visitor.char.id;

            return (
                <div
                    key={s.id}
                    className={`absolute flex flex-col items-center group cursor-pointer transition-all duration-700 ease-in-out z-10 ${isOwnerVisiting ? 'animate-wiggle' : ''}`}
                    style={{ left: `${left}%`, top: `${top}%`, transform: 'translate(-50%, -100%)', zIndex: Math.floor(top) }}
                    onClick={(e) => { e.stopPropagation(); onStaffClick && onStaffClick(s); }}
                >
                    {/* Shadow */}
                    <div className="absolute bottom-1 w-10 h-3 bg-black/10 rounded-full blur-[2px] transform scale-x-150"></div>

                    {/* Pet Badge */}
                    {isPet && (
                        <div className="absolute -top-6 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1">
                            <PawPrint className="w-4 h-4 text-pink-500" weight="fill" />
                            {ownerChar && (
                                <TokenImg value={ownerChar.avatar} className="w-4 h-4 rounded-full border border-white shadow-sm" title={`${ownerChar.name}的宠物`} />
                            )}
                        </div>
                    )}

                    {/* Love indicator when owner is visiting */}
                    {isOwnerVisiting && (
                        <div className="absolute -top-10 text-xl animate-bounce z-20"><img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f495.png" alt="love" className="w-5 h-5" /></div>
                    )}

                    {/* Fatigue Bubble */}
                    {s.fatigue > 80 && !isOwnerVisiting && <div className="absolute -top-8 text-xl animate-bounce z-20"><img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4a4.png" alt="zzz" className="w-5 h-5" /></div>}

                    {/* Sprite */}
                    <div className={`text-5xl filter drop-shadow-lg transform group-hover:scale-110 transition-transform select-none relative z-10 origin-bottom ${isOwnerVisiting ? 'animate-pulse' : ''}`}>
                        {s.avatar.startsWith('http') || s.avatar.startsWith('data') || isBlobRef(s.avatar) ? <TokenImg value={s.avatar} className="w-14 h-14 object-contain rounded-lg" /> : s.avatar}
                    </div>

                    {/* Name Tag */}
                    <div className={`px-2 py-0.5 rounded-full text-[9px] font-bold mt-1 shadow-sm backdrop-blur-sm whitespace-nowrap transform -translate-y-1 ${
                        isPet
                            ? 'bg-gradient-to-r from-pink-100 to-rose-100 text-rose-600 border border-pink-200'
                            : 'bg-white/90 text-slate-600 border border-slate-200'
                    }`}>
                        {isPet && <PawPrint className="w-3 h-3 mr-0.5 inline-block text-pink-500" weight="fill" />}
                        {s.name}
                    </div>

                    {/* Tiny Status Bar */}
                    <div className="w-8 h-1 bg-slate-200 rounded-full mt-0.5 overflow-hidden border border-white">
                        <div className={`h-full ${s.fatigue > 80 ? 'bg-red-400' : isPet ? 'bg-pink-400' : 'bg-green-400'}`} style={{ width: `${100 - s.fatigue}%` }}></div>
                    </div>
                </div>
            );
        });
    };

    // Visitor sprite image (full art like RoomApp, no border frame)
    const visitorImage = visitor
        ? (visitor.char.sprites?.chibi || visitor.char.avatar)
        : null;

    const stickerClass = "filter drop-shadow-[0_0_1px_#fff] drop-shadow-[0_0_2px_#fff] drop-shadow-[0_4px_6px_rgba(0,0,0,0.2)]";

    return (
        <div
            ref={sceneRef}
            className="relative w-full h-[65vh] overflow-hidden select-none cursor-pointer"
            onClick={handleStageClick}
            style={{ background: 'linear-gradient(180deg, #FEF7E8 0%, #FDF2DC 50%, #E8DCC8 100%)' }}
        >
            {/* --- Premium Room Architecture --- */}

            {/* 1. Wall Background with Elegant Texture */}
            <div className="absolute inset-0 h-[48%]">
                {/* Base warm cream wall */}
                <div className="absolute inset-0 bg-gradient-to-b from-[#FEF9F0] via-[#FDF5E6] to-[#F5EBD8]"></div>

                {/* Subtle damask pattern overlay */}
                <div className="absolute inset-0 opacity-[0.03]"
                     style={{
                         backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23000000' fill-opacity='1'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
                         backgroundSize: '30px 30px'
                     }}></div>

                {/* Elegant Wainscoting Panel */}
                <div className="absolute bottom-0 w-full h-[38%]">
                    {/* Top molding */}
                    <div className="absolute top-0 w-full h-3 bg-gradient-to-b from-[#C4B59B] via-[#DDD0B8] to-[#E8DCC8] shadow-md"></div>
                    {/* Panel area */}
                    <div className="absolute top-3 w-full h-full bg-gradient-to-b from-[#E8DCC8] to-[#DDD0B8]">
                        <div className="w-full h-full flex justify-around px-4 pt-2">
                            {[...Array(6)].map((_, i) => (
                                <div key={i} className="flex-1 mx-1 rounded-sm bg-gradient-to-b from-[#F0E6D3] to-[#E0D4C0] border border-[#C8BC9E] shadow-[inset_0_1px_0_rgba(255,255,255,0.5),inset_0_-1px_2px_rgba(0,0,0,0.05)]"></div>
                            ))}
                        </div>
                    </div>
                </div>

                {/* Hanging Shop Sign with Chain */}
                <div className="absolute top-6 left-1/2 -translate-x-1/2 z-10">
                    {/* Chains */}
                    <div className="absolute -top-4 left-4 w-0.5 h-6 bg-gradient-to-b from-[#B8A070] to-[#8B7355]"></div>
                    <div className="absolute -top-4 right-4 w-0.5 h-6 bg-gradient-to-b from-[#B8A070] to-[#8B7355]"></div>
                    {/* Sign board */}
                    <div className="relative bg-gradient-to-b from-[#5D4037] to-[#4E342E] px-8 py-3 rounded-xl shadow-2xl border-2 border-[#6D4C41]">
                        <div className="absolute inset-1 rounded-lg border border-[#795548]/30"></div>
                        <div className="text-center relative z-10">
                            <span className="text-[9px] uppercase tracking-[0.25em] text-[#D7CCC8] block mb-0.5 flex items-center justify-center gap-1"><img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/2615.png" alt="" className="w-3 h-3 inline-block" /> Est. 2024 <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/2615.png" alt="" className="w-3 h-3 inline-block" /></span>
                            <span className="font-serif font-bold text-xl text-[#FFF8E1] drop-shadow-sm tracking-wide">{shopState.shopName}</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* 2. Premium Hardwood Floor */}
            <div className="absolute top-[48%] left-0 w-full h-[52%]">
                {/* Base wood color */}
                <div className="absolute inset-0 bg-gradient-to-b from-[#C4A77D] via-[#B8956E] to-[#A68660]"></div>

                {/* Wood plank pattern */}
                <div className="absolute inset-0 opacity-40"
                     style={{
                         backgroundImage: `
                             repeating-linear-gradient(90deg, transparent, transparent 80px, rgba(0,0,0,0.08) 80px, rgba(0,0,0,0.08) 82px),
                             repeating-linear-gradient(0deg, transparent, transparent 200px, rgba(0,0,0,0.04) 200px, rgba(0,0,0,0.04) 201px)
                         `
                     }}></div>

                {/* Wood grain texture */}
                <div className="absolute inset-0 opacity-20"
                     style={{
                         backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 400 400' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E")`
                     }}></div>

                {/* Floor highlight/reflection */}
                <div className="absolute inset-0 bg-gradient-to-b from-white/15 via-transparent to-black/10"></div>

                {/* Ambient shadow from counter */}
                <div className="absolute top-0 left-[8%] w-[84%] h-20 bg-gradient-to-b from-black/15 to-transparent"></div>
            </div>

            {/* 3. Premium Coffee Counter */}
            <div className="absolute top-[40%] left-[8%] w-[84%] h-28 z-5">
                {/* Marble Counter Top */}
                <div className="absolute -top-3 -left-2 w-[104%] h-5 rounded-lg z-10 shadow-lg"
                     style={{
                         background: 'linear-gradient(135deg, #FAFAFA 0%, #F0F0F0 25%, #FAFAFA 50%, #E8E8E8 75%, #FAFAFA 100%)',
                         boxShadow: '0 4px 12px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.9)'
                     }}>
                    {/* Marble veins */}
                    <div className="absolute inset-0 opacity-10 rounded-lg"
                         style={{ backgroundImage: 'linear-gradient(120deg, transparent 30%, #9E9E9E 32%, transparent 34%)' }}></div>
                </div>

                {/* Counter Front - Premium Wood */}
                <div className="w-full h-full rounded-b-xl overflow-hidden shadow-2xl"
                     style={{
                         background: 'linear-gradient(180deg, #6D4C41 0%, #5D4037 30%, #4E342E 100%)',
                         boxShadow: '0 8px 32px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.1)'
                     }}>
                    {/* Decorative molding */}
                    <div className="absolute top-2 left-0 w-full h-1 bg-gradient-to-r from-transparent via-[#8D6E63] to-transparent opacity-50"></div>

                    {/* Panel sections */}
                    <div className="flex h-full pt-4 px-2 gap-1">
                        {[...Array(4)].map((_, i) => (
                            <div key={i} className="flex-1 bg-gradient-to-b from-[#5D4037] to-[#4E342E] rounded-t-sm border border-[#3E2723]/50 shadow-[inset_0_2px_4px_rgba(0,0,0,0.2)]">
                                <div className="m-1 h-full rounded-t-sm bg-gradient-to-b from-[#6D4C41]/30 to-transparent"></div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Menu items displayed on counter */}
                <div className="absolute -top-14 w-full flex justify-around px-8 pointer-events-none">
                     {shopState.unlockedRecipes.slice(0, 4).map((rid, i) => {
                         const r = SHOP_RECIPES.find((item: any) => item.id === rid);
                         return r ? (
                             <div key={rid} className="flex flex-col items-center animate-fade-in group" style={{ animationDelay: `${i*100}ms` }}>
                                 <div className="relative">
                                     <div className="w-10 h-10 flex items-center justify-center">
                                         <BankAssetIcon
                                             value={r.icon}
                                             alt={r.name}
                                             imgClassName="w-10 h-10 object-contain filter drop-shadow-lg transform group-hover:scale-110 group-hover:-translate-y-1 transition-all duration-300"
                                             textClassName="text-4xl leading-none filter drop-shadow-lg transform group-hover:scale-110 group-hover:-translate-y-1 transition-all duration-300"
                                         />
                                     </div>
                                     {/* Reflection */}
                                     <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-6 h-2 bg-black/10 rounded-full blur-sm"></div>
                                 </div>
                             </div>
                         ) : null;
                     })}
                </div>
            </div>

            {/* 4. Elegant Windows with Curtains */}
            <div className="absolute top-4 left-[4%] w-16 h-24 z-0">
                <div className="absolute inset-0 rounded-t-xl bg-gradient-to-b from-[#5D4037] to-[#4E342E] p-1 shadow-lg">
                    <div className="w-full h-full rounded-t-lg bg-gradient-to-br from-[#E3F2FD] via-[#BBDEFB] to-[#90CAF9] relative overflow-hidden">
                        <div className="absolute inset-0 bg-gradient-to-br from-white/40 to-transparent"></div>
                        <div className="absolute top-1/2 left-0 w-full h-0.5 bg-[#5D4037]"></div>
                        <div className="absolute top-0 left-1/2 w-0.5 h-full bg-[#5D4037]"></div>
                    </div>
                </div>
                <div className="absolute -left-2 top-0 w-4 h-full bg-gradient-to-r from-[#FFCCBC] to-[#FFAB91] rounded-tl-lg opacity-80 shadow-md"></div>
                <div className="absolute -right-2 top-0 w-4 h-full bg-gradient-to-l from-[#FFCCBC] to-[#FFAB91] rounded-tr-lg opacity-80 shadow-md"></div>
            </div>

            <div className="absolute top-4 right-[4%] w-16 h-24 z-0">
                <div className="absolute inset-0 rounded-t-xl bg-gradient-to-b from-[#5D4037] to-[#4E342E] p-1 shadow-lg">
                    <div className="w-full h-full rounded-t-lg bg-gradient-to-br from-[#E3F2FD] via-[#BBDEFB] to-[#90CAF9] relative overflow-hidden">
                        <div className="absolute inset-0 bg-gradient-to-br from-white/40 to-transparent"></div>
                        <div className="absolute top-1/2 left-0 w-full h-0.5 bg-[#5D4037]"></div>
                        <div className="absolute top-0 left-1/2 w-0.5 h-full bg-[#5D4037]"></div>
                    </div>
                </div>
                <div className="absolute -left-2 top-0 w-4 h-full bg-gradient-to-r from-[#FFCCBC] to-[#FFAB91] rounded-tl-lg opacity-80 shadow-md"></div>
                <div className="absolute -right-2 top-0 w-4 h-full bg-gradient-to-l from-[#FFCCBC] to-[#FFAB91] rounded-tr-lg opacity-80 shadow-md"></div>
            </div>

            {/* Sunlight Beams */}
            <div className="absolute top-0 left-0 w-full h-full pointer-events-none z-20 overflow-hidden">
                <div className="absolute top-0 left-[5%] w-32 h-[60%] bg-gradient-to-b from-[#FFF9C4]/20 via-[#FFF59D]/10 to-transparent transform -skew-x-6"></div>
                <div className="absolute top-0 right-[8%] w-24 h-[55%] bg-gradient-to-b from-[#FFF9C4]/15 via-[#FFF59D]/8 to-transparent transform skew-x-6"></div>
            </div>

            {/* 5. Decorative Elements */}
            <div className="absolute bottom-[22%] left-[3%] z-10 pointer-events-none">
                <div className="relative">
                    <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1fab4.png" alt="plant" className="w-12 h-12 filter drop-shadow-xl" />
                    <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-8 h-2 bg-black/15 rounded-full blur-sm"></div>
                </div>
            </div>

            <div className="absolute top-[28%] right-[12%] z-0 pointer-events-none">
                <div className="w-12 h-12 rounded-full bg-gradient-to-br from-[#FFF8E1] to-[#FFE0B2] border-4 border-[#8D6E63] shadow-lg flex items-center justify-center">
                    <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f550.png" alt="clock" className="w-6 h-6" />
                </div>
            </div>

            <div className="absolute top-[18%] left-1/2 -translate-x-1/2 z-0 pointer-events-none opacity-60">
                <div className="w-8 h-10 bg-[#3E2723] rounded-sm shadow-md flex items-center justify-center">
                    <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/2615.png" alt="coffee" className="w-3 h-3" />
                </div>
            </div>

            {/* --- Entities Layer --- */}
            {renderStaff()}

            {/* Visitor - Full sprite like RoomApp, no border frame */}
            {visitor && visitorImage && (
                <div
                    className={`absolute ${stickerClass} animate-fade-in z-30`}
                    style={{
                        left: '50%',
                        bottom: '22%',
                        width: `${100 * visitorScale}px`,
                        transform: 'translateX(-50%)',
                        zIndex: 35,
                    }}
                >
                    {/* Speech Bubble */}
                    <div className="absolute -top-16 left-1/2 -translate-x-1/2 w-max max-w-[180px]">
                        <div className={`bg-white/95 backdrop-blur-sm p-2.5 rounded-2xl shadow-xl text-xs font-medium text-[#5D4037] animate-pop-in ${
                            getVisitorPet(visitor.char.id) ? 'border-2 border-pink-300' : 'border border-[#FFE0B2]'
                        }`}>
                            {getVisitorPet(visitor.char.id) && (
                                <div className="absolute -top-2 -right-2 animate-bounce"><img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f495.png" alt="love" className="w-5 h-5" /></div>
                            )}
                            {visitor.msg}
                        </div>
                        <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[8px] border-t-white/95"></div>
                    </div>

                    {/* Full character art - no frame, just the sprite */}
                    <TokenImg
                        value={visitorImage}
                        alt={visitor.char.name}
                        className="w-full h-auto object-contain"
                        draggable={false}
                    />

                    {/* Name tag */}
                    <div className={`mt-1 px-3 py-0.5 rounded-full text-[10px] text-white font-bold shadow-lg text-center mx-auto w-fit ${
                        getVisitorPet(visitor.char.id)
                            ? 'bg-gradient-to-r from-pink-400 to-rose-500 border border-pink-300'
                            : 'bg-gradient-to-r from-[#8D6E63] to-[#6D4C41] border border-[#A1887F]/30'
                    }`}>
                        {getVisitorPet(visitor.char.id) && <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f495.png" alt="love" className="w-3 h-3 inline-block mr-1" />}
                        {visitor.char.name}
                    </div>

                    {/* Resize controls */}
                    <div className="absolute -right-12 top-1/2 -translate-y-1/2 flex flex-col gap-1.5 z-40">
                        <button
                            onClick={(e) => { e.stopPropagation(); setVisitorScale(s => Math.min(2, s + 0.15)); }}
                            className="w-7 h-7 rounded-full bg-white/90 border border-[#E0CBBA] shadow-sm flex items-center justify-center text-sm font-bold text-[#6B4528] active:scale-90 transition-transform"
                        >+</button>
                        <button
                            onClick={(e) => { e.stopPropagation(); setVisitorScale(s => Math.max(0.4, s - 0.15)); }}
                            className="w-7 h-7 rounded-full bg-white/90 border border-[#E0CBBA] shadow-sm flex items-center justify-center text-sm font-bold text-[#6B4528] active:scale-90 transition-transform"
                        >-</button>
                    </div>
                </div>
            )}

            {/* Love Effect Overlay - Pet Reunion Celebration */}
            {showLoveEffect && (
                <div className="absolute inset-0 z-50 pointer-events-none overflow-hidden">
                    {[...Array(20)].map((_, i) => (
                        <div
                            key={i}
                            className="absolute text-2xl animate-float-up"
                            style={{
                                left: `${10 + Math.random() * 80}%`,
                                animationDelay: `${Math.random() * 2}s`,
                                animationDuration: `${2 + Math.random() * 2}s`
                            }}
                        >
                            <img src={['https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f495.png','https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f497.png','https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f496.png','https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f49d.png','https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1fa77.png'][Math.floor(Math.random() * 5)]} alt="heart" className="w-6 h-6" />
                        </div>
                    ))}
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
                        <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f495.png" alt="love" className="w-16 h-16 animate-ping" />
                    </div>
                    <div className="absolute inset-0 bg-gradient-to-t from-pink-200/20 to-transparent animate-pulse"></div>
                </div>
            )}

            {/* --- UI Layer (HUD) --- */}

            {/* TOP RIGHT: Guestbook Button */}
            <button
                onClick={(e) => { e.stopPropagation(); onOpenGuestbook(); }}
                className="absolute top-4 right-4 z-40 group hover:scale-105 active:scale-95 transition-all duration-300"
            >
                <div className="relative">
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2 w-px h-4 bg-gradient-to-b from-[#D7CCC8] to-[#8D6E63]"></div>
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-[#8D6E63] shadow-sm"></div>
                    <div className="relative bg-gradient-to-b from-[#6D4C41] to-[#5D4037] w-14 h-16 rounded-xl shadow-xl flex flex-col items-center justify-center gap-1 overflow-hidden border border-[#8D6E63]/50">
                        <div className="absolute inset-0 bg-gradient-to-t from-transparent to-white/5"></div>
                        <div className="absolute inset-0 opacity-10" style={{ backgroundImage: 'repeating-linear-gradient(90deg, transparent, transparent 3px, rgba(0,0,0,0.1) 3px, rgba(0,0,0,0.1) 4px)' }}></div>
                        <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4d6.png" alt="guestbook" className="w-6 h-6 filter drop-shadow-sm relative z-10" />
                        <div className="text-[7px] font-bold uppercase tracking-wider text-[#D7CCC8] relative z-10">情报志</div>
                        <div className="absolute -top-1 -right-1 w-4 h-4 bg-gradient-to-br from-[#FF5252] to-[#D32F2F] rounded-full border-2 border-white shadow-lg flex items-center justify-center animate-pulse">
                            <span className="text-[8px] text-white font-bold">!</span>
                        </div>
                    </div>
                </div>
            </button>

            {/* TOP LEFT: Appeal Score */}
            <div className="absolute top-4 left-4 z-40">
                <div className="bg-white/70 backdrop-blur-xl px-4 py-2 rounded-2xl shadow-lg border border-white/50 flex items-center gap-2">
                    <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-[#FFD54F] to-[#FFB300] flex items-center justify-center shadow-md">
                        <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/2728.png" alt="sparkles" className="w-5 h-5" />
                    </div>
                    <div className="flex flex-col">
                        <span className="text-[9px] text-[#8D6E63] font-medium uppercase tracking-wider">人气值</span>
                        <span className="text-lg font-black text-[#5D4037] leading-none">{shopState.appeal}</span>
                    </div>
                </div>
            </div>

            {/* BOTTOM RIGHT: Invite Button */}
            <div className="absolute bottom-6 right-6 z-40">
                <button
                    onClick={(e) => { e.stopPropagation(); handleInvite(); }}
                    disabled={isInviting}
                    className="relative group"
                >
                    <div className="absolute inset-0 bg-gradient-to-br from-[#FF7043] to-[#E64A19] rounded-full blur-lg opacity-50 group-hover:opacity-80 transition-opacity"></div>
                    <div className={`relative h-16 w-16 rounded-full flex items-center justify-center shadow-2xl transition-all duration-300 ${isInviting ? 'bg-[#BDBDBD]' : 'bg-gradient-to-br from-[#FF8A65] via-[#FF7043] to-[#E64A19] hover:scale-110 active:scale-95'}`}
                         style={{ boxShadow: isInviting ? 'none' : '0 8px 24px rgba(230, 74, 25, 0.4), inset 0 1px 0 rgba(255,255,255,0.3)' }}>
                        <div className="absolute inset-1 rounded-full bg-gradient-to-b from-white/20 to-transparent"></div>
                        {isInviting ? (
                            <div className="w-6 h-6 border-3 border-white border-t-transparent rounded-full animate-spin"></div>
                        ) : (
                            <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f6ce.png" alt="bell" className="w-8 h-8 filter drop-shadow-md relative z-10" />
                        )}
                    </div>
                    <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 whitespace-nowrap">
                        <span className="text-[9px] font-bold text-[#5D4037]/70 bg-white/60 backdrop-blur px-2 py-0.5 rounded-full">招揽客人</span>
                    </div>
                </button>
            </div>

        </div>
    );
};

export default BankShopScene;
