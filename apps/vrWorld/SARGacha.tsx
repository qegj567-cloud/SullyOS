import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CaretLeft, Check, Sparkle, X } from '@phosphor-icons/react';
import {
    getSARModules,
    isSARFreeDrawAvailable,
    readSARGachaState,
    drawSARModule,
    type SARModuleAccent,
    type SARModuleDefinition,
    type SARModulePool,
    type SARGachaState,
} from '../../utils/vrWorld/sarGacha';

const ACCENT_COLORS: Record<SARModuleAccent, string> = {
    blue: '#79b8ef',
    red: '#d66b64',
    olive: '#a7b96c',
    violet: '#a98ade',
    ivory: '#c9b58d',
    graphite: '#9aa7b3',
    rose: '#d38e9b',
    teal: '#71c5c6',
};

type GachaPhase = 'idle' | 'drawing' | 'capsule' | 'opening' | 'revealed';
type GachaView = 'machine' | 'collection';

// 临时开发开关：测试期间允许无限抽取，且不写入每日额度。
const SAR_GACHA_DEVELOPMENT_MODE = true;

const poolCopy = (pool: SARModulePool) => pool === 'variant'
    ? { cn: '异界异格', en: 'ISEKAI VARIANT', prompt: '这一次，TA 会成为谁？', hint: '抽取一枚可以装载给任意角色的异世界身份', count: 25 }
    : { cn: '异界坐标', en: 'WORLD COORDINATE', prompt: '从最危险的那一刻醒来', hint: '抽取一条从剧情中后段直接开场的高压世界线', count: 24 };

const cssVars = (module: SARModuleDefinition): React.CSSProperties => ({
    '--sar-card-accent': ACCENT_COLORS[module.accent],
} as React.CSSProperties);

const SARRitualSigil: React.FC<{ module: SARModuleDefinition }> = ({ module }) => (
    <div className="sarg-sigil" data-sigil={module.sigil} aria-hidden="true">
        <i className="sarg-sigil__orbit sarg-sigil__orbit--outer" />
        <i className="sarg-sigil__orbit sarg-sigil__orbit--inner" />
        <i className="sarg-sigil__axis" />
        <i className="sarg-sigil__axis sarg-sigil__axis--cross" />
        <i className="sarg-sigil__core" />
    </div>
);

const SARModuleCard: React.FC<{
    module: SARModuleDefinition;
    quantity?: number;
    compact?: boolean;
    onClick?: () => void;
}> = ({ module, quantity = 1, compact = false, onClick }) => {
    const Wrapper = onClick ? 'button' : 'div';
    const copy = poolCopy(module.pool);
    return (
        <Wrapper type={onClick ? 'button' : undefined} onClick={onClick}
            className={`sarg-card ${compact ? 'sarg-card--compact' : ''}`} style={cssVars(module)}>
            <span className="sarg-card__corner sarg-card__corner--tl" /><span className="sarg-card__corner sarg-card__corner--tr" />
            <span className="sarg-card__corner sarg-card__corner--bl" /><span className="sarg-card__corner sarg-card__corner--br" />
            <div className="sarg-card__head">
                <span>{copy.cn}</span><small>{copy.en}</small><b>No.{module.id.slice(-2)}</b>
            </div>
            <div className="sarg-card__group">{module.group}</div>
            <SARRitualSigil module={module} />
            <div className="sarg-card__body">
                <h3>{module.title}</h3>
                {!compact && <p>{module.summary}</p>}
            </div>
            <div className="sarg-card__foot">
                <span>{module.pool === 'variant' ? '异格收录状态' : '世界线收录状态'}</span>
                <i /><b>可装载</b>
            </div>
            {quantity > 1 && <span className="sarg-card__quantity">×{quantity}</span>}
        </Wrapper>
    );
};

const PoolSwitch: React.FC<{
    pool: SARModulePool;
    state: SARGachaState;
    disabled?: boolean;
    onChange: (pool: SARModulePool) => void;
}> = ({ pool, state, disabled, onChange }) => (
    <div className="sarg-pool-switch" role="tablist" aria-label="选择卡池">
        {(['variant', 'story'] as SARModulePool[]).map(item => {
            const available = SAR_GACHA_DEVELOPMENT_MODE || isSARFreeDrawAvailable(item, state);
            return (
                <button key={item} type="button" role="tab" aria-selected={pool === item} disabled={disabled}
                    className={pool === item ? 'is-active' : ''} onClick={() => onChange(item)}>
                    <span>{poolCopy(item).cn}</span>
                    <small>{SAR_GACHA_DEVELOPMENT_MODE ? '开发模式' : available ? '今日免费' : '明日再来'}</small>
                </button>
            );
        })}
    </div>
);

const SARGachaMachine: React.FC<{
    pool: SARModulePool;
    phase: GachaPhase;
    result: SARModuleDefinition | null;
    onOpenCapsule: () => void;
}> = ({ pool, phase, result, onOpenCapsule }) => (
    <div className={`sarg-machine sarg-machine--${phase}`} aria-live="polite">
        <div className="sarg-machine__stars"><i /><i /><i /><i /><i /><i /></div>
        <div className="sarg-machine__halo" />
        <div className="sarg-machine__portal">
            <div className="sarg-machine__ticks" />
            <div className="sarg-machine__rings"><i /><i /><i /></div>
            <div className="sarg-machine__meridian"><i /><i /></div>
            <div className="sarg-machine__core">
                <i />
                <b>{pool === 'variant' ? '异格' : '世界'}</b>
                <small>{pool === 'variant' ? 'I · 25' : 'W · 24'}</small>
            </div>
        </div>
        <div className="sarg-machine__horizon"><i /></div>
        <div className="sarg-machine__caption">
            <span>{phase === 'idle' ? '等待启动' : phase === 'drawing' ? '坐标对齐中' : phase === 'capsule' ? '封装完成' : '正在破封'}</span>
            <small>{pool === 'variant' ? 'PERSONA DIVERSION CHAMBER' : 'WORLDLINE INTERCEPTION CHAMBER'}</small>
        </div>
        {(phase === 'capsule' || phase === 'opening') && result && (
            <button type="button" className="sarg-capsule" onClick={onOpenCapsule} disabled={phase === 'opening'}
                aria-label={phase === 'capsule' ? '打开扭蛋' : '正在打开扭蛋'} style={cssVars(result)}>
                <span className="sarg-capsule__glow" />
                <span className="sarg-capsule__half sarg-capsule__half--top"><i /></span>
                <span className="sarg-capsule__half sarg-capsule__half--bottom"><i /></span>
                {phase === 'capsule' && <b>点击开启</b>}
            </button>
        )}
    </div>
);

const SARCollection: React.FC<{
    state: SARGachaState;
    pool: SARModulePool;
    onPoolChange: (pool: SARModulePool) => void;
    onSelect: (module: SARModuleDefinition) => void;
}> = ({ state, pool, onPoolChange, onSelect }) => {
    const modules = useMemo(() => getSARModules(pool).filter(module => (state.collection[module.id] || 0) > 0), [pool, state]);
    const owned = modules.length;
    const totalCopies = modules.reduce((sum, module) => sum + (state.collection[module.id] || 0), 0);
    return (
        <div className="sarg-collection">
            <div className="sarg-collection__intro">
                <div><small>ISEKAI ARCHIVE</small><h2>异世界模块陈列</h2></div>
                <div className="sarg-collection__count"><b>{owned}</b><span> / {poolCopy(pool).count}<br />共 {totalCopies} 枚</span></div>
            </div>
            <PoolSwitch pool={pool} state={state} onChange={onPoolChange} />
            {modules.length ? (
                <div className="sarg-collection__grid">
                    {modules.map(module => <SARModuleCard key={module.id} module={module} compact quantity={state.collection[module.id]} onClick={() => onSelect(module)} />)}
                </div>
            ) : (
                <div className="sarg-empty">
                    <div className="sarg-empty__mark"><i /><i /></div>
                    <h3>陈列槽位为空</h3>
                    <p>从{poolCopy(pool).cn}池完成一次抽取，新的异世界模块会被送到这里。</p>
                </div>
            )}
        </div>
    );
};

const SARModuleDetail: React.FC<{
    module: SARModuleDefinition;
    quantity: number;
    onClose: () => void;
}> = ({ module, quantity, onClose }) => (
    <div className="sarg-detail-backdrop" role="dialog" aria-modal="true" aria-label={`${module.title}模块详情`} onClick={onClose}>
        <div className="sarg-detail" onClick={event => event.stopPropagation()}>
            <button type="button" className="sarg-detail__close" onClick={onClose} aria-label="关闭模块详情"><X size={16} /></button>
            <div className="sarg-detail__card"><SARModuleCard module={module} quantity={quantity} /></div>
            <div className="sarg-detail__copy">
                <small>{poolCopy(module.pool).en} · {module.group}</small>
                <h2>{module.title}</h2>
                <p>{module.summary}</p>
                <div className="sarg-detail__memory"><b>关系约束</b><span>{module.memory}</span></div>
                {module.routeTags && <div className="sarg-detail__tags">{module.routeTags.map(tag => <span key={tag}>{tag}</span>)}</div>}
                <button type="button" disabled className="sarg-detail__simulate">用于异世界铸造 <span>前往陈列柜装载</span></button>
            </div>
        </div>
    </div>
);

export const SARGachaOverlay: React.FC<{
    onClose: () => void;
}> = ({ onClose }) => {
    const [view, setView] = useState<GachaView>('machine');
    const [pool, setPool] = useState<SARModulePool>('variant');
    const [phase, setPhase] = useState<GachaPhase>('idle');
    const [state, setState] = useState<SARGachaState>(() => readSARGachaState());
    const [result, setResult] = useState<SARModuleDefinition | null>(null);
    const [firstCopy, setFirstCopy] = useState(false);
    const [detail, setDetail] = useState<SARModuleDefinition | null>(null);
    const timer = useRef<number | null>(null);
    const reducedMotion = useRef(typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

    useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

    useEffect(() => {
        const gameWindow = window as unknown as {
            render_game_to_text?: () => string;
            advanceTime?: (ms: number) => void;
        };
        const previousRender = gameWindow.render_game_to_text;
        const previousAdvance = gameWindow.advanceTime;
        gameWindow.render_game_to_text = () => JSON.stringify({
            screen: view,
            pool,
            phase,
            developmentMode: SAR_GACHA_DEVELOPMENT_MODE,
            freeDrawAvailable: SAR_GACHA_DEVELOPMENT_MODE || isSARFreeDrawAvailable(pool, state),
            collectedUnique: Object.keys(state.collection).filter(id => state.collection[id] > 0).length,
            result: result ? { id: result.id, title: result.title, group: result.group } : null,
        });
        gameWindow.advanceTime = () => {
            if (phase === 'drawing') setPhase('capsule');
            if (phase === 'opening') setPhase('revealed');
        };
        return () => {
            gameWindow.render_game_to_text = previousRender;
            gameWindow.advanceTime = previousAdvance;
        };
    }, [phase, pool, result, state, view]);

    const schedule = (callback: () => void, normalDelay: number) => {
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(callback, reducedMotion.current ? 80 : normalDelay);
    };

    const startDraw = () => {
        if (phase !== 'idle') return;
        const draw = drawSARModule(pool, undefined, new Date(), Math.random, SAR_GACHA_DEVELOPMENT_MODE);
        setState(draw.state);
        if (!draw.ok) return;
        setResult(draw.module);
        setFirstCopy(draw.firstCopy);
        setPhase('drawing');
        schedule(() => setPhase('capsule'), 1550);
    };

    const openCapsule = () => {
        if (phase !== 'capsule') return;
        setPhase('opening');
        schedule(() => setPhase('revealed'), 920);
    };

    const resetMachine = () => {
        setResult(null);
        setFirstCopy(false);
        setPhase('idle');
    };

    const changePool = (next: SARModulePool) => {
        if (phase !== 'idle') return;
        setPool(next);
        setResult(null);
    };

    const available = SAR_GACHA_DEVELOPMENT_MODE || isSARFreeDrawAvailable(pool, state);
    const collectedUnique = Object.keys(state.collection).filter(id => state.collection[id] > 0).length;
    const busy = phase === 'drawing' || phase === 'capsule' || phase === 'opening';

    return (
        <div className={`sarg-root sarg-root--${pool} sarg-root--${phase}`} role="dialog" aria-modal="true" aria-label="SAR 异世界异格扭蛋机">
            <SARGachaStyle />
            <SARGachaProductStyle />
            <div className="sarg-noise" />
            <header className="sarg-header">
                <button type="button" onClick={view === 'collection' ? () => setView('machine') : onClose} aria-label={view === 'collection' ? '返回扭蛋机' : '离开扭蛋机'}>
                    {view === 'collection' ? <CaretLeft size={19} /> : <X size={18} />}
                </button>
                <div><small>SAR ACTIVITY SPACE · 01</small><h1>异世界异格扭蛋</h1></div>
                <button type="button" className="sarg-header__archive" onClick={() => setView(view === 'collection' ? 'machine' : 'collection')} disabled={busy} aria-label="打开异世界模块陈列">
                    <span>{collectedUnique}</span><i>藏品</i>
                </button>
            </header>

            {view === 'collection' ? (
                <SARCollection state={state} pool={pool} onPoolChange={setPool} onSelect={setDetail} />
            ) : (
                <main className="sarg-main">
                    <PoolSwitch pool={pool} state={state} disabled={busy || phase === 'revealed'} onChange={changePool} />
                    {phase === 'revealed' && result ? (
                        <div className="sarg-reveal" style={cssVars(result)}>
                            <div className="sarg-reveal__aura"><i /><i /><i /></div>
                            <div className="sarg-reveal__eyebrow"><Sparkle size={12} weight="fill" /> {firstCopy ? '首次显现' : '世界线共振'}</div>
                            <div className="sarg-reveal__card"><SARModuleCard module={result} quantity={state.collection[result.id]} /></div>
                            <div className="sarg-reveal__name"><small>{result.group}</small><b>{result.title}</b></div>
                            <div className="sarg-reveal__actions">
                                <button type="button" className="sarg-primary" onClick={() => { setView('collection'); resetMachine(); }}><Check size={15} weight="bold" /> 收入陈列</button>
                                <button type="button" className="sarg-secondary" onClick={resetMachine}>再看看机器</button>
                            </div>
                        </div>
                    ) : (
                        <>
                            <div className="sarg-pool-copy">
                                <small>{poolCopy(pool).en} · {poolCopy(pool).count}</small>
                                <h2>{poolCopy(pool).prompt}</h2>
                                <p>{poolCopy(pool).hint}</p>
                            </div>
                            <SARGachaMachine pool={pool} phase={phase} result={result} onOpenCapsule={openCapsule} />
                            <div className="sarg-draw-panel">
                                {phase === 'capsule' ? (
                                    <p className="sarg-machine-status">异世界坐标已封入 · 点击扭蛋开启</p>
                                ) : phase === 'opening' ? (
                                    <p className="sarg-machine-status">正在解除封装……</p>
                                ) : phase === 'drawing' ? (
                                    <p className="sarg-machine-status">正在对齐分歧坐标……</p>
                                ) : (
                                    <>
                                        <div className="sarg-draw-panel__meta"><span>{SAR_GACHA_DEVELOPMENT_MODE ? '开发模式' : '今日配额'}</span><b>{SAR_GACHA_DEVELOPMENT_MODE ? '无限抽取' : available ? '免费 1 次' : '已领取'}</b></div>
                                        <button type="button" className="sarg-draw-button" disabled={!available} onClick={startDraw}>
                                            <span>{available ? '启动扭蛋' : '等待明日校准'}</span><small>{available ? `${SAR_GACHA_DEVELOPMENT_MODE ? '开发抽取' : '免费抽取'} · ${poolCopy(pool).cn}` : 'DAILY DRAW USED'}</small>
                                        </button>
                                        <p>{SAR_GACHA_DEVELOPMENT_MODE ? '抽取不会消耗每日额度 · 关闭开发模式后恢复限制' : '两个卡池各有一次免费机会 · 每日 00:00 重置'}</p>
                                    </>
                                )}
                            </div>
                        </>
                    )}
                </main>
            )}

            {detail && <SARModuleDetail module={detail} quantity={state.collection[detail.id] || 1} onClose={() => setDetail(null)} />}
        </div>
    );
};

const SARGachaStyle = () => <style>{`
    .sarg-root{position:fixed;inset:0;z-index:390;overflow:hidden;color:#e9edf4;background:radial-gradient(90% 62% at 50% 13%,#172334 0%,#0a111b 52%,#050910 100%);font-family:Inter,"Noto Sans SC",sans-serif;--sarg-safe-top:var(--chrome-top);--sarg-safe-bottom:var(--safe-bottom)}
    .sarg-noise{position:absolute;inset:0;pointer-events:none;opacity:.15;background-image:repeating-linear-gradient(0deg,transparent 0 3px,rgba(255,255,255,.025) 4px),radial-gradient(1px 1px at 20% 14%,#fff8,transparent),radial-gradient(1px 1px at 82% 28%,#fff6,transparent),radial-gradient(1px 1px at 38% 74%,#fff4,transparent)}
    .sarg-root:before{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(90deg,transparent 7%,rgba(127,175,204,.035) 7.2%,transparent 7.5%,transparent 92%,rgba(127,175,204,.035) 92.2%,transparent 92.5%)}
    .sarg-header{position:relative;z-index:5;display:grid;grid-template-columns:44px 1fr 52px;align-items:center;gap:8px;padding:calc(var(--sarg-safe-top) + 6px) 15px 10px;border-bottom:1px solid rgba(145,186,210,.14);background:linear-gradient(180deg,rgba(4,8,14,.82),rgba(5,9,15,.34));backdrop-filter:blur(12px)}
    .sarg-header>button{width:38px;height:38px;display:grid;place-items:center;color:#c8d5df;border:1px solid rgba(152,190,212,.15);background:rgba(121,165,190,.04);clip-path:polygon(8px 0,100% 0,100% calc(100% - 8px),calc(100% - 8px) 100%,0 100%,0 8px)}
    .sarg-header>div{text-align:center}.sarg-header small{display:block;font-size:7px;letter-spacing:.27em;color:#7f9bad}.sarg-header h1{margin:3px 0 0;font:500 17px/1.2 "Noto Serif SC",serif;letter-spacing:.18em;color:#e4e9ed}
    .sarg-header .sarg-header__archive{position:relative;width:49px;display:flex;flex-direction:column;gap:1px;font-size:11px}.sarg-header__archive span{font:600 12px/1 serif}.sarg-header__archive i{font-style:normal;font-size:8px;letter-spacing:.12em;color:#8ba4b5}
    .sarg-main,.sarg-collection{position:relative;z-index:2;height:calc(100% - var(--sarg-safe-top) - 55px);overflow:auto;padding:14px 17px calc(var(--sarg-safe-bottom) + 16px);scrollbar-width:none}.sarg-main::-webkit-scrollbar,.sarg-collection::-webkit-scrollbar{display:none}
    .sarg-pool-switch{display:grid;grid-template-columns:1fr 1fr;border:1px solid rgba(133,178,204,.18);background:rgba(4,9,15,.5);padding:3px;clip-path:polygon(7px 0,100% 0,100% calc(100% - 7px),calc(100% - 7px) 100%,0 100%,0 7px)}
    .sarg-pool-switch button{position:relative;min-height:43px;padding:6px 7px;color:#708696;background:transparent;border:0;transition:.22s}.sarg-pool-switch button+button{border-left:1px solid rgba(132,174,198,.12)}.sarg-pool-switch button.is-active{color:#dce7ee;background:linear-gradient(120deg,rgba(82,137,169,.18),rgba(82,137,169,.035));box-shadow:inset 0 0 0 1px rgba(126,185,219,.2)}
    .sarg-pool-switch span{display:block;font:500 12px/1.2 "Noto Serif SC",serif;letter-spacing:.14em}.sarg-pool-switch small{display:block;margin-top:3px;font-size:6px;letter-spacing:.18em;opacity:.55}.sarg-pool-switch i{position:absolute;right:7px;top:7px;width:5px;height:5px;border-radius:50%;background:#a7d9e9;box-shadow:0 0 8px #9de3ff}
    .sarg-pool-copy{text-align:center;margin:15px 0 4px}.sarg-pool-copy small{font:7px/1.2 serif;letter-spacing:.24em;color:#7594a8}.sarg-pool-copy h2{margin:5px 0 2px;font:500 22px/1.3 "Noto Serif SC",serif;letter-spacing:.22em}.sarg-pool-copy p{margin:0;font-size:9.5px;letter-spacing:.05em;color:#78909f}
    .sarg-machine{position:relative;height:340px;max-width:330px;margin:0 auto}.sarg-machine__halo{position:absolute;left:50%;top:43%;width:260px;height:260px;transform:translate(-50%,-50%);background:radial-gradient(circle,rgba(87,154,190,.12),transparent 66%);filter:blur(5px)}
    .sarg-machine__case{position:absolute;left:50%;top:23px;width:244px;height:272px;transform:translateX(-50%);border:1px solid rgba(132,180,205,.3);background:linear-gradient(145deg,rgba(16,29,41,.94),rgba(4,9,15,.98));clip-path:polygon(18px 0,calc(100% - 18px) 0,100% 18px,100% calc(100% - 16px),calc(100% - 16px) 100%,16px 100%,0 calc(100% - 16px),0 18px);box-shadow:0 28px 50px #0009,inset 0 0 40px rgba(92,147,177,.04)}
    .sarg-machine__case:before,.sarg-machine__case:after{content:"";position:absolute;inset:8px;border:1px solid rgba(132,180,205,.1);clip-path:inherit}.sarg-machine__case:after{inset:14px;border-style:dashed;opacity:.35}
    .sarg-machine__serial{position:absolute;left:20px;top:15px;font:7px/1 monospace;letter-spacing:.16em;color:#65879b}
    .sarg-machine__window{position:absolute;left:27px;right:27px;top:39px;height:158px;overflow:hidden;border:1px solid rgba(137,188,216,.27);background:radial-gradient(circle at 50% 48%,rgba(63,128,164,.18),rgba(3,8,14,.96) 66%);clip-path:polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px)}
    .sarg-machine__window:after{content:"";position:absolute;inset:0;background:repeating-linear-gradient(0deg,transparent 0 5px,rgba(133,198,225,.03) 6px);pointer-events:none}
    .sarg-machine__rings{position:absolute;left:50%;top:48%;width:126px;height:126px;transform:translate(-50%,-50%)}.sarg-machine__rings i{position:absolute;inset:0;border:1px solid rgba(116,184,218,.28);border-radius:50%}.sarg-machine__rings i:before{content:"";position:absolute;left:50%;top:-3px;width:6px;height:6px;transform:translateX(-50%) rotate(45deg);border:1px solid #7fb4cf;background:#0b1721}.sarg-machine__rings i:nth-child(2){inset:16px;border-style:dashed;transform:rotate(37deg)}.sarg-machine__rings i:nth-child(3){inset:34px;transform:rotate(71deg);border-color:rgba(139,204,227,.45)}
    .sarg-machine__core{position:absolute;left:50%;top:48%;width:39px;height:39px;transform:translate(-50%,-50%) rotate(45deg);border:1px solid rgba(153,211,235,.65);box-shadow:0 0 24px rgba(90,175,212,.25)}.sarg-machine__core:before,.sarg-machine__core:after{content:"";position:absolute;background:rgba(150,210,235,.38)}.sarg-machine__core:before{left:50%;top:-35px;width:1px;height:108px}.sarg-machine__core:after{top:50%;left:-35px;height:1px;width:108px}.sarg-machine__core i{position:absolute;inset:11px;border:1px solid #9dd2e8;border-radius:50%;background:#152d3c;box-shadow:0 0 15px rgba(113,199,231,.55)}
    .sarg-machine__scan{position:absolute;inset:auto 0 8px;text-align:center;font:6px/1 monospace;letter-spacing:.22em;color:#567588}.sarg-machine__rail{position:absolute;left:29px;right:29px;top:210px;display:flex;justify-content:space-between}.sarg-machine__rail:before{content:"";position:absolute;top:4px;left:0;right:0;height:1px;background:#52748855}.sarg-machine__rail i{position:relative;width:8px;height:8px;transform:rotate(45deg);border:1px solid #5c7e91;background:#08111a}
    .sarg-machine__chute{position:absolute;left:50%;bottom:16px;width:66px;height:32px;transform:translateX(-50%);border:1px solid rgba(132,180,205,.22);border-radius:50% 50% 8px 8px;background:#03070c;box-shadow:inset 0 5px 9px #000}.sarg-machine__chute span{position:absolute;left:50%;top:7px;width:42px;height:10px;transform:translateX(-50%);border-radius:50%;border:1px solid #314b5a}
    .sarg-machine--drawing .sarg-machine__rings i:first-child{animation:sarg-orbit .68s linear infinite}.sarg-machine--drawing .sarg-machine__rings i:nth-child(2){animation:sarg-orbit .42s linear infinite reverse}.sarg-machine--drawing .sarg-machine__rings i:nth-child(3){animation:sarg-orbit .3s linear infinite}.sarg-machine--drawing .sarg-machine__core{animation:sarg-core .7s ease-in-out infinite}.sarg-machine--drawing .sarg-machine__window{box-shadow:inset 0 0 34px rgba(107,201,236,.19)}
    .sarg-capsule{--sar-card-accent:#79b8ef;position:absolute;z-index:4;left:50%;bottom:6px;width:82px;height:94px;transform:translateX(-50%);border:0;background:none;color:#dbe9ef;filter:drop-shadow(0 13px 12px #0009);animation:sarg-capsule-drop .58s cubic-bezier(.18,.8,.28,1.22) both}.sarg-capsule__glow{position:absolute;inset:9px -18px -8px;border-radius:50%;background:radial-gradient(circle,var(--sar-card-accent) 0,transparent 68%);opacity:.16;filter:blur(8px)}
    .sarg-capsule__half{position:absolute;left:8px;width:66px;height:41px;border:1px solid color-mix(in srgb,var(--sar-card-accent),white 18%);background:linear-gradient(145deg,color-mix(in srgb,var(--sar-card-accent),#101720 80%),#071018 72%);overflow:hidden}.sarg-capsule__half:before{content:"";position:absolute;inset:6px 12px;border:1px solid color-mix(in srgb,var(--sar-card-accent),transparent 48%)}.sarg-capsule__half--top{top:7px;border-radius:34px 34px 7px 7px}.sarg-capsule__half--bottom{top:48px;border-radius:7px 7px 34px 34px}.sarg-capsule__half i{position:absolute;left:50%;top:50%;width:17px;height:17px;transform:translate(-50%,-50%) rotate(45deg);border:1px solid var(--sar-card-accent)}.sarg-capsule__seam{position:absolute;z-index:2;left:4px;top:44px;width:74px;height:8px;border:1px solid var(--sar-card-accent);background:#071019;box-shadow:0 0 9px color-mix(in srgb,var(--sar-card-accent),transparent 35%)}.sarg-capsule>b{position:absolute;top:103px;left:50%;width:90px;transform:translateX(-50%);font-size:9px;letter-spacing:.15em;white-space:nowrap;color:#c4d4de;animation:sarg-fade 1s ease-in-out infinite}
    .sarg-machine--opening .sarg-capsule{animation:none}.sarg-machine--opening .sarg-capsule__seam{animation:sarg-seam .42s ease-out both}.sarg-machine--opening .sarg-capsule__half--top{animation:sarg-open-top .72s .15s ease-out both}.sarg-machine--opening .sarg-capsule__half--bottom{animation:sarg-open-bottom .72s .15s ease-out both}.sarg-machine--opening .sarg-capsule__glow{animation:sarg-open-glow .8s ease-out both}
    .sarg-draw-panel{position:relative;max-width:330px;margin:-6px auto 0;text-align:center;min-height:98px}.sarg-draw-panel__meta{display:flex;justify-content:space-between;padding:0 3px 7px;font-size:9px;color:#718997}.sarg-draw-panel__meta b{font-weight:500;color:#a7c5d5}.sarg-draw-button{position:relative;width:100%;height:55px;border:1px solid rgba(127,188,220,.47);color:#e7f1f5;background:linear-gradient(110deg,rgba(55,112,142,.5),rgba(18,47,64,.7));clip-path:polygon(12px 0,100% 0,100% calc(100% - 12px),calc(100% - 12px) 100%,0 100%,0 12px);box-shadow:inset 0 0 18px rgba(109,194,230,.09),0 9px 26px #0007;transition:transform .15s}.sarg-draw-button:active:not(:disabled){transform:translateY(2px) scale(.99)}.sarg-draw-button:disabled{color:#6d7e88;border-color:#314450;background:#0c151c}.sarg-draw-button span,.sarg-draw-button small{display:block}.sarg-draw-button span{font:500 14px/1.2 "Noto Serif SC",serif;letter-spacing:.18em}.sarg-draw-button small{margin-top:4px;font:6.5px/1 monospace;letter-spacing:.24em;opacity:.55}.sarg-draw-panel>p:not(.sarg-machine-status){margin:8px 0 0;font-size:8px;color:#526b79;letter-spacing:.06em}.sarg-machine-status{padding-top:31px;font:10px/1.5 monospace;letter-spacing:.1em;color:#8bb2c5}
    .sarg-reveal{display:flex;min-height:calc(100% - 58px);flex-direction:column;align-items:center;padding:14px 0 0}.sarg-reveal__eyebrow{display:flex;align-items:center;gap:6px;margin-bottom:10px;font-size:9px;letter-spacing:.14em;color:var(--sar-card-accent);animation:sarg-reveal-copy .5s ease-out both}.sarg-reveal__card{width:min(56vw,218px);animation:sarg-card-rise .75s cubic-bezier(.18,.74,.22,1.05) both}.sarg-reveal__actions{display:grid;grid-template-columns:1fr auto;gap:8px;width:100%;max-width:330px;margin-top:13px}.sarg-primary,.sarg-secondary{height:44px;border:1px solid rgba(137,190,216,.34);color:#dcecf3;background:rgba(44,96,124,.38);font-size:11px;letter-spacing:.12em}.sarg-primary{display:flex;align-items:center;justify-content:center;gap:6px}.sarg-secondary{padding:0 14px;background:rgba(8,16,23,.56);color:#8199a7}
    .sarg-card{--sar-card-accent:#79b8ef;position:relative;display:block;width:100%;aspect-ratio:5/8;overflow:hidden;text-align:left;color:color-mix(in srgb,var(--sar-card-accent),white 48%);background:radial-gradient(circle at 50% 43%,color-mix(in srgb,var(--sar-card-accent),transparent 82%),transparent 38%),linear-gradient(155deg,color-mix(in srgb,var(--sar-card-accent),#071019 89%),#05090e 62%);border:1px solid color-mix(in srgb,var(--sar-card-accent),transparent 28%);clip-path:polygon(9px 0,calc(100% - 9px) 0,100% 9px,100% calc(100% - 9px),calc(100% - 9px) 100%,9px 100%,0 calc(100% - 9px),0 9px);box-shadow:inset 0 0 25px #0008,0 12px 35px #0009}.sarg-card:before{content:"";position:absolute;inset:5px;border:1px solid color-mix(in srgb,var(--sar-card-accent),transparent 62%);clip-path:inherit}.sarg-card:after{content:"";position:absolute;inset:0;opacity:.18;background:repeating-linear-gradient(115deg,transparent 0 17px,var(--sar-card-accent) 18px,transparent 19px 35px);mask:linear-gradient(#0000,#000 45%,#0000 78%)}
    .sarg-card__corner{position:absolute;z-index:3;width:13px;height:13px;border-color:var(--sar-card-accent)}.sarg-card__corner--tl{left:9px;top:9px;border-left:1px solid;border-top:1px solid}.sarg-card__corner--tr{right:9px;top:9px;border-right:1px solid;border-top:1px solid}.sarg-card__corner--bl{left:9px;bottom:9px;border-left:1px solid;border-bottom:1px solid}.sarg-card__corner--br{right:9px;bottom:9px;border-right:1px solid;border-bottom:1px solid}
    .sarg-card__head{position:absolute;z-index:3;left:12px;right:12px;top:12px;height:38px;border-bottom:1px solid color-mix(in srgb,var(--sar-card-accent),transparent 55%)}.sarg-card__head span{display:block;font:500 14px/1.2 "Noto Serif SC",serif;letter-spacing:.1em}.sarg-card__head small{display:block;margin-top:2px;font:5px/1 monospace;letter-spacing:.2em;opacity:.64}.sarg-card__head b{position:absolute;right:0;top:7px;font:6px/1 monospace}.sarg-card__group{position:absolute;z-index:3;left:12px;top:59px;padding-left:9px;font-size:6px;letter-spacing:.15em}.sarg-card__group:before{content:"";position:absolute;left:0;top:1px;width:5px;height:5px;transform:rotate(45deg);border:1px solid var(--sar-card-accent)}
    .sarg-sigil{position:absolute;z-index:2;left:50%;top:40%;width:56%;aspect-ratio:1;transform:translate(-50%,-50%);color:var(--sar-card-accent)}.sarg-sigil__orbit,.sarg-sigil__axis,.sarg-sigil__core{position:absolute;display:block}.sarg-sigil__orbit{border:1px solid color-mix(in srgb,var(--sar-card-accent),transparent 40%);border-radius:50%}.sarg-sigil__orbit:before,.sarg-sigil__orbit:after{content:"";position:absolute;width:5px;height:5px;background:currentColor;transform:rotate(45deg)}.sarg-sigil__orbit:before{left:50%;top:-3px}.sarg-sigil__orbit:after{left:50%;bottom:-3px}.sarg-sigil__orbit--outer{inset:0}.sarg-sigil__orbit--inner{inset:18%;border-style:dashed;transform:rotate(35deg)}.sarg-sigil__axis{left:50%;top:-8%;width:1px;height:116%;background:linear-gradient(transparent,currentColor 18%,currentColor 82%,transparent)}.sarg-sigil__axis--cross{transform:rotate(90deg)}.sarg-sigil__core{left:50%;top:50%;width:28%;height:28%;transform:translate(-50%,-50%) rotate(45deg);border:1px solid currentColor;box-shadow:0 0 18px color-mix(in srgb,var(--sar-card-accent),transparent 66%)}.sarg-sigil[data-sigil="chain"] .sarg-sigil__orbit--outer{border-radius:45% 55% 40% 60%;transform:rotate(24deg)}.sarg-sigil[data-sigil="branch"] .sarg-sigil__core{border-radius:50% 0}.sarg-sigil[data-sigil="rose"] .sarg-sigil__core{border-radius:50% 50% 10% 50%;transform:translate(-50%,-50%) rotate(45deg)}.sarg-sigil[data-sigil="sun"] .sarg-sigil__orbit--inner{border-style:solid;box-shadow:0 0 0 7px color-mix(in srgb,var(--sar-card-accent),transparent 88%)}.sarg-sigil[data-sigil="blade"] .sarg-sigil__core{width:12%;height:55%;transform:translate(-50%,-50%);border-radius:50% 50% 5px 5px}.sarg-sigil[data-sigil="heart"] .sarg-sigil__core{border-radius:50% 50% 45% 0}.sarg-sigil[data-sigil="web"] .sarg-sigil__orbit--inner{transform:scaleX(.72);border-style:solid}
    .sarg-card__body{position:absolute;z-index:3;left:12px;right:12px;bottom:39px;text-align:center}.sarg-card__body h3{margin:0;font:500 13px/1.35 "Noto Serif SC",serif;letter-spacing:.08em;color:color-mix(in srgb,var(--sar-card-accent),white 55%)}.sarg-card__body p{margin:5px 2px 0;font-size:6.8px;line-height:1.65;color:color-mix(in srgb,var(--sar-card-accent),white 20%);opacity:.68}.sarg-card__foot{position:absolute;z-index:3;left:12px;right:12px;bottom:13px;display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:5px;font-size:5.5px}.sarg-card__foot i{height:1px;background:linear-gradient(90deg,var(--sar-card-accent),transparent)}.sarg-card__foot b{font:6px/1 monospace}.sarg-card__quantity{position:absolute;z-index:5;right:9px;top:53px;padding:3px 5px;background:color-mix(in srgb,var(--sar-card-accent),#071019 75%);border:1px solid var(--sar-card-accent);font:bold 7px/1 monospace;color:#effaff}
    .sarg-card--compact{box-shadow:inset 0 0 18px #0008,0 8px 18px #0006}.sarg-card--compact .sarg-card__head{height:31px;top:9px;left:10px;right:10px}.sarg-card--compact .sarg-card__head span{font-size:11px}.sarg-card--compact .sarg-card__head b{font-size:5px}.sarg-card--compact .sarg-card__group{top:46px;left:10px;font-size:5.5px}.sarg-card--compact .sarg-card__body{left:8px;right:8px;bottom:31px}.sarg-card--compact .sarg-card__body h3{font-size:11px}.sarg-card--compact .sarg-card__foot{left:9px;right:9px;bottom:10px;font-size:4.8px}.sarg-card--compact .sarg-card__foot b{font-size:5px}.sarg-card--compact .sarg-card__quantity{top:43px;right:7px}
    .sarg-collection__intro{display:flex;align-items:flex-end;justify-content:space-between;margin:4px 2px 15px}.sarg-collection__intro small{font:7px/1 monospace;letter-spacing:.22em;color:#68889c}.sarg-collection__intro h2{margin:5px 0 0;font:500 20px/1.2 "Noto Serif SC",serif;letter-spacing:.14em}.sarg-collection__count{display:flex;align-items:flex-end;gap:4px;color:#7893a3}.sarg-collection__count b{font:400 27px/.9 "Noto Serif SC",serif;color:#c5d9e4}.sarg-collection__count span{font-size:7px;line-height:1.4}.sarg-collection__grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:15px;padding-bottom:20px}.sarg-empty{min-height:360px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:#687f8d}.sarg-empty__mark{position:relative;width:74px;height:74px;margin-bottom:18px;border:1px solid #496777;border-radius:50%}.sarg-empty__mark:before,.sarg-empty__mark:after,.sarg-empty__mark i{content:"";position:absolute;left:50%;top:50%;background:#496777}.sarg-empty__mark:before{width:1px;height:92px;transform:translate(-50%,-50%)}.sarg-empty__mark:after{width:92px;height:1px;transform:translate(-50%,-50%)}.sarg-empty__mark i:first-child{width:28px;height:28px;transform:translate(-50%,-50%) rotate(45deg);border:1px solid #66889a;background:#0a121b}.sarg-empty__mark i:last-child{width:7px;height:7px;transform:translate(-50%,-50%) rotate(45deg);background:#8bb5c9}.sarg-empty h3{margin:0;font:500 14px/1.3 "Noto Serif SC",serif;letter-spacing:.14em;color:#98afbb}.sarg-empty p{max-width:250px;margin:8px 0 0;font-size:9px;line-height:1.7}
    .sarg-detail-backdrop{position:fixed;z-index:20;inset:0;display:flex;align-items:flex-end;padding:calc(var(--sarg-safe-top) + 12px) 12px calc(var(--sarg-safe-bottom) + 12px);background:rgba(2,5,9,.82);backdrop-filter:blur(7px)}.sarg-detail{position:relative;width:100%;max-height:100%;overflow:auto;display:grid;grid-template-columns:42% 1fr;gap:14px;padding:35px 15px 18px;border:1px solid rgba(137,184,208,.24);background:linear-gradient(145deg,#111d27,#070d13 68%);clip-path:polygon(14px 0,100% 0,100% calc(100% - 14px),calc(100% - 14px) 100%,0 100%,0 14px)}.sarg-detail__close{position:absolute;right:9px;top:8px;width:29px;height:29px;display:grid;place-items:center;color:#9db2be;border:1px solid #446071;background:#0b141c}.sarg-detail__card{align-self:start}.sarg-detail__copy{align-self:center}.sarg-detail__copy>small{font:6px/1.5 monospace;letter-spacing:.13em;color:#668799}.sarg-detail__copy h2{margin:6px 0 8px;font:500 17px/1.3 "Noto Serif SC",serif;letter-spacing:.08em}.sarg-detail__copy>p{margin:0;font-size:9px;line-height:1.75;color:#9aabb4}.sarg-detail__memory{margin-top:13px;padding-top:10px;border-top:1px solid #57718338}.sarg-detail__memory b,.sarg-detail__memory span{display:block}.sarg-detail__memory b{font-size:7px;letter-spacing:.15em;color:#7896a6}.sarg-detail__memory span{margin-top:5px;font-size:8px;line-height:1.6;color:#7f929c}.sarg-detail__tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:9px}.sarg-detail__tags span{padding:3px 5px;border:1px solid #415c6c;font-size:6px;color:#83a0af}.sarg-detail__simulate{width:100%;height:40px;margin-top:13px;border:1px solid #354c59;background:#0b141b;color:#697d88;font-size:10px;letter-spacing:.1em}.sarg-detail__simulate span{display:block;margin-top:2px;font-size:6px;letter-spacing:.14em;opacity:.65}
    @keyframes sarg-orbit{to{transform:rotate(360deg)}}@keyframes sarg-core{50%{filter:brightness(1.8);transform:translate(-50%,-50%) rotate(225deg) scale(1.12)}}@keyframes sarg-capsule-drop{0%{opacity:0;transform:translate(-50%,-168px) rotate(-22deg) scale(.75)}64%{opacity:1;transform:translate(-50%,5px) rotate(8deg) scale(1.03)}82%{transform:translate(-50%,-6px) rotate(-4deg)}100%{transform:translate(-50%,0) rotate(0)}}@keyframes sarg-fade{50%{opacity:.38}}@keyframes sarg-seam{0%{box-shadow:0 0 0 var(--sar-card-accent)}100%{box-shadow:0 0 34px 12px color-mix(in srgb,var(--sar-card-accent),transparent 22%)}}@keyframes sarg-open-top{to{opacity:0;transform:translate(-22px,-52px) rotate(-34deg)}}@keyframes sarg-open-bottom{to{opacity:0;transform:translate(25px,33px) rotate(28deg)}}@keyframes sarg-open-glow{to{opacity:.7;transform:scale(1.8)}}@keyframes sarg-card-rise{0%{opacity:0;transform:translateY(80px) perspective(500px) rotateX(20deg) scale(.72);filter:brightness(2)}100%{opacity:1;transform:translateY(0) perspective(500px) rotateX(0) scale(1);filter:brightness(1)}}@keyframes sarg-reveal-copy{from{opacity:0;transform:translateY(8px)}}
    @media (min-width:700px){.sarg-main,.sarg-collection{max-width:620px;margin:0 auto}.sarg-collection__grid{grid-template-columns:repeat(3,minmax(0,1fr))}.sarg-detail{max-width:620px;margin:0 auto;grid-template-columns:210px 1fr}.sarg-reveal__card{width:210px}}
    @media (max-height:700px){.sarg-machine{height:290px;transform:scale(.86);transform-origin:top center;margin-bottom:-42px}.sarg-pool-copy{margin-top:10px}.sarg-pool-copy h2{font-size:18px}.sarg-reveal__card{width:min(46vw,174px)}.sarg-detail__copy>p{line-height:1.5}.sarg-detail__memory{margin-top:8px;padding-top:7px}}
    @media (prefers-reduced-motion:reduce){.sarg-root *{animation-duration:.01ms!important;animation-iteration-count:1!important;scroll-behavior:auto!important}}
`}</style>;

const SARGachaProductStyle = () => <style>{`
    .sarg-root{
        --sarg-pool:#8edfff;
        --sarg-pool-rgb:142,223,255;
        --sarg-ink:#eff9ff;
        isolation:isolate;
        background:
            radial-gradient(ellipse 80% 54% at 50% 42%,rgba(var(--sarg-pool-rgb),.13),transparent 68%),
            linear-gradient(180deg,#07111c 0%,#040910 62%,#020509 100%);
    }
    .sarg-root--story{--sarg-pool:#e9a49b;--sarg-pool-rgb:233,164,155;--sarg-ink:#fff4ef}
    .sarg-root:before{inset:56% 0 0;background:linear-gradient(180deg,transparent,rgba(0,0,0,.52));z-index:0}
    .sarg-root:after{content:"";position:absolute;z-index:0;left:50%;top:44%;width:min(112vw,530px);aspect-ratio:1;transform:translate(-50%,-50%);border-radius:50%;pointer-events:none;background:radial-gradient(circle,rgba(var(--sarg-pool-rgb),.07),transparent 64%);filter:blur(24px);transition:background .45s}
    .sarg-noise{z-index:1;opacity:.2;background-image:radial-gradient(1px 1px at 12% 16%,#fff8,transparent),radial-gradient(1px 1px at 78% 21%,#fff7,transparent),radial-gradient(1px 1px at 88% 57%,#fff5,transparent),radial-gradient(1px 1px at 19% 69%,#fff5,transparent),radial-gradient(1px 1px at 58% 83%,#fff4,transparent);background-size:auto}

    .sarg-header{grid-template-columns:44px 1fr 44px;gap:8px;padding:calc(var(--sarg-safe-top) + 5px) 13px 7px;border:0;background:linear-gradient(180deg,rgba(2,6,11,.76),transparent);backdrop-filter:none}
    .sarg-header>button{width:42px;height:42px;border:0;clip-path:none;border-radius:50%;background:transparent;color:#b8c7d0;transition:background .18s,color .18s}
    .sarg-header>button:active{background:rgba(var(--sarg-pool-rgb),.1);color:var(--sarg-ink)}
    .sarg-header small{font-size:8px;letter-spacing:.2em;color:#637988}
    .sarg-header h1{margin-top:3px;font-size:16px;letter-spacing:.13em;color:#e9f0f4}
    .sarg-header .sarg-header__archive{width:42px;gap:0;border-radius:14px;background:rgba(255,255,255,.035)}
    .sarg-header__archive span{font:600 13px/1.1 Inter,sans-serif;color:var(--sarg-ink)}
    .sarg-header__archive i{font-size:8px;letter-spacing:.08em;color:#718793}

    .sarg-main,.sarg-collection{height:calc(100% - var(--sarg-safe-top) - 54px);padding:6px 20px calc(var(--sarg-safe-bottom) + 18px)}
    .sarg-pool-switch{position:relative;z-index:6;max-width:354px;margin:0 auto;display:grid;padding:0;border:0;clip-path:none;background:rgba(255,255,255,.025);border-radius:15px}
    .sarg-pool-switch button{min-height:46px;padding:7px 10px 8px;border:0!important;outline:0;border-radius:13px;color:#5f7380;background:transparent;box-shadow:none!important;transition:color .24s,background .24s}
    .sarg-pool-switch button:focus-visible{box-shadow:inset 0 0 0 1px rgba(var(--sarg-pool-rgb),.34)!important}
    .sarg-pool-switch button.is-active{color:var(--sarg-ink);background:rgba(var(--sarg-pool-rgb),.09)}
    .sarg-pool-switch button.is-active:after{content:"";position:absolute;left:31%;right:31%;bottom:0;height:2px;border-radius:2px;background:var(--sarg-pool);box-shadow:0 0 12px rgba(var(--sarg-pool-rgb),.8)}
    .sarg-pool-switch span{font:500 13px/1.2 "Noto Serif SC",serif;letter-spacing:.09em}
    .sarg-pool-switch small{margin-top:4px;font-size:8px;letter-spacing:.07em;opacity:.62}
    .sarg-pool-switch i{display:none}

    .sarg-pool-copy{position:relative;z-index:3;margin:18px 0 0;text-align:center}
    .sarg-pool-copy small{font:8px/1.2 Inter,sans-serif;letter-spacing:.2em;color:rgba(var(--sarg-pool-rgb),.62)}
    .sarg-pool-copy h2{margin:7px 0 5px;font:500 clamp(22px,6.4vw,27px)/1.3 "Noto Serif SC",serif;letter-spacing:.05em;color:var(--sarg-ink);text-shadow:0 0 28px rgba(var(--sarg-pool-rgb),.13)}
    .sarg-pool-copy p{margin:0;font-size:11px;line-height:1.45;letter-spacing:0;color:#718590}

    .sarg-machine{height:348px;max-width:390px;margin:-5px auto 0;overflow:visible}
    .sarg-machine__halo{left:50%;top:47%;width:320px;height:320px;transform:translate(-50%,-50%);border-radius:50%;background:radial-gradient(circle,rgba(var(--sarg-pool-rgb),.17),rgba(var(--sarg-pool-rgb),.035) 43%,transparent 69%);filter:blur(12px);animation:sarg-breathe 4.8s ease-in-out infinite}
    .sarg-machine__portal{position:absolute;z-index:2;left:50%;top:30px;width:272px;height:272px;transform:translateX(-50%);border-radius:50%;background:radial-gradient(circle at 50% 48%,rgba(var(--sarg-pool-rgb),.17),rgba(5,15,24,.74) 32%,#030810 67%);box-shadow:inset 0 0 48px rgba(var(--sarg-pool-rgb),.11),0 0 0 1px rgba(var(--sarg-pool-rgb),.26),0 0 50px rgba(var(--sarg-pool-rgb),.08);transition:filter .4s,opacity .4s,transform .6s cubic-bezier(.2,.72,.2,1)}
    .sarg-machine__portal:before,.sarg-machine__portal:after{content:"";position:absolute;border-radius:50%;pointer-events:none}
    .sarg-machine__portal:before{inset:9px;border:1px solid rgba(var(--sarg-pool-rgb),.18);box-shadow:inset 0 0 0 5px rgba(1,6,11,.7),inset 0 0 0 6px rgba(var(--sarg-pool-rgb),.09)}
    .sarg-machine__portal:after{inset:33px;background:radial-gradient(circle,transparent 52%,rgba(var(--sarg-pool-rgb),.09) 53%,transparent 54%),conic-gradient(from 18deg,transparent,rgba(var(--sarg-pool-rgb),.12),transparent 17%,transparent 34%,rgba(var(--sarg-pool-rgb),.08),transparent 51%,transparent 76%,rgba(var(--sarg-pool-rgb),.13),transparent);border:1px solid rgba(var(--sarg-pool-rgb),.14)}
    .sarg-machine__ticks{position:absolute;inset:-15px;border-radius:50%;background:repeating-conic-gradient(from 1deg,rgba(var(--sarg-pool-rgb),.42) 0 1deg,transparent 1deg 8deg);mask:radial-gradient(circle,transparent 68%,#000 68.5% 70%,transparent 70.5%);opacity:.58}
    .sarg-machine__rings{left:50%;top:50%;width:218px;height:218px;transform:translate(-50%,-50%);animation:sarg-orbit-slow 24s linear infinite}
    .sarg-machine__rings i{border-color:rgba(var(--sarg-pool-rgb),.22)}
    .sarg-machine__rings i:before{width:5px;height:5px;top:-3px;border-color:rgba(var(--sarg-pool-rgb),.72);background:#07131d;box-shadow:0 0 8px rgba(var(--sarg-pool-rgb),.55)}
    .sarg-machine__rings i:nth-child(2){inset:24px;border-style:dashed;transform:rotate(31deg)}
    .sarg-machine__rings i:nth-child(3){inset:51px;border-color:rgba(var(--sarg-pool-rgb),.3);transform:rotate(67deg)}
    .sarg-machine__meridian{position:absolute;inset:28px;border-radius:50%;opacity:.5}
    .sarg-machine__meridian i{position:absolute;left:50%;top:0;width:46%;height:100%;transform:translateX(-50%);border:1px solid rgba(var(--sarg-pool-rgb),.18);border-top:0;border-bottom:0;border-radius:50%}
    .sarg-machine__meridian i+ i{transform:translateX(-50%) rotate(90deg)}
    .sarg-machine__core{left:50%;top:50%;width:104px;height:104px;transform:translate(-50%,-50%);display:grid;place-items:center;border:1px solid rgba(var(--sarg-pool-rgb),.42);border-radius:50%;background:radial-gradient(circle,rgba(var(--sarg-pool-rgb),.16),rgba(3,10,17,.94) 68%);box-shadow:0 0 36px rgba(var(--sarg-pool-rgb),.14);transition:opacity .3s,transform .45s}
    .sarg-machine__core:before,.sarg-machine__core:after{background:linear-gradient(transparent,rgba(var(--sarg-pool-rgb),.35),transparent)}
    .sarg-machine__core:before{left:50%;top:-35px;width:1px;height:174px}
    .sarg-machine__core:after{left:-35px;top:50%;width:174px;height:1px}
    .sarg-machine__core i{inset:auto;left:50%;top:27px;width:16px;height:16px;transform:translateX(-50%) rotate(45deg);border:1px solid var(--sarg-pool);border-radius:1px;background:rgba(var(--sarg-pool-rgb),.16);box-shadow:0 0 16px rgba(var(--sarg-pool-rgb),.5)}
    .sarg-machine__core b,.sarg-machine__core small{position:absolute;left:0;right:0;text-align:center}
    .sarg-machine__core b{top:48px;font:500 17px/1.2 "Noto Serif SC",serif;letter-spacing:.16em;color:var(--sarg-ink)}
    .sarg-machine__core small{top:72px;font:8px/1 Inter,sans-serif;letter-spacing:.2em;color:rgba(var(--sarg-pool-rgb),.6)}
    .sarg-machine__stars{position:absolute;inset:0;z-index:1}
    .sarg-machine__stars i{position:absolute;width:2px;height:2px;border-radius:50%;background:var(--sarg-pool);box-shadow:0 0 7px var(--sarg-pool);opacity:.45;animation:sarg-star 3s ease-in-out infinite}
    .sarg-machine__stars i:nth-child(1){left:9%;top:28%}.sarg-machine__stars i:nth-child(2){right:7%;top:21%;animation-delay:-1.1s}.sarg-machine__stars i:nth-child(3){left:16%;top:67%;animation-delay:-2s}.sarg-machine__stars i:nth-child(4){right:14%;top:73%;animation-delay:-.5s}.sarg-machine__stars i:nth-child(5){left:28%;top:13%;animation-delay:-1.6s}.sarg-machine__stars i:nth-child(6){right:25%;top:83%;animation-delay:-2.4s}
    .sarg-machine__horizon{position:absolute;z-index:1;left:50%;bottom:32px;width:330px;height:36px;transform:translateX(-50%);overflow:hidden}
    .sarg-machine__horizon:before{content:"";position:absolute;left:50%;top:8px;width:270px;height:42px;transform:translateX(-50%);border-top:1px solid rgba(var(--sarg-pool-rgb),.25);border-radius:50%;box-shadow:0 -8px 28px rgba(var(--sarg-pool-rgb),.05)}
    .sarg-machine__horizon i{position:absolute;left:50%;top:5px;width:7px;height:7px;transform:translateX(-50%) rotate(45deg);border:1px solid rgba(var(--sarg-pool-rgb),.6);background:#06101a}
    .sarg-machine__caption{position:absolute;z-index:3;left:0;right:0;bottom:3px;text-align:center}
    .sarg-machine__caption span,.sarg-machine__caption small{display:block}
    .sarg-machine__caption span{font:10px/1.3 "Noto Serif SC",serif;letter-spacing:.14em;color:#91a8b4}
    .sarg-machine__caption small{margin-top:4px;font:7px/1 Inter,sans-serif;letter-spacing:.18em;color:#415766}

    .sarg-machine--drawing .sarg-machine__portal{animation:sarg-pressure 1.5s cubic-bezier(.4,0,.2,1) both}
    .sarg-machine--drawing .sarg-machine__ticks{animation:sarg-orbit .55s linear infinite}
    .sarg-machine--drawing .sarg-machine__rings{animation:sarg-orbit-centered .9s linear infinite reverse}
    .sarg-machine--drawing .sarg-machine__rings i:nth-child(2){animation:sarg-orbit .52s linear infinite}
    .sarg-machine--drawing .sarg-machine__core{animation:sarg-core-pulse .5s ease-in-out infinite}
    .sarg-machine--capsule .sarg-machine__portal,.sarg-machine--opening .sarg-machine__portal{filter:brightness(.58) blur(1px);transform:translateX(-50%) scale(.94)}
    .sarg-machine--capsule .sarg-machine__core,.sarg-machine--opening .sarg-machine__core{opacity:.16;transform:translate(-50%,-50%) scale(.6)}
    .sarg-machine--opening:after{content:"";position:absolute;z-index:8;left:50%;top:151px;width:20px;height:20px;transform:translate(-50%,-50%);border-radius:50%;background:#fff;box-shadow:0 0 24px 12px #fff,0 0 80px 45px rgba(var(--sarg-pool-rgb),.92);animation:sarg-flash .86s ease-out both;pointer-events:none}

    .sarg-capsule{z-index:7;left:50%;top:80px;bottom:auto;width:116px;height:142px;filter:drop-shadow(0 22px 22px #000a);animation:sarg-capsule-arrive .7s cubic-bezier(.15,.84,.22,1.18) both}
    .sarg-capsule__glow{inset:-21px -28px -18px;background:radial-gradient(circle,color-mix(in srgb,var(--sar-card-accent),white 8%) 0,transparent 66%);opacity:.22;filter:blur(14px);animation:sarg-capsule-aura 1.8s ease-in-out infinite}
    .sarg-capsule__half{left:8px;width:100px;height:57px;border-color:color-mix(in srgb,var(--sar-card-accent),white 25%);background:linear-gradient(145deg,color-mix(in srgb,var(--sar-card-accent),#162532 69%),#06101a 76%);box-shadow:inset 9px 7px 16px rgba(255,255,255,.04),inset -12px -11px 19px rgba(0,0,0,.42)}
    .sarg-capsule__half:before{inset:8px 19px;border-color:color-mix(in srgb,var(--sar-card-accent),transparent 38%)}
    .sarg-capsule__half--top{top:7px;border-radius:58px 58px 5px 5px}.sarg-capsule__half--bottom{top:62px;border-radius:5px 5px 58px 58px}
    .sarg-capsule__half i{width:21px;height:21px;border-color:color-mix(in srgb,var(--sar-card-accent),white 16%)}
    .sarg-capsule__seam{left:2px;top:60px;width:112px;height:12px;border-color:color-mix(in srgb,var(--sar-card-accent),white 20%);background:#050d15;box-shadow:0 0 15px color-mix(in srgb,var(--sar-card-accent),transparent 28%)}
    .sarg-capsule>b{top:150px;width:130px;font:500 11px/1.2 "Noto Serif SC",serif;letter-spacing:.16em;color:#e4eef2;animation:sarg-fade 1.25s ease-in-out infinite}
    .sarg-machine--opening .sarg-capsule__half--top{animation:sarg-open-top-product .76s .08s cubic-bezier(.15,.68,.22,1) both}.sarg-machine--opening .sarg-capsule__half--bottom{animation:sarg-open-bottom-product .76s .08s cubic-bezier(.15,.68,.22,1) both}.sarg-machine--opening .sarg-capsule__glow{animation:sarg-open-glow .8s ease-out both}

    .sarg-draw-panel{z-index:5;max-width:354px;min-height:91px;margin:-1px auto 0}
    .sarg-draw-panel__meta{justify-content:center;gap:8px;padding:0 0 9px;font-size:10px;color:#607681}
    .sarg-draw-panel__meta span:after{content:" ·"}.sarg-draw-panel__meta b{font-weight:600;color:var(--sarg-pool)}
    .sarg-draw-button{height:58px;border:0;border-radius:17px;clip-path:none;color:#071018;background:linear-gradient(135deg,color-mix(in srgb,var(--sarg-pool),white 18%),color-mix(in srgb,var(--sarg-pool),#4e7180 28%));box-shadow:0 15px 38px rgba(var(--sarg-pool-rgb),.14),inset 0 1px rgba(255,255,255,.44);transition:transform .15s,filter .15s,box-shadow .15s}
    .sarg-draw-button:active:not(:disabled){transform:translateY(2px) scale(.985);filter:brightness(.92);box-shadow:0 7px 20px rgba(var(--sarg-pool-rgb),.12)}
    .sarg-draw-button:disabled{color:#60717a;background:#111a20;box-shadow:inset 0 0 0 1px rgba(255,255,255,.05)}
    .sarg-draw-button span{font:600 15px/1.2 "Noto Serif SC",serif;letter-spacing:.13em}.sarg-draw-button small{margin-top:5px;font:8px/1 Inter,sans-serif;letter-spacing:.13em;opacity:.66}
    .sarg-draw-panel>p:not(.sarg-machine-status){margin-top:9px;font-size:9px;color:#465a66;letter-spacing:0}
    .sarg-machine-status{margin:0;padding:30px 0 0;font:500 12px/1.5 "Noto Serif SC",serif;letter-spacing:.08em;color:#9ab1bd}

    .sarg-reveal{position:relative;min-height:calc(100% - 46px);padding:20px 0 12px;overflow:hidden}
    .sarg-reveal__aura{position:absolute;z-index:-1;left:50%;top:37%;width:390px;height:390px;transform:translate(-50%,-50%);border-radius:50%;background:radial-gradient(circle,color-mix(in srgb,var(--sar-card-accent),transparent 75%),transparent 64%);animation:sarg-aura-in 1s ease-out both}
    .sarg-reveal__aura i{position:absolute;inset:12%;border:1px solid color-mix(in srgb,var(--sar-card-accent),transparent 67%);border-radius:50%;animation:sarg-orbit-slow 20s linear infinite}
    .sarg-reveal__aura i:nth-child(2){inset:24%;border-style:dashed;animation-direction:reverse;animation-duration:15s}.sarg-reveal__aura i:nth-child(3){inset:2%;border-color:color-mix(in srgb,var(--sar-card-accent),transparent 86%);animation-duration:32s}
    .sarg-reveal__eyebrow{margin-bottom:12px;font-size:10px;letter-spacing:.17em;color:color-mix(in srgb,var(--sar-card-accent),white 30%)}
    .sarg-reveal__card{width:min(60vw,238px);filter:drop-shadow(0 22px 28px #0009);animation:sarg-card-rise-product .78s cubic-bezier(.15,.78,.18,1.02) both}
    .sarg-reveal__name{margin-top:10px;text-align:center;animation:sarg-reveal-copy .5s .35s ease-out both}
    .sarg-reveal__name small,.sarg-reveal__name b{display:block}.sarg-reveal__name small{font-size:8px;letter-spacing:.15em;color:#6f8793}.sarg-reveal__name b{margin-top:3px;font:500 15px/1.35 "Noto Serif SC",serif;letter-spacing:.09em;color:var(--sarg-ink)}
    .sarg-reveal__actions{grid-template-columns:1fr 1fr;gap:9px;max-width:354px;margin-top:14px}
    .sarg-primary,.sarg-secondary{height:48px;border:0;border-radius:14px;font-size:11px;letter-spacing:.08em}
    .sarg-primary{color:#091118;background:color-mix(in srgb,var(--sar-card-accent),white 24%);box-shadow:0 10px 28px color-mix(in srgb,var(--sar-card-accent),transparent 78%)}
    .sarg-secondary{color:#8799a2;background:rgba(255,255,255,.05)}

    .sarg-card{border-color:color-mix(in srgb,var(--sar-card-accent),transparent 38%);background:radial-gradient(circle at 50% 39%,color-mix(in srgb,var(--sar-card-accent),transparent 76%),transparent 38%),linear-gradient(155deg,color-mix(in srgb,var(--sar-card-accent),#08111a 88%),#03070b 70%);box-shadow:inset 0 0 34px #0008,0 16px 40px #0008}
    .sarg-card:before{inset:7px;border-color:color-mix(in srgb,var(--sar-card-accent),transparent 67%)}
    .sarg-card:after{opacity:.1}
    .sarg-card__head{left:15px;right:15px;top:14px;height:43px}.sarg-card__head span{font-size:15px;letter-spacing:.08em}.sarg-card__head small{margin-top:3px;font-size:6px}.sarg-card__head b{top:8px;font-size:7px}
    .sarg-card__group{left:15px;top:67px;font-size:7px}.sarg-card__body{left:15px;right:15px;bottom:45px}.sarg-card__body h3{font-size:15px}.sarg-card__body p{margin-top:6px;font-size:8px;line-height:1.55}.sarg-card__foot{left:15px;right:15px;bottom:16px;font-size:6.5px}.sarg-card__foot b{font-size:7px}
    .sarg-card--compact .sarg-card__head span{font-size:12px}.sarg-card--compact .sarg-card__head small{font-size:5px}.sarg-card--compact .sarg-card__body h3{font-size:12px}.sarg-card--compact .sarg-card__group{font-size:6px}.sarg-card--compact .sarg-card__foot{font-size:5.5px}

    .sarg-collection{padding-top:12px}.sarg-collection__intro{margin:3px 2px 18px;align-items:center}.sarg-collection__intro small{font-size:8px}.sarg-collection__intro h2{margin-top:6px;font-size:22px;letter-spacing:.08em}.sarg-collection__count b{font-size:30px}.sarg-collection__count span{font-size:8px}.sarg-collection__grid{gap:14px;margin-top:18px}.sarg-empty h3{font-size:16px}.sarg-empty p{font-size:11px}
    .sarg-detail-backdrop{background:rgba(1,4,7,.86);backdrop-filter:blur(12px)}
    .sarg-detail{gap:16px;padding:42px 17px 20px;border:0;border-radius:24px 24px 12px 12px;clip-path:none;background:linear-gradient(145deg,#14222d,#080e14 70%);box-shadow:0 24px 80px #000}
    .sarg-detail__close{right:11px;top:10px;width:32px;height:32px;border:0;border-radius:50%;background:rgba(255,255,255,.06)}
    .sarg-detail__copy>small{font-size:7px}.sarg-detail__copy h2{font-size:19px}.sarg-detail__copy>p{font-size:10.5px;line-height:1.65}.sarg-detail__memory b{font-size:8px}.sarg-detail__memory span{font-size:9.5px}.sarg-detail__tags span{padding:4px 7px;border-radius:10px;font-size:7px}.sarg-detail__simulate{height:44px;border:0;border-radius:12px;background:rgba(255,255,255,.04)}

    @keyframes sarg-breathe{50%{opacity:.66;transform:translate(-50%,-50%) scale(1.06)}}
    @keyframes sarg-star{50%{opacity:1;transform:scale(1.8)}}
    @keyframes sarg-orbit-slow{to{transform:translate(-50%,-50%) rotate(360deg)}}
    @keyframes sarg-orbit-centered{to{transform:translate(-50%,-50%) rotate(360deg)}}
    @keyframes sarg-pressure{0%{filter:brightness(1);transform:translateX(-50%) scale(1)}42%{filter:brightness(1.35);transform:translateX(-50%) scale(.92)}72%{filter:brightness(1.9);transform:translateX(-50%) scale(1.035)}100%{filter:brightness(.68);transform:translateX(-50%) scale(.94)}}
    @keyframes sarg-core-pulse{50%{filter:brightness(2.2);transform:translate(-50%,-50%) scale(.84)}}
    @keyframes sarg-capsule-arrive{0%{opacity:0;transform:translate(-50%,-70px) scale(.38) rotate(-24deg);filter:brightness(2.4) drop-shadow(0 0 30px var(--sar-card-accent))}68%{opacity:1;transform:translate(-50%,8px) scale(1.05) rotate(5deg)}84%{transform:translate(-50%,-4px) scale(.98) rotate(-2deg)}100%{transform:translate(-50%,0) scale(1) rotate(0)}}
    @keyframes sarg-capsule-aura{50%{opacity:.38;transform:scale(1.12)}}
    @keyframes sarg-open-top-product{to{opacity:0;transform:translate(-42px,-74px) rotate(-42deg) scale(.78)}}
    @keyframes sarg-open-bottom-product{to{opacity:0;transform:translate(45px,58px) rotate(38deg) scale(.78)}}
    @keyframes sarg-flash{0%{opacity:0;transform:translate(-50%,-50%) scale(.1)}24%{opacity:1}100%{opacity:0;transform:translate(-50%,-50%) scale(15)}}
    @keyframes sarg-card-rise-product{0%{opacity:0;transform:translateY(88px) perspective(700px) rotateX(24deg) scale(.68);filter:brightness(2.5) blur(4px)}100%{opacity:1;transform:none;filter:brightness(1) blur(0)}}
    @keyframes sarg-aura-in{from{opacity:0;transform:translate(-50%,-50%) scale(.45)}to{opacity:1;transform:translate(-50%,-50%) scale(1)}}

    @media (min-width:700px){.sarg-main,.sarg-collection{max-width:660px}.sarg-reveal__card{width:236px}.sarg-machine{max-width:430px}}
    @media (max-height:740px){.sarg-pool-copy{margin-top:10px}.sarg-pool-copy h2{font-size:20px;margin-top:4px}.sarg-pool-copy p{font-size:10px}.sarg-machine{height:292px;transform:scale(.86);transform-origin:top center;margin-bottom:-39px}.sarg-reveal{padding-top:10px}.sarg-reveal__card{width:min(48vw,190px)}.sarg-reveal__name{margin-top:6px}.sarg-reveal__actions{margin-top:9px}}
`}</style>;
