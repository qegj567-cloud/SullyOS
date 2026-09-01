import React, { useMemo, useState } from 'react';
import { CaretLeft, Check, CircleNotch, Fingerprint, Play, Sparkle, X } from '@phosphor-icons/react';
import type { APIConfig, CharacterProfile, GroupProfile, RealtimeConfig, UserProfile } from '../../types';
import TokenImg from '../../components/os/TokenImg';
import {
    getSARModules,
    readSARGachaState,
    type SARModuleDefinition,
    type SARModulePool,
} from '../../utils/vrWorld/sarGacha';
import {
    forgeSARIdentityCard,
    readSARSimulationState,
    resolveSARSimulationModules,
    startSARSimulationRun,
    type SARIdentityCard,
    type SARSimulationRun,
} from '../../utils/vrWorld/sarSimulation';

type CabinetView = 'assemble' | 'cards' | 'card';

const poolLabel = (pool: SARModulePool) => pool === 'variant'
    ? { cn: '人格补丁', en: 'VARIANT', empty: '选择人格补丁' }
    : { cn: '演算场', en: 'FIELD', empty: '选择演算场' };

const CharacterPortrait: React.FC<{ char: Pick<CharacterProfile, 'name' | 'avatar'>; large?: boolean }> = ({ char, large }) => (
    <div className={`sarc-portrait ${large ? 'sarc-portrait--large' : ''}`}>
        {char.avatar
            ? <TokenImg value={char.avatar} className="sarc-portrait__image" alt={char.name} />
            : <span>{char.name.slice(0, 1)}</span>}
        <i />
    </div>
);

const ModuleSocket: React.FC<{
    pool: SARModulePool;
    module: SARModuleDefinition | null;
    onClick: () => void;
}> = ({ pool, module, onClick }) => {
    const label = poolLabel(pool);
    return (
        <button type="button" className={`sarc-socket ${module ? 'is-filled' : ''}`} onClick={onClick}>
            <span className="sarc-socket__corner sarc-socket__corner--tl" /><span className="sarc-socket__corner sarc-socket__corner--br" />
            <small>{label.en} SLOT</small>
            <div className="sarc-socket__glyph"><i /><i /><b /></div>
            <strong>{module?.title || label.empty}</strong>
            <span className="sarc-socket__group">{module?.group || label.cn}</span>
            <em>{module ? '已装载 · 点击更换' : 'EMPTY SOCKET'}</em>
        </button>
    );
};

const ModulePicker: React.FC<{
    pool: SARModulePool;
    collection: Record<string, number>;
    onChoose: (module: SARModuleDefinition) => void;
    onClose: () => void;
}> = ({ pool, collection, onChoose, onClose }) => {
    const modules = getSARModules(pool).filter(module => (collection[module.id] || 0) > 0);
    return (
        <div className="sarc-picker-backdrop" role="dialog" aria-modal="true" aria-label={`选择${poolLabel(pool).cn}`} onClick={onClose}>
            <section className="sarc-picker" onClick={event => event.stopPropagation()}>
                <header><div><small>{poolLabel(pool).en} COLLECTION</small><h2>装载{poolLabel(pool).cn}</h2></div><button type="button" onClick={onClose} aria-label="关闭模块选择"><X size={16} /></button></header>
                {modules.length ? (
                    <div className="sarc-picker__list">
                        {modules.map(module => (
                            <button type="button" key={module.id} onClick={() => onChoose(module)}>
                                <span className="sarc-picker__sigil"><i /><b /></span>
                                <span><small>{module.group}</small><strong>{module.title}</strong><em>{module.summary}</em></span>
                                <b>×{collection[module.id]}</b>
                            </button>
                        ))}
                    </div>
                ) : (
                    <div className="sarc-picker__empty"><div><i /><b /></div><h3>尚未收录模块</h3><p>先去扭蛋机抽取一枚{poolLabel(pool).cn}，再回来装入槽位。</p></div>
                )}
            </section>
        </div>
    );
};

const CardDetailSection: React.FC<{ en: string; title: string; children: React.ReactNode }> = ({ en, title, children }) => (
    <section className="sarc-card-section"><small>{en}</small><h3>{title}</h3><p>{children}</p></section>
);

const IdentityCardView: React.FC<{
    card: SARIdentityCard;
    run?: SARSimulationRun;
    onStartRun: () => void;
    onAssemble: () => void;
}> = ({ card, run, onStartRun, onAssemble }) => {
    const { variant, story } = resolveSARSimulationModules(card);
    const isActive = run?.status === 'active';
    return (
        <main className="sarc-result">
            <div className="sarc-result__status"><Sparkle size={12} weight="fill" /> {run ? (isActive ? '人格实例运行中 · 独立世界线' : '推演已封存 · 身份卡保留') : '铸造完成 · 永久身份卡已收录'}</div>
            <article className="sarc-identity-card">
                <div className="sarc-card__ornament sarc-card__ornament--tl" /><div className="sarc-card__ornament sarc-card__ornament--br" />
                <header className="sarc-card__header"><span>SAR / VARIANT IDENTITY</span><b>No.{card.id.slice(-6).toUpperCase()}</b></header>
                <div className="sarc-card__hero">
                    <CharacterPortrait char={{ name: card.charName, avatar: card.charAvatar || '' }} large />
                    <div><small>{card.charName} · ALTER INSTANCE</small><h2>{card.profile.title}</h2><p>{card.profile.logline}</p></div>
                </div>
                <div className="sarc-card__modules"><span>{variant?.title || card.variantId}</span><i>×</i><span>{story?.title || card.storyId}</span></div>
                <section className="sarc-steel-seal">
                    <div className="sarc-steel-seal__mark"><Fingerprint size={28} weight="thin" /></div>
                    <div><small>PERSONALITY STEEL SEAL</small><h3>人格钢印</h3><blockquote>“{card.profile.steelSeal}”</blockquote></div>
                </section>
                <div className="sarc-card__serial">IDENTITY LOCKED · {card.legacy ? 'LEGACY CONVERTED' : 'ORIGINAL FORGE'}</div>
            </article>

            <CardDetailSection en="CURRENT IDENTITY" title="异格身份">{card.profile.identity}</CardDetailSection>
            <CardDetailSection en="LIFE PATCH" title="人生补丁">{card.profile.lifePatch}</CardDetailSection>
            <CardDetailSection en="RELATIONSHIP" title="与你的关系">{card.profile.relationship}</CardDetailSection>
            <CardDetailSection en="MEMORY STANCE" title="记忆姿态">{card.profile.memoryStance}</CardDetailSection>
            <CardDetailSection en="PATCH COST" title="补丁代价">{card.profile.patchCost}</CardDetailSection>
            <CardDetailSection en="BEHAVIOR SHIFT" title="稳定偏移">{card.profile.behaviorShift}</CardDetailSection>

            <section className={`sarc-opening ${run ? 'is-awake' : ''}`}>
                <div className="sarc-opening__top"><small>SCENE 00 · ENTRY POINT</small><b>{run ? `${run.interactionsUsed} / ${run.maxInteractions}` : 'DORMANT'}</b></div>
                <p>{card.profile.openingScene}</p>
                <blockquote><b>{card.charName}</b>{card.profile.openingLine}</blockquote>
                <div>{card.profile.playerPrompt}</div>
            </section>

            <div className="sarc-result__actions">
                {!run ? (
                    <button type="button" className="is-primary" onClick={onStartRun}><Play size={14} weight="fill" /> 启动首次推演 <span>创建独立的 0 / 50 人格实例</span></button>
                ) : isActive ? (
                    <button type="button" disabled><Play size={14} /> 进入第 {Math.min(run.interactionsUsed + 1, run.maxInteractions)} 轮 <span>对话管线下一步接入</span></button>
                ) : (
                    <button type="button" disabled>重启异格 <span>需要凯恩的重启模块</span></button>
                )}
                <button type="button" onClick={onAssemble}>继续铸造</button>
            </div>
        </main>
    );
};

export const SARAssemblyCabinetOverlay: React.FC<{
    onClose: () => void;
    characters: CharacterProfile[];
    apiConfig: APIConfig;
    userProfile: UserProfile;
    groups: GroupProfile[];
    realtimeConfig?: RealtimeConfig;
}> = ({ onClose, characters, apiConfig, userProfile, groups, realtimeConfig }) => {
    const [view, setView] = useState<CabinetView>('assemble');
    const [selectedCharId, setSelectedCharId] = useState(characters[0]?.id || '');
    const [variant, setVariant] = useState<SARModuleDefinition | null>(null);
    const [story, setStory] = useState<SARModuleDefinition | null>(null);
    const [picker, setPicker] = useState<SARModulePool | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [simulationState, setSimulationState] = useState(() => readSARSimulationState());
    const [activeCard, setActiveCard] = useState<SARIdentityCard | null>(null);
    const gachaState = useMemo(() => readSARGachaState(), []);
    const selectedChar = characters.find(char => char.id === selectedCharId) || null;
    const activeRun = activeCard ? simulationState.runs.find(run => run.cardId === activeCard.id) : undefined;

    const openCard = (card: SARIdentityCard) => { setActiveCard(card); setView('card'); };
    const backToAssembly = () => { setView('assemble'); setActiveCard(null); setError(''); };

    const forge = async () => {
        if (!selectedChar || !variant || !story || loading) return;
        setLoading(true);
        setError('');
        try {
            const card = await forgeSARIdentityCard({ char: selectedChar, variant, story, apiConfig, userProfile, groups, realtimeConfig });
            setSimulationState(readSARSimulationState());
            setActiveCard(card);
            setView('card');
        } catch (cause: any) {
            setError(cause?.message || '铸造设备没有回应，请重试');
        } finally {
            setLoading(false);
        }
    };

    const startRun = () => {
        if (!activeCard) return;
        try {
            startSARSimulationRun(activeCard.id);
            setSimulationState(readSARSimulationState());
        } catch (cause: any) {
            setError(cause?.message || '人格实例启动失败');
        }
    };

    return (
        <div className="sarc-root" role="dialog" aria-modal="true" aria-label="SAR 异格陈列柜">
            <SARCabinetStyle />
            <div className="sarc-grid-bg" />
            <header className="sarc-header">
                <button type="button" onClick={view === 'assemble' ? onClose : backToAssembly} aria-label={view === 'assemble' ? '离开异格陈列柜' : '返回组装台'}>{view === 'assemble' ? <X size={18} /> : <CaretLeft size={19} />}</button>
                <div><small>SAR ACTIVITY SPACE · 02</small><h1>异格陈列柜</h1></div>
                <button type="button" className="sarc-header__records" onClick={() => setView(view === 'cards' ? 'assemble' : 'cards')} disabled={loading}><span>{simulationState.cards.length}</span><i>异格</i></button>
            </header>

            {view === 'card' && activeCard ? <IdentityCardView card={activeCard} run={activeRun} onStartRun={startRun} onAssemble={backToAssembly} /> : view === 'cards' ? (
                <main className="sarc-records">
                    <div className="sarc-records__title"><small>VARIANT IDENTITY COLLECTION</small><h2>异格身份卡</h2><p>身份卡永久收藏；每次五十轮推演是它的一段独立生命。</p></div>
                    {simulationState.cards.length ? <div className="sarc-records__list">{simulationState.cards.map(card => {
                        const mods = resolveSARSimulationModules(card);
                        const run = simulationState.runs.find(item => item.cardId === card.id);
                        return <button type="button" key={card.id} onClick={() => openCard(card)}><CharacterPortrait char={{ name: card.charName, avatar: card.charAvatar || '' }} /><span><small>{mods.variant?.title} × {mods.story?.title}</small><strong>{card.profile.title}</strong><em>{card.profile.steelSeal}</em></span><b>{run ? `${run.interactionsUsed}/${run.maxInteractions}` : '未启动'}</b></button>;
                    })}</div> : <div className="sarc-records__empty">还没有铸造过异格身份。</div>}
                </main>
            ) : (
                <main className="sarc-main">
                    <section className="sarc-character-section">
                        <div className="sarc-section-label"><span>01</span><div><small>SELECT SUBJECT</small><h2>选择角色母体</h2></div></div>
                        {characters.length ? <div className="sarc-character-rail">{characters.map(char => <button type="button" key={char.id} className={char.id === selectedCharId ? 'is-active' : ''} onClick={() => setSelectedCharId(char.id)}><CharacterPortrait char={char} /><span>{char.name}</span></button>)}</div> : <p className="sarc-no-character">当前没有可供铸造的角色。</p>}
                    </section>

                    <section className="sarc-assembly">
                        <div className="sarc-section-label"><span>02</span><div><small>COMPILE IDENTITY</small><h2>装入人格补丁与演算场</h2></div></div>
                        <div className="sarc-assembly__core">
                            <div className="sarc-assembly__subject">
                                {selectedChar ? <CharacterPortrait char={selectedChar} large /> : <div className="sarc-subject-empty">?</div>}
                                <strong>{selectedChar?.name || '未选择角色'}</strong><small>IDENTITY SOURCE</small>
                            </div>
                            <div className="sarc-assembly__line sarc-assembly__line--left" /><div className="sarc-assembly__line sarc-assembly__line--right" />
                            <div className="sarc-assembly__slots"><ModuleSocket pool="variant" module={variant} onClick={() => setPicker('variant')} /><ModuleSocket pool="story" module={story} onClick={() => setPicker('story')} /></div>
                        </div>
                    </section>

                    <section className="sarc-start">
                        <div className="sarc-start__summary"><span>{selectedChar ? <><Check size={11} />角色已确认</> : '尚未选择角色'}</span><span>{variant && story ? <><Check size={11} />双槽已锁定</> : `${Number(!!variant) + Number(!!story)} / 2 槽位`}</span></div>
                        <button type="button" className={loading ? 'is-loading' : ''} disabled={!selectedChar || !variant || !story || loading} onClick={forge}>
                            {loading ? <><CircleNotch size={17} className="animate-spin" /> 正在铸造人格钢印</> : <><Fingerprint size={17} /> 铸造异格身份</>}
                            <small>{loading ? 'COMPILING IDENTITY CARD' : '永久收藏 · 推演另行启动'}</small>
                        </button>
                        {error && <p className="sarc-error">{error}</p>}
                        <p>模块不会被消耗。LLM 会先生成角色专属身份卡，不会预写完整剧情。</p>
                    </section>
                </main>
            )}

            {picker && <ModulePicker pool={picker} collection={gachaState.collection} onClose={() => setPicker(null)} onChoose={module => { picker === 'variant' ? setVariant(module) : setStory(module); setPicker(null); }} />}
            {loading && <div className="sarc-processing" aria-live="polite"><div className="sarc-processing__rings"><i /><i /><i /></div><span>正在铸造异格身份</span><div className="sarc-processing__steps"><b>读取人生</b><b>写入补丁</b><b>铸造钢印</b></div><small>PLEASE KEEP THE CABINET OPEN</small></div>}
        </div>
    );
};

const SARCabinetStyle = () => <style>{`
    .sarc-root{position:fixed;inset:0;z-index:392;overflow:hidden;color:#e7edf0;background:radial-gradient(75% 52% at 50% 24%,#1a2730 0%,#0a1117 53%,#05090d 100%);font-family:Inter,"Noto Sans SC",sans-serif;--sarc-top:var(--chrome-top);--sarc-bottom:var(--safe-bottom)}
    .sarc-grid-bg{position:absolute;inset:0;pointer-events:none;opacity:.22;background-image:linear-gradient(rgba(111,164,183,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(111,164,183,.05) 1px,transparent 1px);background-size:28px 28px;mask:linear-gradient(transparent,#000 18%,#000 80%,transparent)}
    .sarc-header{position:relative;z-index:5;display:grid;grid-template-columns:44px 1fr 52px;align-items:center;gap:8px;padding:calc(var(--sarc-top) + 6px) 15px 10px;border-bottom:1px solid rgba(151,193,207,.14);background:rgba(4,8,12,.72);backdrop-filter:blur(12px)}
    .sarc-header>button{width:38px;height:38px;display:grid;place-items:center;color:#c8d7dc;border:1px solid rgba(151,193,207,.16);background:#0d171c;clip-path:polygon(8px 0,100% 0,100% calc(100% - 8px),calc(100% - 8px) 100%,0 100%,0 8px)}.sarc-header>div{text-align:center}.sarc-header small{display:block;font-size:7px;letter-spacing:.25em;color:#75919d}.sarc-header h1{margin:3px 0 0;font:500 17px/1.2 "Noto Serif SC",serif;letter-spacing:.18em}.sarc-header .sarc-header__records{display:flex;flex-direction:column;gap:1px;width:49px}.sarc-header__records span{font:600 12px/1 serif}.sarc-header__records i{font-style:normal;font-size:8px;letter-spacing:.12em;color:#8199a3}
    .sarc-main,.sarc-records,.sarc-result{position:relative;z-index:2;height:calc(100% - var(--sarc-top) - 55px);overflow:auto;padding:15px 17px calc(var(--sarc-bottom) + 18px);scrollbar-width:none}.sarc-main::-webkit-scrollbar,.sarc-records::-webkit-scrollbar,.sarc-result::-webkit-scrollbar{display:none}
    .sarc-section-label{display:flex;align-items:center;gap:10px}.sarc-section-label>span{font:300 24px/1 "Noto Serif SC",serif;color:#6c8994}.sarc-section-label>div{padding-left:10px;border-left:1px solid #607b8655}.sarc-section-label small{display:block;font:6px/1 monospace;letter-spacing:.22em;color:#698793}.sarc-section-label h2{margin:3px 0 0;font:500 13px/1.2 "Noto Serif SC",serif;letter-spacing:.12em}
    .sarc-character-rail{display:flex;gap:10px;margin:13px -17px 0;padding:0 17px 5px;overflow-x:auto;scrollbar-width:none}.sarc-character-rail::-webkit-scrollbar{display:none}.sarc-character-rail>button{width:62px;flex:0 0 62px;padding:2px 0 5px;color:#6f858e;background:none;border:0;transition:.18s}.sarc-character-rail>button.is-active{color:#e3eff2;transform:translateY(-2px)}.sarc-character-rail>button.is-active .sarc-portrait{border-color:#9dc9d5;box-shadow:0 0 0 3px #0b151a,0 0 20px #6eb3c844}.sarc-character-rail>button>span{display:block;max-width:62px;margin-top:7px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:9px}
    .sarc-portrait{position:relative;width:48px;height:48px;margin:auto;display:grid;place-items:center;overflow:hidden;border-radius:50%;border:1px solid #55727d;background:radial-gradient(circle,#243740,#0b1419);color:#b7ced6;font:500 16px/1 "Noto Serif SC",serif}.sarc-portrait:before{content:"";position:absolute;inset:4px;border:1px solid rgba(139,190,204,.22);border-radius:50%}.sarc-portrait__image{width:100%;height:100%;object-fit:cover}.sarc-portrait i{position:absolute;right:2px;bottom:3px;width:6px;height:6px;border-radius:50%;background:#9bd6d9;box-shadow:0 0 8px #9bd6d9}.sarc-portrait--large{width:76px;height:76px;font-size:24px;border-color:#769aa7;box-shadow:0 0 30px #6297a82b}.sarc-no-character{margin:16px 0 0;font-size:10px;color:#82939a}
    .sarc-assembly{margin-top:18px}.sarc-assembly__core{position:relative;height:300px;margin-top:10px;border-top:1px solid #5b798442;border-bottom:1px solid #5b798442;background:radial-gradient(circle at 50% 30%,rgba(100,161,180,.1),transparent 33%)}.sarc-assembly__core:before{content:"";position:absolute;left:50%;top:20px;width:126px;height:126px;transform:translateX(-50%);border:1px solid #7295a133;border-radius:50%;box-shadow:0 0 0 18px #6788960b,0 0 0 19px #7295a11c}.sarc-assembly__subject{position:absolute;z-index:3;left:50%;top:41px;transform:translateX(-50%);text-align:center}.sarc-assembly__subject strong,.sarc-assembly__subject small{display:block}.sarc-assembly__subject strong{max-width:110px;margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:500 11px/1.2 "Noto Serif SC",serif;letter-spacing:.1em}.sarc-assembly__subject small{margin-top:3px;font:5.5px/1 monospace;letter-spacing:.2em;color:#698692}.sarc-subject-empty{width:76px;height:76px;display:grid;place-items:center;border-radius:50%;border:1px solid #536f7a;color:#607b85}
    .sarc-assembly__line{position:absolute;z-index:1;top:125px;width:32%;height:35px;border-top:1px solid #6c919d66}.sarc-assembly__line:after{content:"";position:absolute;top:-3px;width:6px;height:6px;transform:rotate(45deg);border:1px solid #7da8b5;background:#0b151a}.sarc-assembly__line--left{left:17%;transform:skewY(10deg)}.sarc-assembly__line--left:after{left:0}.sarc-assembly__line--right{right:17%;transform:skewY(-10deg)}.sarc-assembly__line--right:after{right:0}.sarc-assembly__slots{position:absolute;z-index:2;left:0;right:0;bottom:10px;display:grid;grid-template-columns:1fr 1fr;gap:12px}
    .sarc-socket{position:relative;height:137px;padding:12px 9px 9px;text-align:center;color:#6f8993;border:1px dashed #4e6a75;background:linear-gradient(150deg,rgba(24,40,47,.7),rgba(7,13,17,.82));clip-path:polygon(9px 0,100% 0,100% calc(100% - 9px),calc(100% - 9px) 100%,0 100%,0 9px)}.sarc-socket.is-filled{color:#c5dce2;border-style:solid;border-color:#739ba8;background:radial-gradient(circle at 50% 45%,#41687926,transparent 42%),linear-gradient(150deg,#172931,#081116)}.sarc-socket>small{font:5.5px/1 monospace;letter-spacing:.2em}.sarc-socket>strong,.sarc-socket>span,.sarc-socket>em{display:block}.sarc-socket>strong{margin-top:6px;font:500 11px/1.3 "Noto Serif SC",serif;letter-spacing:.07em}.sarc-socket__group{margin-top:3px;font-size:6px;color:#708b95}.sarc-socket>em{position:absolute;inset:auto 0 8px;font:5.5px/1 monospace;letter-spacing:.1em;color:#5d7781}.sarc-socket__corner{position:absolute;width:10px;height:10px;border-color:#7197a3}.sarc-socket__corner--tl{left:6px;top:6px;border-left:1px solid;border-top:1px solid}.sarc-socket__corner--br{right:6px;bottom:6px;border-right:1px solid;border-bottom:1px solid}.sarc-socket__glyph{position:relative;width:44px;height:44px;margin:9px auto 0;border:1px solid #658793;border-radius:50%}.sarc-socket__glyph:before,.sarc-socket__glyph:after{content:"";position:absolute;left:50%;top:50%;background:#658793}.sarc-socket__glyph:before{width:1px;height:56px;transform:translate(-50%,-50%)}.sarc-socket__glyph:after{width:56px;height:1px;transform:translate(-50%,-50%)}.sarc-socket__glyph i:first-child{position:absolute;inset:8px;border:1px dashed #678995;border-radius:50%}.sarc-socket__glyph i:nth-child(2){position:absolute;left:50%;top:50%;width:14px;height:14px;transform:translate(-50%,-50%) rotate(45deg);border:1px solid #81a9b5}.sarc-socket__glyph b{position:absolute;left:50%;top:-3px;width:5px;height:5px;transform:translateX(-50%) rotate(45deg);background:#8db6c1}
    .sarc-start{margin-top:13px;text-align:center}.sarc-start__summary{display:flex;justify-content:space-between;padding:0 3px 8px;color:#6f8993;font-size:7px;letter-spacing:.08em}.sarc-start__summary span{display:flex;align-items:center;gap:3px}.sarc-start>button{width:100%;height:55px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;color:#ebf5f7;border:1px solid #78a6b6;background:linear-gradient(110deg,#35677988,#14303a99);clip-path:polygon(11px 0,100% 0,100% calc(100% - 11px),calc(100% - 11px) 100%,0 100%,0 11px);font:500 13px/1.2 "Noto Serif SC",serif;letter-spacing:.15em}.sarc-start>button:disabled{color:#5d727a;border-color:#314a54;background:#0b1519}.sarc-start>button small{font:6px/1 monospace;letter-spacing:.18em;opacity:.6}.sarc-start>p:not(.sarc-error){margin:8px 3px 0;font-size:7px;line-height:1.55;color:#526a73}.sarc-error{margin:9px 0 0;padding:8px 10px;border:1px solid #8e4e4e55;background:#6b2e2e22;color:#d89c9c;font-size:9px;line-height:1.5}
    .sarc-picker-backdrop{position:fixed;z-index:20;inset:0;display:flex;align-items:flex-end;padding-top:calc(var(--sarc-top) + 25px);background:#020507c9;backdrop-filter:blur(6px)}.sarc-picker{width:100%;max-height:82%;display:flex;flex-direction:column;border-top:1px solid #668b97;background:linear-gradient(160deg,#14232a,#070d10 70%)}.sarc-picker>header{display:flex;align-items:center;justify-content:space-between;padding:16px 18px 13px;border-bottom:1px solid #58768133}.sarc-picker>header small{font:6px/1 monospace;letter-spacing:.22em;color:#71909b}.sarc-picker>header h2{margin:5px 0 0;font:500 17px/1.2 "Noto Serif SC",serif;letter-spacing:.12em}.sarc-picker>header button{width:32px;height:32px;display:grid;place-items:center;color:#a7bbc2;border:1px solid #425e68;background:#0b1519}.sarc-picker__list{overflow:auto;padding:7px 14px calc(var(--sarc-bottom) + 14px);scrollbar-width:none}.sarc-picker__list::-webkit-scrollbar{display:none}.sarc-picker__list>button{width:100%;display:grid;grid-template-columns:48px 1fr auto;align-items:center;gap:11px;padding:10px 4px;text-align:left;color:#c2d1d6;border:0;border-bottom:1px solid #506b7433;background:none}.sarc-picker__list>button>span:nth-child(2){min-width:0}.sarc-picker__list small,.sarc-picker__list strong,.sarc-picker__list em{display:block}.sarc-picker__list small{font-size:6px;letter-spacing:.14em;color:#6f8d98}.sarc-picker__list strong{margin-top:3px;font:500 12px/1.25 "Noto Serif SC",serif}.sarc-picker__list em{margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-style:normal;font-size:7px;color:#6f8289}.sarc-picker__list>button>b{font:7px/1 monospace;color:#89a7b1}.sarc-picker__sigil{position:relative;width:42px;height:42px;border:1px solid #61838e;border-radius:50%}.sarc-picker__sigil:before,.sarc-picker__sigil:after{content:"";position:absolute;left:50%;top:50%;background:#61838e}.sarc-picker__sigil:before{width:1px;height:52px;transform:translate(-50%,-50%)}.sarc-picker__sigil:after{width:52px;height:1px;transform:translate(-50%,-50%)}.sarc-picker__sigil i{position:absolute;inset:9px;border:1px dashed #7399a5;border-radius:50%}.sarc-picker__sigil b{position:absolute;left:50%;top:50%;width:10px;height:10px;transform:translate(-50%,-50%) rotate(45deg);border:1px solid #8aadb7}.sarc-picker__empty{min-height:320px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:#6b828a;padding:30px}.sarc-picker__empty>div{position:relative;width:64px;height:64px;margin-bottom:16px;border:1px solid #4e6b75;border-radius:50%}.sarc-picker__empty h3{margin:0;font:500 14px/1.3 "Noto Serif SC",serif}.sarc-picker__empty p{max-width:220px;margin:7px 0 0;font-size:9px;line-height:1.6}
    .sarc-processing{position:fixed;z-index:30;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#04090deb;backdrop-filter:blur(9px)}.sarc-processing__rings{position:relative;width:126px;height:126px;margin-bottom:28px}.sarc-processing__rings i{position:absolute;border:1px solid #729ca9;border-radius:50%;animation:sarc-spin 1.2s linear infinite}.sarc-processing__rings i:first-child{inset:0}.sarc-processing__rings i:nth-child(2){inset:17px;border-style:dashed;animation-duration:.72s;animation-direction:reverse}.sarc-processing__rings i:nth-child(3){inset:37px;animation-duration:.46s}.sarc-processing>span{font:500 13px/1.4 "Noto Serif SC",serif;letter-spacing:.18em}.sarc-processing>small{margin-top:10px;font:6px/1 monospace;letter-spacing:.22em;color:#73919b}.sarc-processing__steps{display:flex;gap:18px;margin-top:16px;color:#57737d;font:6px/1 monospace;letter-spacing:.12em}.sarc-processing__steps b{font-weight:400;animation:sarc-stage 2.4s infinite}.sarc-processing__steps b:nth-child(2){animation-delay:.8s}.sarc-processing__steps b:nth-child(3){animation-delay:1.6s}
    .sarc-result__status{display:flex;align-items:center;justify-content:center;gap:6px;margin:2px 0 13px;font-size:8px;letter-spacing:.13em;color:#94c4ca}.sarc-identity-card{position:relative;overflow:hidden;padding:12px 13px 10px;border:1px solid #739eaa;background:radial-gradient(circle at 80% 10%,#608c9b26,transparent 31%),linear-gradient(145deg,#14252c,#070d11 72%);box-shadow:inset 0 0 0 4px #071014,inset 0 0 0 5px #4e707a4d,0 20px 50px #0005;clip-path:polygon(13px 0,100% 0,100% calc(100% - 13px),calc(100% - 13px) 100%,0 100%,0 13px);animation:sarc-card-in .45s ease-out both}.sarc-identity-card:before{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(112deg,transparent 30%,#a9dae610 48%,transparent 62%);transform:translateX(-120%);animation:sarc-card-sheen 1.1s .25s ease-out}.sarc-card__ornament{position:absolute;width:22px;height:22px;border-color:#91bdc8}.sarc-card__ornament--tl{left:7px;top:7px;border-left:1px solid;border-top:1px solid}.sarc-card__ornament--br{right:7px;bottom:7px;border-right:1px solid;border-bottom:1px solid}.sarc-card__header{display:flex;justify-content:space-between;padding:0 5px 9px;border-bottom:1px solid #6d929d55;font:6px/1 monospace;letter-spacing:.16em;color:#7697a1}.sarc-card__header b{font-weight:400}.sarc-card__hero{display:grid;grid-template-columns:82px 1fr;align-items:center;gap:12px;padding:15px 3px}.sarc-card__hero>div:last-child{min-width:0}.sarc-card__hero small{font:6px/1 monospace;letter-spacing:.16em;color:#7898a3}.sarc-card__hero h2{margin:6px 0 5px;font:500 19px/1.25 "Noto Serif SC",serif;letter-spacing:.08em}.sarc-card__hero p{margin:0;font-size:8px;line-height:1.6;color:#8ea1a7}.sarc-card__modules{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:7px;padding:8px;border-top:1px solid #5f808944;border-bottom:1px solid #5f808944;text-align:center;font-size:7px;color:#91a8af}.sarc-card__modules i{font-style:normal;color:#58727b}.sarc-steel-seal{display:grid;grid-template-columns:44px 1fr;gap:10px;align-items:start;margin:12px 2px 8px;padding:12px 11px;border:1px solid #9a7b765c;background:linear-gradient(115deg,#4b242022,#1b1618 55%,#0d1417);position:relative}.sarc-steel-seal:after{content:"";position:absolute;inset:4px;border:1px solid #9b756d1f;pointer-events:none}.sarc-steel-seal__mark{width:42px;height:42px;display:grid;place-items:center;border:1px solid #a1756e;border-radius:50%;color:#c18d84;box-shadow:0 0 16px #8f4a4033}.sarc-steel-seal small{font:6px/1 monospace;letter-spacing:.16em;color:#9c716b}.sarc-steel-seal h3{margin:3px 0 6px;font:500 11px/1.2 "Noto Serif SC",serif;color:#d4aaa2;letter-spacing:.16em}.sarc-steel-seal blockquote{margin:0;color:#d8c7c3;font:500 10px/1.7 "Noto Serif SC",serif}.sarc-card__serial{text-align:right;padding:3px 4px 0;font:5.5px/1 monospace;letter-spacing:.16em;color:#536f78}
    .sarc-card-section{padding:12px 2px;border-bottom:1px solid #57727c33}.sarc-card-section small,.sarc-opening small{font:6px/1 monospace;letter-spacing:.19em;color:#6d8c97}.sarc-card-section h3{margin:5px 0 7px;font:500 12px/1.2 "Noto Serif SC",serif;letter-spacing:.1em}.sarc-card-section p{margin:0;font-size:9px;line-height:1.75;color:#9aabb0}.sarc-opening{margin-top:15px;padding:16px;border:1px solid #668b9766;background:radial-gradient(circle at 50% 0,#416a7826,transparent 45%),#081115;clip-path:polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px);opacity:.72}.sarc-opening.is-awake{opacity:1;border-color:#78a6b677}.sarc-opening__top{display:flex;justify-content:space-between;align-items:center}.sarc-opening__top>b{font:7px/1 monospace;color:#84a8b2}.sarc-opening>p{margin:10px 0 13px;font-size:9.5px;line-height:1.85;color:#aab8bc}.sarc-opening blockquote{margin:0;padding:11px 12px;border-left:1px solid #8eb9c2;background:#16262d;color:#d8e6e9;font:500 11px/1.7 "Noto Serif SC",serif}.sarc-opening blockquote b{display:block;margin-bottom:3px;font:6px/1 monospace;letter-spacing:.16em;color:#7fa0aa}.sarc-opening>div:last-child{margin-top:10px;text-align:right;font-size:7.5px;color:#718991}.sarc-result__actions{display:grid;grid-template-columns:1fr auto;gap:8px;margin-top:13px}.sarc-result__actions button{min-height:48px;padding:0 13px;border:1px solid #57737d;background:#0b161a;color:#81969d;font-size:10px}.sarc-result__actions button:first-child{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px}.sarc-result__actions button.is-primary{color:#e6f2f4;border-color:#82aeba;background:linear-gradient(110deg,#35677988,#14303a99)}.sarc-result__actions span{display:block;font-size:6px;color:#6f8992}
    .sarc-records__title{padding:3px 0 14px;border-bottom:1px solid #5d7b8644}.sarc-records__title small{font:6px/1 monospace;letter-spacing:.2em;color:#6f8e99}.sarc-records__title h2{margin:6px 0 4px;font:500 20px/1.2 "Noto Serif SC",serif;letter-spacing:.12em}.sarc-records__title p{margin:0;font-size:8px;color:#71858c}.sarc-records__list>button{width:100%;display:grid;grid-template-columns:54px 1fr auto;align-items:center;gap:10px;padding:13px 0;text-align:left;color:#c5d3d7;border:0;border-bottom:1px solid #57737d3d;background:none}.sarc-records__list>button>span{min-width:0}.sarc-records__list small,.sarc-records__list strong,.sarc-records__list em{display:block}.sarc-records__list small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:6px;color:#718b95}.sarc-records__list strong{margin-top:4px;font:500 12px/1.3 "Noto Serif SC",serif}.sarc-records__list em{margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-style:normal;font-size:7px;color:#9b7771}.sarc-records__list>button>b{font:7px/1 monospace;color:#7c969f;white-space:nowrap}.sarc-records__empty{padding:80px 0;text-align:center;font-size:9px;color:#68808a}
    @keyframes sarc-spin{to{transform:rotate(360deg)}}@keyframes sarc-stage{0%,30%,100%{color:#526b74}10%,20%{color:#c6e1e6;text-shadow:0 0 10px #7db6c7}}@keyframes sarc-card-in{from{opacity:0;transform:translateY(12px) scale(.985)}to{opacity:1;transform:none}}@keyframes sarc-card-sheen{to{transform:translateX(120%)}}
    @media(max-height:700px){.sarc-character-rail{margin-top:9px}.sarc-assembly{margin-top:12px}.sarc-assembly__core{height:252px}.sarc-assembly__core:before{top:10px;width:105px;height:105px}.sarc-assembly__subject{top:23px}.sarc-assembly__subject .sarc-portrait--large{width:66px;height:66px}.sarc-assembly__line{top:100px}.sarc-socket{height:122px}.sarc-socket__glyph{width:36px;height:36px;margin-top:6px}.sarc-socket>strong{font-size:10px}.sarc-start{margin-top:9px}}
    @media(min-width:700px){.sarc-main,.sarc-records,.sarc-result{max-width:600px;margin:0 auto}.sarc-picker{max-width:600px;margin:0 auto}.sarc-assembly__slots{gap:20px}}
    @media(prefers-reduced-motion:reduce){.sarc-root *{animation-duration:.01ms!important;animation-iteration-count:1!important}}
`}</style>;
