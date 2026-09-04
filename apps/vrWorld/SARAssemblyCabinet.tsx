import React, { useEffect, useMemo, useState } from 'react';
import { BookOpen, CaretLeft, Check, CircleNotch, Eye, Fingerprint, Play, Sparkle, X } from '@phosphor-icons/react';
import type { APIConfig, CharacterProfile, GroupProfile, RealtimeConfig, SARCharacterCabinetNoteMeta, UserProfile } from '../../types';
import TokenImg from '../../components/os/TokenImg';
import { DB } from '../../utils/db';
import { readSARSessionTheme, SARSimulationSession, type SARSessionTheme } from './SARSimulationSession';
import {
    getSARModules,
    readSARGachaState,
    type SARModuleDefinition,
    type SARModulePool,
} from '../../utils/vrWorld/sarGacha';
import {
    forgeSARIdentityCard,
    getSARSimulationPhase,
    readSARSimulationState,
    resolveSARUserMaskProfile,
    resolveSARWorldlineProfile,
    resolveSARSimulationModules,
    startSARSimulationRun,
    type SARIdentityCard,
    type SARSimulationRun,
} from '../../utils/vrWorld/sarSimulation';

type CabinetView = 'assemble' | 'cards' | 'card' | 'note' | 'session';
type CabinetShelf = 'mine' | 'characters';
type CharacterCabinetNoteRecord = SARCharacterCabinetNoteMeta & { messageId: number };

const poolLabel = (pool: SARModulePool) => pool === 'variant'
    ? { cn: '异界异格', en: 'ISEKAI', empty: '选择异界异格' }
    : { cn: '异界坐标', en: 'WORLD', empty: '选择异界坐标' };

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
    onEnterRun: () => void;
    onAssemble: () => void;
}> = ({ card, run, onStartRun, onEnterRun, onAssemble }) => {
    const { variant, story } = resolveSARSimulationModules(card);
    const worldline = resolveSARWorldlineProfile(card);
    const userMask = resolveSARUserMaskProfile(card);
    const phase = getSARSimulationPhase(run?.interactionsUsed || 0);
    const isActive = run?.status === 'active';
    return (
        <main className="sarc-result">
            <div className="sarc-result__status"><Sparkle size={12} weight="fill" /> {run ? (isActive ? `异世界运行中 · ${phase.label}` : '世界线已封存 · 身份卡保留') : '异世界坐标锁定 · 永久身份卡已收录'}</div>
            <article className="sarc-identity-card">
                <div className="sarc-card__ornament sarc-card__ornament--tl" /><div className="sarc-card__ornament sarc-card__ornament--br" />
                <header className="sarc-card__header"><span>SAR / ISEKAI VARIANT</span><b>No.{card.id.slice(-6).toUpperCase()}</b></header>
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

            <section className="sarc-user-mask">
                <header><small>USER / ISEKAI MASK</small><b>{userMask.retrofitted ? '旧卡兼容面具' : '面具已锁定'}</b></header>
                <h2>{userMask.title}</h2>
                <div><small>IDENTITY</small><strong>你的异界身份</strong><p>{userMask.identity}</p></div>
                <div><small>LIFE PATCH</small><strong>你的异界人生</strong><p>{userMask.lifePatch}</p></div>
                <footer>面具替代现实 User 设定，但不会替你决定性格、感受与行动。</footer>
            </section>

            <section className="sarc-worldline">
                <header><small>HOT-DROP WORLDLINE · STORY 60–75%</small><b>{worldline.retrofitted ? '旧卡补铸' : '坐标已锁定'}</b></header>
                <h2>{worldline.worldName}</h2>
                <p>{worldline.worldPremise}</p>
                <div><small>ACTIVE CRISIS</small><strong>当前危机</strong><span>{worldline.activeCrisis}</span></div>
                <div><small>SHARED OBJECTIVE</small><strong>共同任务</strong><span>{worldline.sharedObjective}</span></div>
                <div><small>COUNTDOWN</small><strong>倒计时</strong><span>{worldline.countdown}</span></div>
            </section>

            <CardDetailSection en="CURRENT IDENTITY" title="异格身份">{card.profile.identity}</CardDetailSection>
            <CardDetailSection en="ARRIVAL POINT" title="已发生的前情">{worldline.arrivalPoint}</CardDetailSection>
            <CardDetailSection en="LIFE PATCH" title="人生补丁">{card.profile.lifePatch}</CardDetailSection>
            <CardDetailSection en="RELATIONSHIP" title="与你的关系">{card.profile.relationship}</CardDetailSection>
            <CardDetailSection en="RELATIONSHIP ANCHOR" title="现实关系门牌">{worldline.relationshipAnchor}</CardDetailSection>
            <CardDetailSection en="PATCH COST" title="补丁代价">{card.profile.patchCost}</CardDetailSection>
            <CardDetailSection en="CLIMAX CHOICE" title="高潮命题">{worldline.climaxChoice}</CardDetailSection>
            <CardDetailSection en="BEHAVIOR SHIFT" title="稳定偏移">{card.profile.behaviorShift}</CardDetailSection>

            <section className={`sarc-opening ${run ? 'is-awake' : ''}`}>
                <div className="sarc-opening__top"><small>SCENE 00 · HOT DROP</small><b>{run ? `${run.interactionsUsed} / ${run.maxInteractions}` : 'READY'}</b></div>
                <p>{card.profile.openingScene}</p>
                <blockquote><b>{card.charName}</b>{card.profile.openingLine}</blockquote>
                <div>{card.profile.playerPrompt}</div>
            </section>

            <div className="sarc-result__actions">
                {!run ? (
                    <button type="button" className="is-primary" onClick={onStartRun}><Play size={14} weight="fill" /> 坠入异世界 <span>从危机现场开始 · 创建 0 / 50 世界线</span></button>
                ) : isActive ? (
                    <button type="button" className="is-primary" onClick={onEnterRun}><Play size={14} weight="fill" /> 进入第 {Math.min(run.interactionsUsed + 1, run.maxInteractions)} 轮 <span>{phase.label} · 世界线不会停下来等待</span></button>
                ) : (
                    <button type="button" onClick={onEnterRun}>查看封存记录 <span>重启仍需要凯恩的模块</span></button>
                )}
                <button type="button" onClick={onAssemble}>继续铸造</button>
            </div>
        </main>
    );
};

const shortDate = (timestamp: number) => new Date(timestamp).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });

const CabinetRecordsView: React.FC<{
    shelf: CabinetShelf;
    onShelfChange: (shelf: CabinetShelf) => void;
    characters: CharacterProfile[];
    selectedCharId: string;
    onSelectChar: (charId: string) => void;
    cards: SARIdentityCard[];
    runs: SARSimulationRun[];
    notes: CharacterCabinetNoteRecord[];
    notesLoading: boolean;
    onOpenCard: (card: SARIdentityCard) => void;
    onOpenNote: (note: CharacterCabinetNoteRecord) => void;
}> = ({ shelf, onShelfChange, characters, selectedCharId, onSelectChar, cards, runs, notes, notesLoading, onOpenCard, onOpenNote }) => {
    const selectedChar = characters.find(char => char.id === selectedCharId) || characters[0] || null;
    const selectedCards = cards.filter(card => card.charId === selectedChar?.id);
    const selectedNotes = notes.filter(note => note.actorId === selectedChar?.id);
    const activeCount = selectedCards.filter(card => runs.some(run => run.cardId === card.id && run.status === 'active')).length;
    const returnedCount = selectedCards.filter(card => runs.some(run => run.cardId === card.id && run.archiveReason === 'completed')).length;

    return (
        <main className="sarc-records sarc-archive">
            <div className="sarc-archive__intro">
                <small>PRIVATE ISEKAI CABINET</small>
                <h2>{shelf === 'mine' ? '我的异界史册' : '看看角色的柜子'}</h2>
                <p>{shelf === 'mine' ? '按角色收好每张异格、每次启程，以及已经带回来的故事。' : '他们偶尔也会自己抽卡，给别人装上两枚芯片，再把事故和吐槽偷偷记下来。'}</p>
            </div>

            <div className="sarc-archive__switch" role="tablist" aria-label="选择柜子归属">
                <button type="button" role="tab" aria-selected={shelf === 'mine'} className={shelf === 'mine' ? 'is-active' : ''} onClick={() => onShelfChange('mine')}><BookOpen size={14} weight="fill" /><span>我的柜子<small>异格与返航史册</small></span></button>
                <button type="button" role="tab" aria-selected={shelf === 'characters'} className={shelf === 'characters' ? 'is-active' : ''} onClick={() => onShelfChange('characters')}><Eye size={14} weight="fill" /><span>看看角色的柜子<small>TA 的随笔与吐槽</small></span></button>
            </div>

            <div className="sarc-archive__rail" aria-label="按角色查看柜子">
                {characters.map(char => {
                    const count = shelf === 'mine' ? cards.filter(card => card.charId === char.id).length : notes.filter(note => note.actorId === char.id).length;
                    return <button type="button" key={char.id} className={char.id === selectedChar?.id ? 'is-active' : ''} onClick={() => onSelectChar(char.id)}><CharacterPortrait char={char} /><span>{char.name}</span><b>{count}</b></button>;
                })}
            </div>

            {selectedChar && <section className="sarc-archive__owner">
                <div><CharacterPortrait char={selectedChar} large /><i /></div>
                <span><small>{shelf === 'mine' ? 'MY COLLECTION · BY CHARACTER' : 'CHARACTER PRIVATE NOTES'}</small><h3>{shelf === 'mine' ? `与 ${selectedChar.name} 有关的异格` : `${selectedChar.name} 的柜子`}</h3><p>{shelf === 'mine' ? `${selectedCards.length} 张异格 · ${activeCount} 条坐标进行中 · ${returnedCount} 次完整返航` : `${selectedNotes.length} 篇自由活动随笔；这里只是 TA 自己玩过的记录。`}</p></span>
            </section>}

            {shelf === 'mine' ? (
                selectedCards.length ? <div className="sarc-keepsakes">{selectedCards.map((card, index) => {
                    const cardRuns = runs.filter(run => run.cardId === card.id);
                    const run = cardRuns.find(item => item.status === 'active') || cardRuns[0];
                    const worldline = resolveSARWorldlineProfile(card);
                    const status = !run ? '待启程' : run.status === 'active' ? `${run.interactionsUsed}/50 · 异界中` : run.archiveReason === 'completed' ? '50/50 · 已返航' : `${run.interactionsUsed}/50 · 残卷`;
                    return <button type="button" className={`sarc-keepsake is-${index % 4}`} key={card.id} onClick={() => onOpenCard(card)}>
                        <div className="sarc-keepsake__portrait"><CharacterPortrait char={{ name: card.charName, avatar: card.charAvatar || '' }} /><span>NO.{card.id.slice(-4).toUpperCase()}</span></div>
                        <small>{worldline.worldName}</small><h3>{card.profile.title}</h3><blockquote>“{card.profile.steelSeal}”</blockquote>
                        <footer><span>{status}</span><b>{cardRuns.length ? `${cardRuns.length} 卷` : '新卡'}</b></footer>
                    </button>;
                })}</div> : <div className="sarc-archive__empty"><BookOpen size={30} weight="thin" /><h3>这一格还很空</h3><p>给 {selectedChar?.name || '这个角色'} 铸造第一张异格，它会像一本新书一样留在这里。</p></div>
            ) : notesLoading ? <div className="sarc-archive__empty"><CircleNotch className="animate-spin" size={24} /><p>正在翻找角色留下的随笔……</p></div> : selectedNotes.length ? <div className="sarc-character-notes">{selectedNotes.map(note => (
                <button type="button" key={`${note.messageId}-${note.id}`} onClick={() => onOpenNote(note)}>
                    <header><span>{shortDate(note.createdAt)} · 给 {note.targetName}</span><b>TA 的随笔</b></header>
                    <h3>{note.title}</h3>
                    <div><i>{note.variantTitle}</i><em>×</em><i>{note.storyTitle}</i></div>
                    <blockquote>“{note.highlight}”</blockquote>
                    <footer>从 {selectedChar?.name} 的柜子抽出这篇记录 <span>→</span></footer>
                </button>
            ))}</div> : <div className="sarc-archive__empty"><Eye size={30} weight="thin" /><h3>TA 还没往这里塞东西</h3><p>{selectedChar?.name || '这个角色'} 在自由活动时随机逛进 SAR，才会抽卡、给别人装芯片并留下随笔。</p></div>}
        </main>
    );
};

const CharacterNoteView: React.FC<{ note: CharacterCabinetNoteRecord; actor?: CharacterProfile }> = ({ note, actor }) => (
    <main className="sarc-note-view">
        <article>
            <header>
                <CharacterPortrait char={actor || { name: note.actorName, avatar: '' }} large />
                <div><small>{shortDate(note.createdAt)} · CHARACTER CABINET NOTE</small><h2>{note.title}</h2><p>{note.actorName} 给 {note.targetName} 装上的一次临时异界事故</p></div>
            </header>
            <div className="sarc-note-view__chips"><span><small>异界异格</small><b>{note.variantTitle}</b></span><i>×</i><span><small>异界坐标</small><b>{note.storyTitle}</b></span></div>
            <blockquote>{note.highlight}</blockquote>
            <section><small>WHAT HAPPENED</small><h3>事情怎么变成这样的</h3><p>{note.story}</p></section>
            <section className="is-handwritten"><small>PRIVATE MARGIN NOTES</small><h3>{note.actorName} 留在柜子里的随笔</h3><p>{note.notes}</p></section>
            <footer>这篇记录来自 {note.actorName} 自己的彼方自由活动，不属于 User 的五十轮推演史册。</footer>
        </article>
    </main>
);

export const SARAssemblyCabinetOverlay: React.FC<{
    onClose: () => void;
    characters: CharacterProfile[];
    apiConfig: APIConfig;
    userProfile: UserProfile;
    groups: GroupProfile[];
    realtimeConfig?: RealtimeConfig;
}> = ({ onClose, characters, apiConfig, userProfile, groups, realtimeConfig }) => {
    const [view, setView] = useState<CabinetView>('cards');
    const [shelf, setShelf] = useState<CabinetShelf>('mine');
    const [selectedCharId, setSelectedCharId] = useState(characters[0]?.id || '');
    const [variant, setVariant] = useState<SARModuleDefinition | null>(null);
    const [story, setStory] = useState<SARModuleDefinition | null>(null);
    const [picker, setPicker] = useState<SARModulePool | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [simulationState, setSimulationState] = useState(() => readSARSimulationState());
    const [activeCard, setActiveCard] = useState<SARIdentityCard | null>(null);
    const [activeNote, setActiveNote] = useState<CharacterCabinetNoteRecord | null>(null);
    const [characterNotes, setCharacterNotes] = useState<CharacterCabinetNoteRecord[]>([]);
    const [notesLoading, setNotesLoading] = useState(true);
    const [sessionTheme, setSessionTheme] = useState<SARSessionTheme>(readSARSessionTheme);
    const gachaState = useMemo(() => readSARGachaState(), []);
    const selectedChar = characters.find(char => char.id === selectedCharId) || null;
    const activeRun = activeCard ? (
        simulationState.runs.find(run => run.cardId === activeCard.id && run.status === 'active')
        || simulationState.runs.find(run => run.cardId === activeCard.id)
    ) : undefined;

    const openCard = (card: SARIdentityCard) => { setActiveCard(card); setActiveNote(null); setView('card'); };
    const openNote = (note: CharacterCabinetNoteRecord) => { setActiveNote(note); setActiveCard(null); setView('note'); };
    const openAssembly = () => { setView('assemble'); setActiveCard(null); setActiveNote(null); setError(''); };

    useEffect(() => {
        let alive = true;
        const loadNotes = async () => {
            setNotesLoading(true);
            try {
                const noteGroups = await Promise.all(characters.map(async char => {
                    const messages = await DB.getVRCardsByCharId(char.id);
                    return messages.flatMap(message => {
                        const note = message.metadata?.sarCabinetNote as SARCharacterCabinetNoteMeta | undefined;
                        return note?.id && note.actorId ? [{ ...note, messageId: message.id }] : [];
                    });
                }));
                if (alive) setCharacterNotes(noteGroups.flat().sort((a, b) => b.createdAt - a.createdAt));
            } catch {
                if (alive) setCharacterNotes([]);
            } finally {
                if (alive) setNotesLoading(false);
            }
        };
        void loadNotes();
        const refresh = () => { void loadNotes(); };
        window.addEventListener('vr-session-done', refresh);
        return () => { alive = false; window.removeEventListener('vr-session-done', refresh); };
    }, [characters]);

    useEffect(() => {
        const idsWithRecords = shelf === 'mine'
            ? Array.from(new Set(simulationState.cards.map(card => card.charId)))
            : Array.from(new Set(characterNotes.map(note => note.actorId)));
        if (idsWithRecords.length && !idsWithRecords.includes(selectedCharId)) setSelectedCharId(idsWithRecords[0]);
        else if (!characters.some(char => char.id === selectedCharId) && characters[0]) setSelectedCharId(characters[0].id);
    }, [shelf, simulationState.cards, characterNotes, characters, selectedCharId]);

    useEffect(() => {
        const target = window as Window & { render_game_to_text?: () => string; advanceTime?: (ms: number) => void };
        const renderState = () => JSON.stringify({
            mode: 'sar-cabinet',
            coordinateSystem: 'DOM viewport; origin top-left; x right; y down',
            visualSystem: 'restrained-moonstone-archive',
            view,
            shelf,
            selectedCharacter: characters.find(char => char.id === selectedCharId)?.name || null,
            userCards: simulationState.cards.filter(card => card.charId === selectedCharId).length,
            characterNotes: characterNotes.filter(note => note.actorId === selectedCharId).length,
            activeCard: activeCard?.profile.title || null,
            activeNote: activeNote?.title || null,
            notesLoading,
            surface: view === 'assemble' || (view === 'session' && sessionTheme === 'dark') ? 'machine-dark' : 'archive-light',
        });
        const advanceTime = (_ms: number) => { /* DOM 过渡不需要独立时钟 */ };
        target.render_game_to_text = renderState;
        target.advanceTime = advanceTime;
        return () => {
            if (target.render_game_to_text === renderState) delete target.render_game_to_text;
            if (target.advanceTime === advanceTime) delete target.advanceTime;
        };
    }, [view, shelf, characters, selectedCharId, simulationState.cards, characterNotes, activeCard, activeNote, notesLoading, sessionTheme]);

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
            setView('session');
        } catch (cause: any) {
            setError(cause?.message || '人格实例启动失败');
        }
    };

    const handleBack = () => {
        if (view === 'cards') onClose();
        else if (view === 'session') setView('card');
        else { setView('cards'); setActiveCard(null); setActiveNote(null); setError(''); }
    };

    const headerTitle = view === 'session' ? '异世界推演'
        : view === 'card' ? '异格档案'
            : view === 'note' ? '角色随笔'
                : view === 'assemble' ? '异格铸造'
                    : shelf === 'mine' ? '我的异界史册' : '角色的柜子';
    const paperSurface = view !== 'assemble' && !(view === 'session' && sessionTheme === 'dark');

    return (
        <div className={`sarc-root ${paperSurface ? 'is-paper-surface' : 'is-machine-surface'}`} role="dialog" aria-modal="true" aria-label="SAR 异格陈列柜">
            <SARCabinetStyle />
            <div className="sarc-grid-bg" />
            <header className="sarc-header">
                <button type="button" onClick={handleBack} aria-label={view === 'cards' ? '离开异格陈列柜' : view === 'session' ? '返回身份卡' : '返回异界史册'}>{view === 'cards' ? <X size={18} /> : <CaretLeft size={19} />}</button>
                <div><small>SAR ACTIVITY SPACE · CABINET</small><h1>{headerTitle}</h1></div>
                <button type="button" className="sarc-header__records" onClick={() => view === 'cards' ? openAssembly() : setView('cards')} disabled={loading || view === 'session'}><span>{view === 'session' && activeRun ? activeRun.interactionsUsed : view === 'cards' ? '＋' : simulationState.cards.length}</span><i>{view === 'session' ? '/ 50' : view === 'cards' ? '铸造' : '史册'}</i></button>
            </header>

            {view === 'session' && activeCard && activeRun ? <SARSimulationSession
                card={activeCard}
                run={activeRun}
                char={characters.find(char => char.id === activeCard.charId)}
                apiConfig={apiConfig}
                userProfile={userProfile}
                onRunChange={() => setSimulationState(readSARSimulationState())}
                onThemeChange={setSessionTheme}
            /> : view === 'card' && activeCard ? <IdentityCardView card={activeCard} run={activeRun} onStartRun={startRun} onEnterRun={() => setView('session')} onAssemble={openAssembly} /> : view === 'note' && activeNote ? <CharacterNoteView note={activeNote} actor={characters.find(char => char.id === activeNote.actorId)} /> : view === 'cards' ? <CabinetRecordsView
                shelf={shelf} onShelfChange={setShelf} characters={characters} selectedCharId={selectedCharId} onSelectChar={setSelectedCharId}
                cards={simulationState.cards} runs={simulationState.runs} notes={characterNotes} notesLoading={notesLoading}
                onOpenCard={openCard} onOpenNote={openNote}
            /> : (
                <main className="sarc-main">
                    <section className="sarc-character-section">
                        <div className="sarc-section-label"><span>01</span><div><small>SELECT SUBJECT</small><h2>选择角色母体</h2></div></div>
                        {characters.length ? <div className="sarc-character-rail">{characters.map(char => <button type="button" key={char.id} className={char.id === selectedCharId ? 'is-active' : ''} onClick={() => setSelectedCharId(char.id)}><CharacterPortrait char={char} /><span>{char.name}</span></button>)}</div> : <p className="sarc-no-character">当前没有可供铸造的角色。</p>}
                    </section>

                    <section className="sarc-assembly">
                        <div className="sarc-section-label"><span>02</span><div><small>COMPILE ISEKAI</small><h2>装入异界异格与异界坐标</h2></div></div>
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
                            {loading ? <><CircleNotch size={17} className="animate-spin" /> 正在编译异世界</> : <><Fingerprint size={17} /> 铸造异世界异格</>}
                            <small>{loading ? 'COMPILING HOT-DROP WORLDLINE' : '永久收藏 · 从剧情中后段投放'}</small>
                        </button>
                        {error && <p className="sarc-error">{error}</p>}
                        <p>模块不会被消耗。LLM 会同时生成角色异格、User 面具、当前危机与五十轮剧情引擎。</p>
                    </section>
                </main>
            )}

            {picker && <ModulePicker pool={picker} collection={gachaState.collection} onClose={() => setPicker(null)} onChoose={module => { picker === 'variant' ? setVariant(module) : setStory(module); setPicker(null); }} />}
            {loading && <div className="sarc-processing" aria-live="polite"><div className="sarc-processing__rings"><i /><i /><i /></div><span>正在编译异世界坐标</span><div className="sarc-processing__steps"><b>铸造双身份</b><b>锁定危机</b><b>写入钢印</b></div><small>PLEASE KEEP THE CABINET OPEN</small></div>}
        </div>
    );
};

const SARCabinetStyle = () => <style>{`
    .sarc-root{position:fixed;inset:0;z-index:392;overflow:hidden;color:#e7edf0;background:radial-gradient(75% 52% at 50% 24%,#1a2730 0%,#0a1117 53%,#05090d 100%);font-family:Inter,"Noto Sans SC",sans-serif;--sarc-top:var(--chrome-top);--sarc-bottom:var(--safe-bottom);transition:color .22s ease,background .22s ease}
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
    .sarc-worldline{position:relative;margin:15px 0 2px;padding:15px 14px 13px;overflow:hidden;border:1px solid #98696078;background:radial-gradient(circle at 100% 0,#8e4a4035,transparent 36%),linear-gradient(135deg,#211819,#0b1114 70%);clip-path:polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px);animation:sarc-worldline-in .5s .08s ease-out both}.sarc-worldline:before{content:"";position:absolute;left:0;right:0;top:0;height:1px;background:linear-gradient(90deg,transparent,#d19a8f,transparent);animation:sarc-worldline-scan 2.8s ease-in-out infinite}.sarc-worldline>header{display:flex;align-items:center;justify-content:space-between;color:#9c7770}.sarc-worldline>header small{font:6px/1 monospace;letter-spacing:.16em}.sarc-worldline>header b{font:500 7px/1 "Noto Serif SC",serif}.sarc-worldline>h2{margin:9px 0 5px;color:#e5cfca;font:500 19px/1.25 "Noto Serif SC",serif;letter-spacing:.1em}.sarc-worldline>p{margin:0 0 11px;color:#9f8d89;font-size:8.5px;line-height:1.65}.sarc-worldline>div{display:grid;grid-template-columns:72px 1fr;gap:3px 9px;padding:9px 0;border-top:1px solid #89645e3d}.sarc-worldline>div small{grid-row:1 / span 2;align-self:start;padding-top:2px;color:#87645e;font:5.5px/1.3 monospace;letter-spacing:.12em}.sarc-worldline>div strong{color:#d0b4ae;font:500 9px/1.2 "Noto Serif SC",serif;letter-spacing:.08em}.sarc-worldline>div span{color:#a89793;font-size:8px;line-height:1.55}
    .sarc-card-section{padding:12px 2px;border-bottom:1px solid #57727c33}.sarc-card-section small,.sarc-opening small{font:6px/1 monospace;letter-spacing:.19em;color:#6d8c97}.sarc-card-section h3{margin:5px 0 7px;font:500 12px/1.2 "Noto Serif SC",serif;letter-spacing:.1em}.sarc-card-section p{margin:0;font-size:9px;line-height:1.75;color:#9aabb0}.sarc-opening{margin-top:15px;padding:16px;border:1px solid #668b9766;background:radial-gradient(circle at 50% 0,#416a7826,transparent 45%),#081115;clip-path:polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px);opacity:.72}.sarc-opening.is-awake{opacity:1;border-color:#78a6b677}.sarc-opening__top{display:flex;justify-content:space-between;align-items:center}.sarc-opening__top>b{font:7px/1 monospace;color:#84a8b2}.sarc-opening>p{margin:10px 0 13px;font-size:9.5px;line-height:1.85;color:#aab8bc}.sarc-opening blockquote{margin:0;padding:11px 12px;border-left:1px solid #8eb9c2;background:#16262d;color:#d8e6e9;font:500 11px/1.7 "Noto Serif SC",serif}.sarc-opening blockquote b{display:block;margin-bottom:3px;font:6px/1 monospace;letter-spacing:.16em;color:#7fa0aa}.sarc-opening>div:last-child{margin-top:10px;text-align:right;font-size:7.5px;color:#718991}.sarc-result__actions{display:grid;grid-template-columns:1fr auto;gap:8px;margin-top:13px}.sarc-result__actions button{min-height:48px;padding:0 13px;border:1px solid #57737d;background:#0b161a;color:#81969d;font-size:10px}.sarc-result__actions button:first-child{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px}.sarc-result__actions button.is-primary{color:#e6f2f4;border-color:#82aeba;background:linear-gradient(110deg,#35677988,#14303a99)}.sarc-result__actions span{display:block;font-size:6px;color:#6f8992}
    .sarc-records__title{padding:3px 0 14px;border-bottom:1px solid #5d7b8644}.sarc-records__title small{font:6px/1 monospace;letter-spacing:.2em;color:#6f8e99}.sarc-records__title h2{margin:6px 0 4px;font:500 20px/1.2 "Noto Serif SC",serif;letter-spacing:.12em}.sarc-records__title p{margin:0;font-size:8px;color:#71858c}.sarc-records__list>button{width:100%;display:grid;grid-template-columns:54px 1fr auto;align-items:center;gap:10px;padding:13px 0;text-align:left;color:#c5d3d7;border:0;border-bottom:1px solid #57737d3d;background:none}.sarc-records__list>button>span{min-width:0}.sarc-records__list small,.sarc-records__list strong,.sarc-records__list em{display:block}.sarc-records__list small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:6px;color:#718b95}.sarc-records__list strong{margin-top:4px;font:500 12px/1.3 "Noto Serif SC",serif}.sarc-records__list em{margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-style:normal;font-size:7px;color:#9b7771}.sarc-records__list>button>b{font:7px/1 monospace;color:#7c969f;white-space:nowrap}.sarc-records__empty{padding:80px 0;text-align:center;font-size:9px;color:#68808a}
    .sarc-user-mask{position:relative;margin:15px 0 2px;padding:15px 14px 13px;border:1px solid #8d82ad70;background:radial-gradient(circle at 0 0,#765e9d32,transparent 38%),linear-gradient(135deg,#181521,#0b1015 72%);clip-path:polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px)}.sarc-user-mask>header{display:flex;align-items:center;justify-content:space-between;color:#958aaa}.sarc-user-mask>header small{font:6px/1 monospace;letter-spacing:.17em}.sarc-user-mask>header b{font:500 7px/1 "Noto Serif SC",serif}.sarc-user-mask>h2{margin:9px 0 7px;color:#e3dced;font:500 18px/1.25 "Noto Serif SC",serif;letter-spacing:.1em}.sarc-user-mask>div{display:grid;grid-template-columns:72px 1fr;gap:3px 9px;padding:9px 0;border-top:1px solid #756b8d40}.sarc-user-mask>div small{grid-row:1 / span 2;padding-top:2px;color:#837998;font:5.5px/1.3 monospace;letter-spacing:.12em}.sarc-user-mask>div strong{color:#c9c0da;font:500 9px/1.2 "Noto Serif SC",serif;letter-spacing:.08em}.sarc-user-mask>div p{margin:0;color:#a29aaa;font-size:8px;line-height:1.6}.sarc-user-mask>footer{padding-top:9px;border-top:1px solid #756b8d40;color:#776f84;font-size:7px;line-height:1.5}
    .sarc-archive{color:#3d4545;background-color:#eee8da;background-image:linear-gradient(90deg,transparent 27px,rgba(161,97,87,.13) 28px,transparent 29px),repeating-linear-gradient(180deg,transparent 0,transparent 27px,rgba(83,104,105,.08) 28px);animation:sarc-cabinet-switch .28s ease-out both}.sarc-archive__intro{padding:7px 12px 17px 20px;border-bottom:1px solid #8a938d55}.sarc-archive__intro>small{font:7px/1 monospace;letter-spacing:.22em;color:#758783}.sarc-archive__intro h2{margin:8px 0 6px;color:#303838;font:600 24px/1.2 "Noto Serif SC",serif;letter-spacing:.08em}.sarc-archive__intro p{max-width:320px;margin:0;color:#747a75;font-size:10px;line-height:1.7}.sarc-archive__switch{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:14px 0}.sarc-archive__switch>button{min-height:58px;display:flex;align-items:center;gap:9px;padding:10px 11px;text-align:left;color:#858b85;border:1px solid #9b9e9566;background:#e5dece99;transition:.2s}.sarc-archive__switch>button.is-active{color:#3f5656;border-color:#768e8a;background:#f8f3e8;box-shadow:0 5px 15px #5a57501a;transform:translateY(-1px)}.sarc-archive__switch>button>span,.sarc-archive__switch small{display:block}.sarc-archive__switch>button>span{font:600 10px/1.2 "Noto Serif SC",serif}.sarc-archive__switch small{margin-top:4px;color:#99988f;font:6px/1.2 sans-serif;font-weight:400}.sarc-archive__rail{display:flex;gap:9px;margin:0 -17px;padding:5px 17px 11px;overflow-x:auto;scrollbar-width:none}.sarc-archive__rail::-webkit-scrollbar{display:none}.sarc-archive__rail>button{position:relative;width:58px;flex:0 0 58px;padding:0 0 5px;color:#858980;border:0;background:none}.sarc-archive__rail>button.is-active{color:#374d4c}.sarc-archive__rail>button.is-active .sarc-portrait{border-color:#78938f;box-shadow:0 0 0 3px #eee8da,0 0 0 4px #8b9a9577}.sarc-archive__rail>button>span{display:block;margin-top:7px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:600 9px/1.2 "Noto Serif SC",serif}.sarc-archive__rail>button>b{position:absolute;right:1px;top:35px;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:#708984;color:#fff;font:7px/16px monospace}.sarc-archive__owner{display:grid;grid-template-columns:84px 1fr;align-items:center;min-height:106px;margin:2px 0 15px;padding:8px 12px 8px 4px;border-top:1px solid #87918a66;border-bottom:1px solid #87918a66;background:linear-gradient(90deg,rgba(255,255,255,.42),transparent)}.sarc-archive__owner>div{position:relative}.sarc-archive__owner>div>i{position:absolute;left:9px;right:9px;bottom:-5px;height:8px;border:1px solid #81766e66;border-top:0;border-radius:0 0 50% 50%}.sarc-archive__owner>span>small{font:6px/1 monospace;letter-spacing:.17em;color:#82908c}.sarc-archive__owner h3{margin:6px 0 5px;color:#354140;font:600 16px/1.3 "Noto Serif SC",serif}.sarc-archive__owner p{margin:0;color:#7e817a;font-size:8px;line-height:1.55}.sarc-keepsakes{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px}.sarc-keepsake{--volume-ink:#6b8789;position:relative;min-height:228px;padding:12px 11px 10px;text-align:left;color:#3c4543;border:1px solid #97988d;background:linear-gradient(105deg,var(--volume-ink) 0 5px,transparent 5px),radial-gradient(circle at 80% 0,rgba(255,255,255,.9),transparent 35%),#f7f1e4;box-shadow:3px 5px 0 #c8c0b0,0 10px 20px #4a47401c;overflow:hidden;animation:sarc-volume-in .38s ease-out both}.sarc-keepsake.is-1{--volume-ink:#a56f67;animation-delay:.04s}.sarc-keepsake.is-2{--volume-ink:#82799d;animation-delay:.08s}.sarc-keepsake.is-3{--volume-ink:#7d8960;animation-delay:.12s}.sarc-keepsake:before{content:"";position:absolute;inset:5px;border:1px solid #7c8f8b44;pointer-events:none}.sarc-keepsake__portrait{position:relative;display:flex;align-items:flex-start;justify-content:space-between}.sarc-keepsake__portrait .sarc-portrait{width:44px;height:44px;margin:0}.sarc-keepsake__portrait>span{padding-top:2px;color:#95958a;font:6px/1 monospace;letter-spacing:.08em}.sarc-keepsake>small{display:block;margin-top:14px;color:var(--volume-ink);font:7px/1.25 sans-serif;font-weight:700;letter-spacing:.08em}.sarc-keepsake h3{margin:6px 0 8px;display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2;color:#343b3a;font:600 15px/1.35 "Noto Serif SC",serif}.sarc-keepsake blockquote{margin:0;display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:3;color:#767870;font:9px/1.65 "Noto Serif SC",serif}.sarc-keepsake>footer{position:absolute;left:11px;right:11px;bottom:10px;display:flex;align-items:center;justify-content:space-between;padding-top:8px;border-top:1px solid #aaa99e77;color:#797d76;font-size:7px}.sarc-keepsake>footer span{color:var(--volume-ink);font-weight:700}.sarc-keepsake>footer b{font-weight:500}.sarc-character-notes{display:grid;gap:12px}.sarc-character-notes>button{position:relative;padding:15px 16px 13px 20px;text-align:left;color:#414846;border:1px solid #a7a093;background:linear-gradient(90deg,#7d8e89 0 4px,transparent 4px),#f8f2e7;box-shadow:2px 4px 0 #c9c0ae;animation:sarc-volume-in .35s ease-out both}.sarc-character-notes>button:before{content:"";position:absolute;right:13px;top:-4px;width:34px;height:10px;background:#d4bd8d77;transform:rotate(2deg)}.sarc-character-notes header,.sarc-character-notes footer{display:flex;align-items:center;justify-content:space-between}.sarc-character-notes header{color:#8a8a80;font-size:7px}.sarc-character-notes header b{color:#8d645e;font-weight:600}.sarc-character-notes h3{margin:9px 0 8px;color:#343a39;font:600 17px/1.35 "Noto Serif SC",serif}.sarc-character-notes>button>div{display:flex;align-items:center;gap:6px;color:#6e7d79;font-size:7px}.sarc-character-notes>button>div i{font-style:normal;padding:3px 6px;border:1px solid #8c9a9666}.sarc-character-notes>button>div em{font-style:normal;color:#aaa398}.sarc-character-notes blockquote{margin:12px 0 11px;padding:9px 10px;border-left:2px solid #a97167;background:#ece2d3;color:#665f5b;font:10px/1.65 "Noto Serif SC",serif}.sarc-character-notes footer{padding-top:9px;border-top:1px dashed #a6a19788;color:#88877e;font-size:7px}.sarc-character-notes footer span{font-size:12px;color:#667c78}.sarc-archive__empty{min-height:240px;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:28px;text-align:center;color:#87908a}.sarc-archive__empty h3{margin:12px 0 5px;color:#5d6662;font:600 14px/1.3 "Noto Serif SC",serif}.sarc-archive__empty p{max-width:245px;margin:0;font-size:9px;line-height:1.7}.sarc-note-view{position:relative;z-index:2;height:calc(100% - var(--sarc-top) - 55px);overflow:auto;padding:17px 15px calc(var(--sarc-bottom) + 22px);color:#3d4442;background:#e8e0d0 repeating-linear-gradient(180deg,transparent 0,transparent 29px,rgba(89,102,98,.07) 30px);scrollbar-width:none}.sarc-note-view::-webkit-scrollbar{display:none}.sarc-note-view>article{position:relative;max-width:600px;margin:0 auto;padding:18px 17px 16px;border:1px solid #a29a8c;background:#f8f2e7;box-shadow:4px 7px 0 #bdb3a2,0 20px 40px #4e494029;animation:sarc-note-in .38s ease-out both}.sarc-note-view>article:before{content:"PRIVATE";position:absolute;right:17px;top:15px;padding:4px 7px;border:1px solid #a8685f88;color:#9e625b;font:7px/1 monospace;letter-spacing:.14em;transform:rotate(3deg)}.sarc-note-view>article>header{display:grid;grid-template-columns:82px 1fr;align-items:center;gap:13px;padding:6px 0 17px;border-bottom:1px solid #9c9c9277}.sarc-note-view>article>header .sarc-portrait{margin:0}.sarc-note-view>article>header small{font:6px/1.2 monospace;letter-spacing:.14em;color:#8c928c}.sarc-note-view>article>header h2{margin:7px 0 5px;padding-right:45px;color:#343b39;font:600 21px/1.3 "Noto Serif SC",serif}.sarc-note-view>article>header p{margin:0;color:#88877f;font-size:8px;line-height:1.5}.sarc-note-view__chips{display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:center;padding:13px 0}.sarc-note-view__chips>span{padding:9px;border:1px solid #8c999477;background:#eee7da}.sarc-note-view__chips small,.sarc-note-view__chips b{display:block}.sarc-note-view__chips small{color:#92958e;font-size:6px}.sarc-note-view__chips b{margin-top:4px;color:#596c68;font:600 10px/1.35 "Noto Serif SC",serif}.sarc-note-view__chips>i{font-style:normal;color:#9b9489}.sarc-note-view>article>blockquote{margin:2px 0 18px;padding:13px 14px;border-left:3px double #a96e64;background:#ebe0d1;color:#5d5551;font:600 12px/1.75 "Noto Serif SC",serif}.sarc-note-view section{padding:4px 1px 17px}.sarc-note-view section+section{padding-top:17px;border-top:1px dashed #9b9a9088}.sarc-note-view section small{font:6px/1 monospace;letter-spacing:.18em;color:#7f908c}.sarc-note-view section h3{margin:6px 0 9px;color:#414b48;font:600 14px/1.3 "Noto Serif SC",serif}.sarc-note-view section p{margin:0;white-space:pre-wrap;color:#5e625e;font-size:11px;line-height:1.9}.sarc-note-view section.is-handwritten p{color:#625b57;font-family:"Noto Serif SC",serif}.sarc-note-view>article>footer{padding:12px 0 0;border-top:1px solid #9b9b9177;color:#8e8d84;font-size:7px;line-height:1.6}
    @keyframes sarc-spin{to{transform:rotate(360deg)}}@keyframes sarc-stage{0%,30%,100%{color:#526b74}10%,20%{color:#c6e1e6;text-shadow:0 0 10px #7db6c7}}@keyframes sarc-card-in{from{opacity:0;transform:translateY(12px) scale(.985)}to{opacity:1;transform:none}}@keyframes sarc-card-sheen{to{transform:translateX(120%)}}@keyframes sarc-worldline-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}@keyframes sarc-worldline-scan{0%,100%{opacity:.25;transform:scaleX(.35)}50%{opacity:1;transform:scaleX(1)}}@keyframes sarc-cabinet-switch{from{opacity:.45;transform:translateX(7px)}to{opacity:1;transform:none}}@keyframes sarc-volume-in{from{opacity:0;transform:translateY(9px) rotate(.4deg)}to{opacity:1;transform:none}}@keyframes sarc-note-in{from{opacity:0;transform:translateY(15px) scale(.985)}to{opacity:1;transform:none}}
    @media(max-height:700px){.sarc-character-rail{margin-top:9px}.sarc-assembly{margin-top:12px}.sarc-assembly__core{height:252px}.sarc-assembly__core:before{top:10px;width:105px;height:105px}.sarc-assembly__subject{top:23px}.sarc-assembly__subject .sarc-portrait--large{width:66px;height:66px}.sarc-assembly__line{top:100px}.sarc-socket{height:122px}.sarc-socket__glyph{width:36px;height:36px;margin-top:6px}.sarc-socket>strong{font-size:10px}.sarc-start{margin-top:9px}}
    @media(min-width:700px){.sarc-main,.sarc-records,.sarc-result{max-width:600px;margin:0 auto}.sarc-picker{max-width:600px;margin:0 auto}.sarc-assembly__slots{gap:20px}}
    @media(prefers-reduced-motion:reduce){.sarc-root *{animation-duration:.01ms!important;animation-iteration-count:1!important}}
    /* Archive, dossier and reading routes share one continuous paper surface. */
    .sarc-root.is-paper-surface{color:#354240;background:#eee8da}
    .sarc-root.is-paper-surface .sarc-grid-bg{opacity:.42;background-image:linear-gradient(rgba(82,109,106,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(82,109,106,.045) 1px,transparent 1px);mask:none}
    .sarc-root.is-paper-surface .sarc-header{color:#34413f;border-bottom-color:#89958f66;background:#f3eee3;box-shadow:0 5px 18px #514d4514;backdrop-filter:none}
    .sarc-root.is-paper-surface .sarc-header>button{color:#536a66;border-color:#87969077;background:#ebe4d7}
    .sarc-root.is-paper-surface .sarc-header small{color:#718783}.sarc-root.is-paper-surface .sarc-header h1{color:#303b39}
    .sarc-root.is-paper-surface .sarc-header__records i{color:#778984}
    .sarc-root.is-paper-surface .sarc-portrait{color:#546b67;border-color:#879994;background:radial-gradient(circle,#f9f4e9,#ddd6c8);box-shadow:none}
    .sarc-root.is-paper-surface .sarc-portrait:before{border-color:#778d8840}.sarc-root.is-paper-surface .sarc-portrait i{background:#6f8d87;box-shadow:0 0 0 2px #eee8da}
    .sarc-root.is-paper-surface .sarc-result{color:#394542;background-color:#eee8da;background-image:linear-gradient(90deg,transparent 27px,rgba(161,97,87,.11) 28px,transparent 29px),repeating-linear-gradient(180deg,transparent 0,transparent 27px,rgba(83,104,105,.07) 28px)}
    .sarc-root.is-paper-surface .sarc-result__status{color:#667f7b}
    .sarc-root.is-paper-surface .sarc-identity-card{color:#34413f;border-color:#829792;background:radial-gradient(circle at 82% 8%,#fff 0,transparent 34%),linear-gradient(105deg,#6f8985 0 6px,transparent 6px),#f8f2e7;box-shadow:inset 0 0 0 4px #f8f2e7,inset 0 0 0 5px #6e89854d,4px 7px 0 #c4bcad,0 18px 35px #4f4a411c}
    .sarc-root.is-paper-surface .sarc-identity-card:before{background:linear-gradient(112deg,transparent 30%,#fff9 48%,transparent 62%)}
    .sarc-root.is-paper-surface .sarc-card__ornament{border-color:#66827d}.sarc-root.is-paper-surface .sarc-card__header{color:#6f837f;border-bottom-color:#81918c66}
    .sarc-root.is-paper-surface .sarc-card__hero small{color:#71837f}.sarc-root.is-paper-surface .sarc-card__hero h2{color:#303b39}.sarc-root.is-paper-surface .sarc-card__hero p{color:#707873}
    .sarc-root.is-paper-surface .sarc-card__modules{color:#687d79;border-color:#84938e55}.sarc-root.is-paper-surface .sarc-card__modules i{color:#9a958b}
    .sarc-root.is-paper-surface .sarc-steel-seal{border-color:#a9797066;background:#eee0d5}.sarc-root.is-paper-surface .sarc-steel-seal:after{border-color:#a9797033}
    .sarc-root.is-paper-surface .sarc-steel-seal__mark{color:#9e6258;border-color:#a96f65;box-shadow:none}.sarc-root.is-paper-surface .sarc-steel-seal small{color:#98685f}.sarc-root.is-paper-surface .sarc-steel-seal h3{color:#874f47}.sarc-root.is-paper-surface .sarc-steel-seal blockquote{color:#5e5550}.sarc-root.is-paper-surface .sarc-card__serial{color:#7b8884}
    .sarc-root.is-paper-surface .sarc-user-mask{color:#414448;border-color:#9086a366;background:#e8e3ed}.sarc-root.is-paper-surface .sarc-user-mask>header{color:#776e8c}.sarc-root.is-paper-surface .sarc-user-mask>h2{color:#4f485c}.sarc-root.is-paper-surface .sarc-user-mask>div{border-color:#8e85a044}.sarc-root.is-paper-surface .sarc-user-mask>div small{color:#817891}.sarc-root.is-paper-surface .sarc-user-mask>div strong{color:#5a5367}.sarc-root.is-paper-surface .sarc-user-mask>div p{color:#69656f}.sarc-root.is-paper-surface .sarc-user-mask>footer{color:#77727c;border-color:#8e85a044}
    .sarc-root.is-paper-surface .sarc-worldline{color:#46413e;border-color:#a8736966;background:#eee0d8}.sarc-root.is-paper-surface .sarc-worldline:before{background:linear-gradient(90deg,transparent,#a76d63,transparent)}.sarc-root.is-paper-surface .sarc-worldline>header{color:#8e625a}.sarc-root.is-paper-surface .sarc-worldline>h2{color:#684a45}.sarc-root.is-paper-surface .sarc-worldline>p{color:#706864}.sarc-root.is-paper-surface .sarc-worldline>div{border-color:#a3746b42}.sarc-root.is-paper-surface .sarc-worldline>div small{color:#8d655d}.sarc-root.is-paper-surface .sarc-worldline>div strong{color:#684d48}.sarc-root.is-paper-surface .sarc-worldline>div span{color:#706966}
    .sarc-root.is-paper-surface .sarc-card-section{border-color:#89958f55}.sarc-root.is-paper-surface .sarc-card-section small,.sarc-root.is-paper-surface .sarc-opening small{color:#718783}.sarc-root.is-paper-surface .sarc-card-section h3{color:#3f4c49}.sarc-root.is-paper-surface .sarc-card-section p{color:#666f6b;font-size:10px}
    .sarc-root.is-paper-surface .sarc-opening{color:#3e4a47;border-color:#80958f66;background:#e3e8e1}.sarc-root.is-paper-surface .sarc-opening.is-awake{border-color:#718d87}.sarc-root.is-paper-surface .sarc-opening__top>b{color:#637c77}.sarc-root.is-paper-surface .sarc-opening>p{color:#626d69}.sarc-root.is-paper-surface .sarc-opening blockquote{color:#394541;border-left-color:#748e88;background:#f3f0e7}.sarc-root.is-paper-surface .sarc-opening blockquote b{color:#657e79}.sarc-root.is-paper-surface .sarc-opening>div:last-child{color:#77827e}
    .sarc-root.is-paper-surface .sarc-result__actions button{color:#596a66;border-color:#82918c;background:#e7e0d3}.sarc-root.is-paper-surface .sarc-result__actions button.is-primary{color:#fff;border-color:#536f69;background:#5f7c76}.sarc-root.is-paper-surface .sarc-result__actions span{color:inherit;opacity:.68}
    /* Retired v3 experiment: intentionally disabled after mobile review.
    .sarc-root.is-paper-surface{--aether-ink:#27304d;--aether-muted:#68708c;--aether-violet:#7268b8;--aether-cyan:#4b9aa8;--aether-rose:#a75f86;--aether-line:#7d82b35c;color:var(--aether-ink);background:radial-gradient(circle at 88% 7%,#d9d1fb 0,transparent 29%),radial-gradient(circle at 2% 49%,#c8eef0 0,transparent 34%),radial-gradient(circle at 80% 92%,#f1d9ec 0,transparent 31%),linear-gradient(155deg,#f8faff 0,#eff1fb 46%,#edf7f7 100%)}
    .sarc-root.is-paper-surface .sarc-grid-bg{opacity:.72;background-image:radial-gradient(circle at 83% 15%,transparent 0 71px,#7773b72b 72px,transparent 73px 91px,#55a1aa17 92px,transparent 93px),linear-gradient(#696ea80d 1px,transparent 1px),linear-gradient(90deg,#696ea80b 1px,transparent 1px);background-size:auto,32px 32px,32px 32px;mask:linear-gradient(#000,rgba(0,0,0,.2) 78%,transparent)}
    .sarc-root.is-paper-surface .sarc-header{color:var(--aether-ink);border:0;background:linear-gradient(105deg,rgba(250,252,255,.9),rgba(238,239,255,.86) 54%,rgba(235,249,250,.88));box-shadow:0 1px 0 #8589b45c,0 8px 30px #4d538919;backdrop-filter:blur(18px) saturate(1.25)}
    .sarc-root.is-paper-surface .sarc-header:after{content:"";position:absolute;left:18%;right:18%;bottom:-1px;height:1px;background:linear-gradient(90deg,transparent,#756bc9,#59b6c0,transparent);box-shadow:0 0 9px #766fd277}
    .sarc-root.is-paper-surface .sarc-header>button{color:#555d92;border:1px solid #7b80ae66;background:linear-gradient(145deg,rgba(255,255,255,.82),rgba(222,225,247,.72));box-shadow:inset 0 0 0 1px #fff9,0 5px 15px #5c60911c}
    .sarc-root.is-paper-surface .sarc-header>div{position:relative}.sarc-root.is-paper-surface .sarc-header>div:before{content:"✦";position:absolute;left:50%;top:-9px;transform:translateX(-50%);color:#6f75b2;font-size:7px;text-shadow:0 0 8px #7b74d2}
    .sarc-root.is-paper-surface .sarc-header small{color:#7278a3}.sarc-root.is-paper-surface .sarc-header h1{color:#28304d;text-shadow:0 1px #fff}
    .sarc-root.is-paper-surface .sarc-header__records i{color:#73799a}
    .sarc-root.is-paper-surface .sarc-archive{background:transparent;animation:sarc-aether-reveal .38s ease-out both}
    .sarc-root.is-paper-surface .sarc-archive__intro{position:relative;min-height:126px;padding:17px 132px 20px 20px;overflow:hidden;border-bottom:1px solid var(--aether-line)}
    .sarc-root.is-paper-surface .sarc-archive__intro:before{content:"";position:absolute;right:17px;top:7px;width:104px;height:104px;border:1px solid #7772b759;border-radius:50%;background:repeating-conic-gradient(from 8deg,transparent 0 12deg,#6d69b52b 13deg 14deg,transparent 15deg 42deg);box-shadow:inset 0 0 0 13px #fff4,inset 0 0 0 14px #5d9eaa24,0 0 30px #8177d42b;animation:sarc-aether-orbit 18s linear infinite}
    .sarc-root.is-paper-surface .sarc-archive__intro:after{content:"";position:absolute;right:51px;top:41px;width:36px;height:36px;background:conic-gradient(from 45deg,#6d66b9,#4ba5ae,#b15f8c,#6d66b9);clip-path:polygon(50% 0,60% 38%,100% 50%,60% 60%,50% 100%,40% 60%,0 50%,40% 38%);filter:drop-shadow(0 0 9px #766dcc88);animation:sarc-aether-heart 3.4s ease-in-out infinite}
    .sarc-root.is-paper-surface .sarc-archive__intro>small{color:#6b72a4;font:700 7px/1 monospace;letter-spacing:.18em}.sarc-root.is-paper-surface .sarc-archive__intro h2{margin-top:10px;color:#252d4c;font-size:25px;letter-spacing:.06em}.sarc-root.is-paper-surface .sarc-archive__intro p{color:#69708b;font-size:10px;line-height:1.65}
    .sarc-root.is-paper-surface .sarc-archive__switch{gap:9px;margin:14px 0 16px}
    .sarc-root.is-paper-surface .sarc-archive__switch>button{position:relative;min-height:62px;color:#7a7f9b;border:1px solid #8589ad59;background:linear-gradient(140deg,rgba(255,255,255,.48),rgba(226,229,246,.44));clip-path:polygon(9px 0,100% 0,100% calc(100% - 9px),calc(100% - 9px) 100%,0 100%,0 9px);box-shadow:inset 0 0 0 1px #fff8}
    .sarc-root.is-paper-surface .sarc-archive__switch>button:before{content:"";position:absolute;left:0;top:10px;bottom:10px;width:2px;background:#7774b46b;box-shadow:0 0 8px #7774b477}
    .sarc-root.is-paper-surface .sarc-archive__switch>button.is-active{color:#323a68;border-color:#6d70ad8c;background:radial-gradient(circle at 88% 0,#d6ccfb 0,transparent 42%),linear-gradient(140deg,rgba(255,255,255,.92),rgba(229,238,248,.8));box-shadow:inset 0 0 0 1px #fff,0 10px 25px #555b9a25;transform:translateY(-2px)}
    .sarc-root.is-paper-surface .sarc-archive__switch>button.is-active:before{background:linear-gradient(#7167bd,#4ca6ad);box-shadow:0 0 12px #6f6fc9}.sarc-root.is-paper-surface .sarc-archive__switch small{color:#858aa5}
    .sarc-root.is-paper-surface .sarc-archive__rail{padding-top:9px}.sarc-root.is-paper-surface .sarc-archive__rail>button{color:#747a96}.sarc-root.is-paper-surface .sarc-archive__rail>button:before{content:"";position:absolute;left:50%;top:21px;width:1px;height:42px;transform:translateX(-50%) scaleY(0);transform-origin:top;background:linear-gradient(#6f68bd,transparent);transition:.24s}
    .sarc-root.is-paper-surface .sarc-archive__rail>button.is-active{color:#383f6a}.sarc-root.is-paper-surface .sarc-archive__rail>button.is-active:before{transform:translateX(-50%) scaleY(1)}
    .sarc-root.is-paper-surface .sarc-portrait{color:#4d5682;border-color:#767bab80;background:radial-gradient(circle at 35% 28%,#fff,#e5e7f6 54%,#cbdde2);box-shadow:inset 0 0 0 3px #fff7,0 0 0 1px #fff,0 8px 22px #555b9628}
    .sarc-root.is-paper-surface .sarc-portrait:before{border-color:#6d72a858}.sarc-root.is-paper-surface .sarc-portrait i{background:#5aa4ac;box-shadow:0 0 0 2px #f4f5fd,0 0 10px #46a5b4}
    .sarc-root.is-paper-surface .sarc-archive__rail>button.is-active .sarc-portrait{border-color:#6e69b8;box-shadow:inset 0 0 0 3px #fff8,0 0 0 3px #eff1fb,0 0 0 4px #7371b47a,0 0 25px #766fd269;animation:sarc-aether-heart 3s ease-in-out infinite}
    .sarc-root.is-paper-surface .sarc-archive__rail>button>b{background:linear-gradient(135deg,#7066b8,#499ba7);box-shadow:0 0 10px #6e6bc477}
    .sarc-root.is-paper-surface .sarc-archive__owner{position:relative;overflow:hidden;min-height:112px;padding-right:18px;border:1px solid #7e83ad5c;background:radial-gradient(circle at 5% 50%,#d5e9eea8,transparent 26%),linear-gradient(115deg,rgba(255,255,255,.74),rgba(227,229,247,.55));clip-path:polygon(11px 0,100% 0,100% calc(100% - 11px),calc(100% - 11px) 100%,0 100%,0 11px);box-shadow:inset 0 0 0 1px #fff9,0 12px 30px #565b8e1b}
    .sarc-root.is-paper-surface .sarc-archive__owner:before{content:"";position:absolute;right:-25px;top:-49px;width:136px;height:136px;border:1px solid #6c70ad26;border-radius:50%;box-shadow:inset 0 0 0 21px #fff2,inset 0 0 0 22px #4d9ca318}
    .sarc-root.is-paper-surface .sarc-archive__owner:after{content:"SOUL INDEX // LINK STABLE";position:absolute;right:13px;bottom:8px;color:#7479a06d;font:6px/1 monospace;letter-spacing:.12em}
    .sarc-root.is-paper-surface .sarc-archive__owner>span{position:relative;z-index:1}.sarc-root.is-paper-surface .sarc-archive__owner>span>small{color:#6a70a0}.sarc-root.is-paper-surface .sarc-archive__owner h3{color:#2e365d;font-size:17px}.sarc-root.is-paper-surface .sarc-archive__owner p{color:#747992}
    .sarc-root.is-paper-surface .sarc-keepsakes{gap:12px}.sarc-root.is-paper-surface .sarc-keepsake{--volume-ink:#6d6eb2;min-height:236px;color:#303856;border:1px solid #7f83ad66;background:radial-gradient(circle at 92% 5%,#d8d0fb 0,transparent 31%),linear-gradient(110deg,var(--volume-ink) 0 3px,transparent 3px),linear-gradient(145deg,rgba(255,255,255,.89),rgba(229,233,249,.76));clip-path:polygon(0 0,calc(100% - 13px) 0,100% 13px,100% 100%,13px 100%,0 calc(100% - 13px));box-shadow:inset 0 0 0 1px #fff9,0 12px 28px #51578d24}
    .sarc-root.is-paper-surface .sarc-keepsake.is-1{--volume-ink:#a45d83}.sarc-root.is-paper-surface .sarc-keepsake.is-2{--volume-ink:#4e939f}.sarc-root.is-paper-surface .sarc-keepsake.is-3{--volume-ink:#7770b9}
    .sarc-root.is-paper-surface .sarc-keepsake:before{inset:7px;border:1px solid #767bb13d;clip-path:polygon(0 0,calc(100% - 9px) 0,100% 9px,100% 100%,9px 100%,0 calc(100% - 9px))}.sarc-root.is-paper-surface .sarc-keepsake:after{content:"";position:absolute;left:17px;right:17px;top:71px;height:1px;background:linear-gradient(90deg,var(--volume-ink),transparent);box-shadow:0 0 8px var(--volume-ink);opacity:.58}
    .sarc-root.is-paper-surface .sarc-keepsake:active{transform:translateY(2px) scale(.985)}.sarc-root.is-paper-surface .sarc-keepsake__portrait>span{color:#72789b}.sarc-root.is-paper-surface .sarc-keepsake>small{color:var(--volume-ink);letter-spacing:.1em}.sarc-root.is-paper-surface .sarc-keepsake h3{color:#2d3455}.sarc-root.is-paper-surface .sarc-keepsake blockquote{color:#68708a}.sarc-root.is-paper-surface .sarc-keepsake>footer{border-color:#7d82ae55;color:#717792}.sarc-root.is-paper-surface .sarc-keepsake>footer span{color:var(--volume-ink)}
    .sarc-root.is-paper-surface .sarc-character-notes>button{overflow:hidden;color:#303856;border:1px solid #7c81ad66;background:radial-gradient(circle at 100% 0,#dcd2fc 0,transparent 32%),linear-gradient(110deg,#55a0a8 0 3px,transparent 3px),linear-gradient(145deg,rgba(255,255,255,.88),rgba(232,235,249,.78));clip-path:polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px);box-shadow:inset 0 0 0 1px #fff8,0 11px 27px #54598d22}
    .sarc-root.is-paper-surface .sarc-character-notes>button:before{content:"✦";right:15px;top:13px;width:29px;height:29px;display:grid;place-items:center;border:1px solid #7973b766;border-radius:50%;color:#736cba;background:#f4f3ff99;box-shadow:0 0 16px #7b72c94f;transform:none}.sarc-root.is-paper-surface .sarc-character-notes header{color:#747a98}.sarc-root.is-paper-surface .sarc-character-notes header b{color:#8d5b80}.sarc-root.is-paper-surface .sarc-character-notes h3{padding-right:35px;color:#2b3355}.sarc-root.is-paper-surface .sarc-character-notes>button>div{color:#67749a}.sarc-root.is-paper-surface .sarc-character-notes>button>div i{border-color:#777fb061;background:#fff6}.sarc-root.is-paper-surface .sarc-character-notes blockquote{color:#555d7d;border-left-color:#9d5c86;background:#ede4f4a6}.sarc-root.is-paper-surface .sarc-character-notes footer{color:#727995;border-color:#7e82aa66}.sarc-root.is-paper-surface .sarc-character-notes footer span{color:#5964a0}
    .sarc-root.is-paper-surface .sarc-archive__empty{position:relative;overflow:hidden;color:#767d99}.sarc-root.is-paper-surface .sarc-archive__empty:before{content:"";position:absolute;width:142px;height:142px;border:1px solid #7377ad3b;border-radius:50%;background:repeating-conic-gradient(transparent 0 28deg,#6d72b522 29deg 30deg);box-shadow:inset 0 0 0 20px #fff2,inset 0 0 0 21px #5ba0aa1c;animation:sarc-aether-orbit 22s linear infinite}.sarc-root.is-paper-surface .sarc-archive__empty>*{position:relative;z-index:1}.sarc-root.is-paper-surface .sarc-archive__empty>svg{color:#686fae;filter:drop-shadow(0 0 9px #7570bf66)}.sarc-root.is-paper-surface .sarc-archive__empty h3{color:#434b73}.sarc-root.is-paper-surface .sarc-archive__empty p{color:#747b96}
    .sarc-root.is-paper-surface .sarc-note-view{background:radial-gradient(circle at 90% 6%,#d9d0f6 0,transparent 30%),radial-gradient(circle at 5% 82%,#ccebed 0,transparent 32%),linear-gradient(155deg,#f5f7ff,#eef1fb)}.sarc-root.is-paper-surface .sarc-note-view>article{color:#303856;border:1px solid #7e83ae66;background:linear-gradient(145deg,rgba(255,255,255,.9),rgba(231,235,249,.82));clip-path:polygon(13px 0,100% 0,100% calc(100% - 13px),calc(100% - 13px) 100%,0 100%,0 13px);box-shadow:inset 0 0 0 1px #fff,0 20px 45px #54598b2c}.sarc-root.is-paper-surface .sarc-note-view>article:before{content:"✦ PRIVATE ECHO";color:#7c5d9a;border-color:#826fb266;background:#f2efffb8;box-shadow:0 0 15px #776fc33b}.sarc-root.is-paper-surface .sarc-note-view>article>header{border-color:#7e83ad5c}.sarc-root.is-paper-surface .sarc-note-view>article>header small{color:#73799c}.sarc-root.is-paper-surface .sarc-note-view>article>header h2{color:#2b3354}.sarc-root.is-paper-surface .sarc-note-view>article>header p{color:#727895}.sarc-root.is-paper-surface .sarc-note-view__chips>span{border-color:#7d82ae61;background:#eef0fa}.sarc-root.is-paper-surface .sarc-note-view__chips small{color:#7a80a0}.sarc-root.is-paper-surface .sarc-note-view__chips b{color:#4d5682}.sarc-root.is-paper-surface .sarc-note-view>article>blockquote{color:#525b7a;border-color:#9c5d83;background:#ede5f3}.sarc-root.is-paper-surface .sarc-note-view section+section{border-color:#7d82a75c}.sarc-root.is-paper-surface .sarc-note-view section small{color:#6872a3}.sarc-root.is-paper-surface .sarc-note-view section h3{color:#343d63}.sarc-root.is-paper-surface .sarc-note-view section p{color:#5f6681}.sarc-root.is-paper-surface .sarc-note-view>article>footer{color:#777d98;border-color:#7e82a95c}
    .sarc-root.is-paper-surface .sarc-result{background:radial-gradient(circle at 90% 5%,#d9d1f6 0,transparent 27%),radial-gradient(circle at 3% 52%,#ccebed 0,transparent 31%),linear-gradient(155deg,#f7f9ff,#edf1fa)}.sarc-root.is-paper-surface .sarc-result__status{color:#626aa2;text-shadow:0 0 10px #7770c966}
    .sarc-root.is-paper-surface .sarc-identity-card{color:#2f3757;border-color:#7479ad80;background:radial-gradient(circle at 88% 6%,#d9cffb 0,transparent 28%),linear-gradient(110deg,#666db0 0 3px,transparent 3px),linear-gradient(145deg,rgba(255,255,255,.91),rgba(226,232,248,.83));box-shadow:inset 0 0 0 4px #f5f6fd,inset 0 0 0 5px #7479ad52,0 20px 45px #4f558d2b}.sarc-root.is-paper-surface .sarc-card__ornament{border-color:#716db8}.sarc-root.is-paper-surface .sarc-card__header{color:#6971a3;border-color:#7a80ad55}.sarc-root.is-paper-surface .sarc-card__hero small{color:#6871a0}.sarc-root.is-paper-surface .sarc-card__hero h2{color:#252d4e}.sarc-root.is-paper-surface .sarc-card__hero p{color:#68708c}.sarc-root.is-paper-surface .sarc-card__modules{color:#5e6996;border-color:#7b80ac55}.sarc-root.is-paper-surface .sarc-card__modules i{color:#8b79a4}
    .sarc-root.is-paper-surface .sarc-steel-seal{border-color:#a05f8466;background:radial-gradient(circle at 100% 0,#edcfe4,transparent 45%),#efe5f0}.sarc-root.is-paper-surface .sarc-steel-seal__mark{color:#9b547d;border-color:#a45d85;box-shadow:0 0 18px #a35c8550}.sarc-root.is-paper-surface .sarc-steel-seal h3{color:#7c4667}.sarc-root.is-paper-surface .sarc-steel-seal blockquote{color:#5b5268}.sarc-root.is-paper-surface .sarc-card__serial{color:#70779b}
    .sarc-root.is-paper-surface .sarc-user-mask{border-color:#7771b671;background:radial-gradient(circle at 0 0,#d6cff7,transparent 39%),linear-gradient(140deg,#edeafb,#e2e6f5)}.sarc-root.is-paper-surface .sarc-user-mask>h2{color:#49476f}.sarc-root.is-paper-surface .sarc-user-mask>div strong{color:#535477}.sarc-root.is-paper-surface .sarc-user-mask>div p{color:#686b86}.sarc-root.is-paper-surface .sarc-worldline{border-color:#a35e846b;background:radial-gradient(circle at 100% 0,#efd2e4,transparent 37%),linear-gradient(140deg,#f2e7f0,#eceaf6)}.sarc-root.is-paper-surface .sarc-worldline>h2{color:#70415e}.sarc-root.is-paper-surface .sarc-worldline>p,.sarc-root.is-paper-surface .sarc-worldline>div span{color:#6d667c}
    .sarc-root.is-paper-surface .sarc-card-section{position:relative;padding-left:18px;border-color:#7b80aa4f}.sarc-root.is-paper-surface .sarc-card-section:before{content:"";position:absolute;left:2px;top:18px;width:6px;height:6px;border:1px solid #6a70ad;border-radius:50%;background:#eef0fb;box-shadow:0 0 9px #696fc177}.sarc-root.is-paper-surface .sarc-card-section:after{content:"";position:absolute;left:5px;top:26px;bottom:-1px;width:1px;background:linear-gradient(#6d73aa66,transparent)}.sarc-root.is-paper-surface .sarc-card-section small,.sarc-root.is-paper-surface .sarc-opening small{color:#6872a2}.sarc-root.is-paper-surface .sarc-card-section h3{color:#353d62}.sarc-root.is-paper-surface .sarc-card-section p{color:#646b86}
    .sarc-root.is-paper-surface .sarc-opening{border-color:#5d9ba56b;background:radial-gradient(circle at 50% 0,#ccecef,transparent 48%),linear-gradient(145deg,#f4f7ff,#e5eff4)}.sarc-root.is-paper-surface .sarc-opening blockquote{color:#37435e;border-color:#5799a3;background:#f7f9ff}.sarc-root.is-paper-surface .sarc-result__actions button{color:#5b638b;border-color:#7c82ac69;background:linear-gradient(145deg,#f7f8ff,#e5e8f5)}.sarc-root.is-paper-surface .sarc-result__actions button.is-primary{color:#fff;border-color:#6669a9;background:linear-gradient(120deg,#6862aa,#4e97a3);box-shadow:0 8px 21px #555b9b43}
    .sarc-root.is-machine-surface{background:radial-gradient(circle at 77% 13%,#35245c 0,transparent 31%),radial-gradient(circle at 18% 68%,#123c49 0,transparent 36%),linear-gradient(155deg,#09091a,#060b13 58%,#0b0715)}.sarc-root.is-machine-surface .sarc-grid-bg{opacity:.5;background-image:radial-gradient(circle at 50% 34%,transparent 0 91px,#7a6ad331 92px,transparent 93px 124px,#4ca1ae1e 125px,transparent 126px),linear-gradient(#746bc20c 1px,transparent 1px),linear-gradient(90deg,#4e9cae0c 1px,transparent 1px);background-size:auto,28px 28px,28px 28px}.sarc-root.is-machine-surface .sarc-header{border-color:#7768bd38;background:linear-gradient(100deg,rgba(8,8,24,.88),rgba(15,12,33,.82));box-shadow:0 1px 0 #7d6dcc38,0 8px 30px #0006}.sarc-root.is-machine-surface .sarc-header>button{border-color:#776bc358;background:#15142b;color:#c9c6ef}.sarc-root.is-machine-surface .sarc-header small{color:#817ac0}.sarc-root.is-machine-surface .sarc-header h1{color:#ecebff}.sarc-root.is-machine-surface .sarc-section-label>span{color:#8b7bd1}.sarc-root.is-machine-surface .sarc-section-label>div{border-color:#7e70c552}.sarc-root.is-machine-surface .sarc-section-label small{color:#7f78bb}
    .sarc-root.is-machine-surface .sarc-assembly__core{background:radial-gradient(circle at 50% 30%,#765fc21f,transparent 33%),radial-gradient(circle at 50% 30%,#43a4b51a,transparent 48%)}.sarc-root.is-machine-surface .sarc-assembly__core:before{border-color:#8b79d355;box-shadow:0 0 0 18px #7765c40d,0 0 0 19px #5fa1b12e,0 0 38px #725fc23b}.sarc-root.is-machine-surface .sarc-assembly__core:after{content:"";position:absolute;left:50%;top:4px;width:158px;height:158px;transform:translateX(-50%);border-radius:50%;background:repeating-conic-gradient(from 0deg,transparent 0 18deg,#8371ce55 19deg 20deg,transparent 21deg 44deg);mask:radial-gradient(circle,transparent 0 69px,#000 70px 72px,transparent 73px);animation:sarc-aether-orbit-centered 16s linear infinite}.sarc-root.is-machine-surface .sarc-socket.is-filled{border-color:#8174c8;background:radial-gradient(circle at 50% 45%,#7562bd30,transparent 44%),linear-gradient(150deg,#1c1835,#081219)}.sarc-root.is-machine-surface .sarc-start>button{border-color:#8d80d0;background:linear-gradient(110deg,#6857aa,#256d7b);box-shadow:0 0 26px #6958ad3b}
    @keyframes sarc-aether-orbit{to{transform:rotate(360deg)}}@keyframes sarc-aether-orbit-centered{to{transform:translateX(-50%) rotate(360deg)}}@keyframes sarc-aether-heart{0%,100%{transform:scale(.96);filter:drop-shadow(0 0 5px #766dcc55)}50%{transform:scale(1.06);filter:drop-shadow(0 0 14px #5c9eb799)}}@keyframes sarc-aether-reveal{from{opacity:0;filter:blur(5px);transform:translateY(7px)}to{opacity:1;filter:none;transform:none}} */
    /* v4 — restrained moonstone archive. Static, low-layer and deliberately quiet. */
    .sarc-root.is-paper-surface{--quiet-ink:#31364c;--quiet-muted:#74798d;--quiet-violet:#6f719d;--quiet-cyan:#6f9297;--quiet-line:#8b8fa94a;color:var(--quiet-ink);background:#f1f2f7}
    .sarc-root.is-paper-surface .sarc-grid-bg{opacity:.38;background-image:linear-gradient(#777b970b 1px,transparent 1px),linear-gradient(90deg,#777b9709 1px,transparent 1px);background-size:32px 32px;mask:none}
    .sarc-root.is-paper-surface .sarc-header{color:var(--quiet-ink);border-bottom:1px solid var(--quiet-line);background:#f7f7fb;box-shadow:none;backdrop-filter:none}
    .sarc-root.is-paper-surface .sarc-header>button{color:#5e627f;border-color:#8c90aa55;background:#eff0f6;box-shadow:none}.sarc-root.is-paper-surface .sarc-header small{color:#7a7e97}.sarc-root.is-paper-surface .sarc-header h1{color:#2f3449;text-shadow:none}.sarc-root.is-paper-surface .sarc-header__records i{color:#7b8096}
    .sarc-root.is-paper-surface .sarc-archive{background:transparent;animation:none}.sarc-root.is-paper-surface .sarc-archive__intro{position:relative;min-height:96px;padding:10px 76px 17px 14px;overflow:hidden;border-bottom:1px solid var(--quiet-line)}
    .sarc-root.is-paper-surface .sarc-archive__intro:before{content:"";position:absolute;right:12px;top:8px;width:52px;height:52px;border:1px solid #767a9d66;border-radius:50%;background:transparent;box-shadow:inset 0 0 0 8px #f1f2f7,inset 0 0 0 9px #708e9445;animation:none}
    .sarc-root.is-paper-surface .sarc-archive__intro:after{content:"";position:absolute;right:33px;top:29px;width:10px;height:10px;border:1px solid #696d98;background:#f1f2f7;transform:rotate(45deg);clip-path:none;filter:none;animation:none}
    .sarc-root.is-paper-surface .sarc-archive__intro>small{color:#777c97;font-size:6px;letter-spacing:.16em}.sarc-root.is-paper-surface .sarc-archive__intro h2{margin:8px 0 5px;color:#30354b;font-size:23px}.sarc-root.is-paper-surface .sarc-archive__intro p{color:#767b8c;font-size:10px}
    .sarc-root.is-paper-surface .sarc-archive__switch{gap:8px;margin:13px 0}.sarc-root.is-paper-surface .sarc-archive__switch>button{min-height:58px;color:#7a7f90;border-color:#8e92a84f;background:#eceef3;clip-path:none;box-shadow:none}.sarc-root.is-paper-surface .sarc-archive__switch>button:before{display:none}.sarc-root.is-paper-surface .sarc-archive__switch>button.is-active{color:#444a69;border-color:#777c9a8c;background:#fafafe;box-shadow:none;transform:none}.sarc-root.is-paper-surface .sarc-archive__switch small{color:#9093a1}
    .sarc-root.is-paper-surface .sarc-archive__rail{padding-top:5px}.sarc-root.is-paper-surface .sarc-archive__rail>button{color:#787d91}.sarc-root.is-paper-surface .sarc-archive__rail>button:before{display:none}.sarc-root.is-paper-surface .sarc-archive__rail>button.is-active{color:#414761}.sarc-root.is-paper-surface .sarc-portrait{color:#535976;border-color:#8589a45c;background:#f7f8fb;box-shadow:inset 0 0 0 3px #eef0f5}.sarc-root.is-paper-surface .sarc-portrait:before{border-color:#8589a438}.sarc-root.is-paper-surface .sarc-portrait i{background:#6f9297;box-shadow:0 0 0 2px #f1f2f7}.sarc-root.is-paper-surface .sarc-archive__rail>button.is-active .sarc-portrait{border-color:#747899;box-shadow:0 0 0 3px #f1f2f7,0 0 0 4px #777b9959;animation:none}.sarc-root.is-paper-surface .sarc-archive__rail>button>b{background:#747993;box-shadow:none}
    .sarc-root.is-paper-surface .sarc-archive__owner{position:relative;overflow:hidden;min-height:102px;border-top:1px solid var(--quiet-line);border-right:0;border-bottom:1px solid var(--quiet-line);border-left:0;background:#ffffff70;clip-path:none;box-shadow:none}.sarc-root.is-paper-surface .sarc-archive__owner:before{content:"";position:absolute;right:14px;top:15px;width:54px;height:54px;border:1px solid #777b9630;border-radius:50%;box-shadow:inset 0 0 0 10px #f1f2f744}.sarc-root.is-paper-surface .sarc-archive__owner:after{display:none}.sarc-root.is-paper-surface .sarc-archive__owner>span{position:relative}.sarc-root.is-paper-surface .sarc-archive__owner>span>small{color:#7a7f99}.sarc-root.is-paper-surface .sarc-archive__owner h3{color:#373c55}.sarc-root.is-paper-surface .sarc-archive__owner p{color:#7a7e8e}
    .sarc-root.is-paper-surface .sarc-keepsakes{gap:10px}.sarc-root.is-paper-surface .sarc-keepsake{--volume-ink:#74799a;min-height:224px;color:#373c52;border-color:#888ca456;background:linear-gradient(110deg,var(--volume-ink) 0 3px,transparent 3px),#fafafe;clip-path:polygon(0 0,calc(100% - 9px) 0,100% 9px,100% 100%,9px 100%,0 calc(100% - 9px));box-shadow:2px 3px 0 #d8dae4;animation:none}.sarc-root.is-paper-surface .sarc-keepsake.is-1{--volume-ink:#936d85}.sarc-root.is-paper-surface .sarc-keepsake.is-2{--volume-ink:#6b8e94}.sarc-root.is-paper-surface .sarc-keepsake.is-3{--volume-ink:#79769a}.sarc-root.is-paper-surface .sarc-keepsake:before{inset:6px;border-color:#8589a334;clip-path:none}.sarc-root.is-paper-surface .sarc-keepsake:after{display:none}.sarc-root.is-paper-surface .sarc-keepsake__portrait>span{color:#85899b}.sarc-root.is-paper-surface .sarc-keepsake>small{color:var(--volume-ink)}.sarc-root.is-paper-surface .sarc-keepsake h3{color:#33384e}.sarc-root.is-paper-surface .sarc-keepsake blockquote{color:#75798a}.sarc-root.is-paper-surface .sarc-keepsake>footer{border-color:#8b8fa64a;color:#787d8d}
    .sarc-root.is-paper-surface .sarc-character-notes>button{overflow:hidden;color:#373c52;border-color:#898da552;background:linear-gradient(110deg,#718f94 0 3px,transparent 3px),#fafafe;clip-path:polygon(8px 0,100% 0,100% calc(100% - 8px),calc(100% - 8px) 100%,0 100%,0 8px);box-shadow:2px 3px 0 #d8dae4;animation:none}.sarc-root.is-paper-surface .sarc-character-notes>button:before{content:"✦";right:14px;top:13px;width:24px;height:24px;display:grid;place-items:center;border:1px solid #8185a05c;border-radius:50%;color:#777b9a;background:transparent;box-shadow:none;transform:none}.sarc-root.is-paper-surface .sarc-character-notes header{color:#7c8094}.sarc-root.is-paper-surface .sarc-character-notes header b{color:#8f687f}.sarc-root.is-paper-surface .sarc-character-notes h3{padding-right:28px;color:#343950}.sarc-root.is-paper-surface .sarc-character-notes>button>div{color:#737b96}.sarc-root.is-paper-surface .sarc-character-notes>button>div i{border-color:#8b8fa655;background:transparent}.sarc-root.is-paper-surface .sarc-character-notes blockquote{color:#686d83;border-color:#947087;background:#f0edf2}.sarc-root.is-paper-surface .sarc-character-notes footer{color:#7b8091;border-color:#8b8fa455}
    .sarc-root.is-paper-surface .sarc-archive__empty{position:relative;overflow:hidden;color:#7d8293}.sarc-root.is-paper-surface .sarc-archive__empty:before{content:"";position:absolute;width:104px;height:104px;border:1px dashed #8185a04a;border-radius:50%;background:transparent;box-shadow:inset 0 0 0 15px #f1f2f7,inset 0 0 0 16px #7a7e9a24;animation:none}.sarc-root.is-paper-surface .sarc-archive__empty>*{position:relative}.sarc-root.is-paper-surface .sarc-archive__empty>svg{color:#727796;filter:none}.sarc-root.is-paper-surface .sarc-archive__empty h3{color:#4a5068}.sarc-root.is-paper-surface .sarc-archive__empty p{color:#7b8091}
    .sarc-root.is-paper-surface .sarc-note-view{background:#f1f2f7}.sarc-root.is-paper-surface .sarc-note-view>article{color:#383d53;border-color:#898da555;background:#fafafe;clip-path:polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px);box-shadow:2px 3px 0 #d8dae4;animation:none}.sarc-root.is-paper-surface .sarc-note-view>article:before{content:"PRIVATE";color:#80647c;border-color:#95809966;background:transparent;box-shadow:none}.sarc-root.is-paper-surface .sarc-note-view>article>header{border-color:#8b8fa455}.sarc-root.is-paper-surface .sarc-note-view>article>header small{color:#7c8196}.sarc-root.is-paper-surface .sarc-note-view>article>header h2{color:#353a51}.sarc-root.is-paper-surface .sarc-note-view>article>header p{color:#7d8191}.sarc-root.is-paper-surface .sarc-note-view__chips>span{border-color:#8a8ea457;background:#f0f1f6}.sarc-root.is-paper-surface .sarc-note-view__chips b{color:#555c78}.sarc-root.is-paper-surface .sarc-note-view>article>blockquote{color:#62677d;border-color:#916c83;background:#f0edf2}.sarc-root.is-paper-surface .sarc-note-view section p{color:#666b7d}.sarc-root.is-paper-surface .sarc-note-view>article>footer{color:#7d8191;border-color:#8b8fa455}
    .sarc-root.is-paper-surface .sarc-result{background:#f1f2f7}.sarc-root.is-paper-surface .sarc-result__status{color:#6c7192;text-shadow:none}.sarc-root.is-paper-surface .sarc-identity-card{color:#353a51;border-color:#8589a566;background:#fafafe;box-shadow:2px 3px 0 #d8dae4;animation:none}.sarc-root.is-paper-surface .sarc-identity-card:before{display:none}.sarc-root.is-paper-surface .sarc-worldline:before{animation:none}.sarc-root.is-paper-surface .sarc-user-mask{background:#f0eff6}.sarc-root.is-paper-surface .sarc-worldline{background:#f3eef2;animation:none}.sarc-root.is-paper-surface .sarc-opening{background:#edf3f3}.sarc-root.is-paper-surface .sarc-result__actions button{box-shadow:none}.sarc-root.is-paper-surface .sarc-result__actions button.is-primary{background:#666b8f;box-shadow:none}
`}</style>;
