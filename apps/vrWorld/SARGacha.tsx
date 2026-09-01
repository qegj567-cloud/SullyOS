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

const poolCopy = (pool: SARModulePool) => pool === 'variant'
    ? { cn: '人格补丁', en: 'VARIANT MODULE', hint: '抽取一种改写人生与决策方式的补丁母体', count: 25 }
    : { cn: '演算场', en: 'SIMULATION FIELD', hint: '抽取一组适配角色世界观的压力与规则', count: 24 };

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
                <span>{module.pool === 'variant' ? '补丁收录状态' : '演算场收录状态'}</span>
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
            const available = isSARFreeDrawAvailable(item, state);
            return (
                <button key={item} type="button" role="tab" aria-selected={pool === item} disabled={disabled}
                    className={pool === item ? 'is-active' : ''} onClick={() => onChange(item)}>
                    <span>{poolCopy(item).cn}</span><small>{poolCopy(item).en}</small>
                    {available && <i aria-label="今日免费抽取可用" />}
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
        <div className="sarg-machine__halo" />
        <div className="sarg-machine__case">
            <span className="sarg-machine__serial">SAR · {pool === 'variant' ? 'V-25' : 'S-24'}</span>
            <div className="sarg-machine__window">
                <div className="sarg-machine__rings"><i /><i /><i /></div>
                <div className="sarg-machine__core"><i /></div>
                <div className="sarg-machine__scan">{pool === 'variant' ? 'PERSONALITY DIVERGENCE' : 'WORLDLINE COMPILATION'}</div>
            </div>
            <div className="sarg-machine__rail"><i /><i /><i /><i /><i /></div>
            <div className="sarg-machine__chute"><span /></div>
        </div>
        {(phase === 'capsule' || phase === 'opening') && result && (
            <button type="button" className="sarg-capsule" onClick={onOpenCapsule} disabled={phase === 'opening'}
                aria-label={phase === 'capsule' ? '打开扭蛋' : '正在打开扭蛋'} style={cssVars(result)}>
                <span className="sarg-capsule__glow" />
                <span className="sarg-capsule__half sarg-capsule__half--top"><i /></span>
                <span className="sarg-capsule__seam" />
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
                <div><small>DISPLAY ARCHIVE</small><h2>模块陈列空间</h2></div>
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
                    <p>从{poolCopy(pool).cn}池完成一次推演抽取，模块会被送到这里。</p>
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
                <div className="sarg-detail__memory"><b>记忆处理</b><span>{module.memory}</span></div>
                {module.routeTags && <div className="sarg-detail__tags">{module.routeTags.map(tag => <span key={tag}>{tag}</span>)}</div>}
                <button type="button" disabled className="sarg-detail__simulate">用于异格铸造 <span>前往陈列柜装载</span></button>
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

    const schedule = (callback: () => void, normalDelay: number) => {
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(callback, reducedMotion.current ? 80 : normalDelay);
    };

    const startDraw = () => {
        if (phase !== 'idle') return;
        const draw = drawSARModule(pool);
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

    const available = isSARFreeDrawAvailable(pool, state);
    const collectedUnique = Object.keys(state.collection).filter(id => state.collection[id] > 0).length;
    const busy = phase === 'drawing' || phase === 'capsule' || phase === 'opening';

    return (
        <div className="sarg-root" role="dialog" aria-modal="true" aria-label="SAR 人格推演扭蛋机">
            <SARGachaStyle />
            <div className="sarg-noise" />
            <header className="sarg-header">
                <button type="button" onClick={view === 'collection' ? () => setView('machine') : onClose} aria-label={view === 'collection' ? '返回扭蛋机' : '离开扭蛋机'}>
                    {view === 'collection' ? <CaretLeft size={19} /> : <X size={18} />}
                </button>
                <div><small>SAR ACTIVITY SPACE · 01</small><h1>人格推演设备</h1></div>
                <button type="button" className="sarg-header__archive" onClick={() => setView(view === 'collection' ? 'machine' : 'collection')} disabled={busy} aria-label="打开模块陈列空间">
                    <span>{collectedUnique}</span><i>陈列</i>
                </button>
            </header>

            {view === 'collection' ? (
                <SARCollection state={state} pool={pool} onPoolChange={setPool} onSelect={setDetail} />
            ) : (
                <main className="sarg-main">
                    <PoolSwitch pool={pool} state={state} disabled={busy || phase === 'revealed'} onChange={changePool} />
                    {phase === 'revealed' && result ? (
                        <div className="sarg-reveal" style={cssVars(result)}>
                            <div className="sarg-reveal__eyebrow"><Sparkle size={12} weight="fill" /> {firstCopy ? '新模块已记录' : '既有模块产生共振'}</div>
                            <div className="sarg-reveal__card"><SARModuleCard module={result} quantity={state.collection[result.id]} /></div>
                            <div className="sarg-reveal__actions">
                                <button type="button" className="sarg-primary" onClick={() => { setView('collection'); resetMachine(); }}><Check size={15} weight="bold" /> 放入陈列</button>
                                <button type="button" className="sarg-secondary" onClick={resetMachine}>返回设备</button>
                            </div>
                        </div>
                    ) : (
                        <>
                            <div className="sarg-pool-copy">
                                <small>{poolCopy(pool).en} · {poolCopy(pool).count} MODULES</small>
                                <h2>{poolCopy(pool).cn}</h2>
                                <p>{poolCopy(pool).hint}</p>
                            </div>
                            <SARGachaMachine pool={pool} phase={phase} result={result} onOpenCapsule={openCapsule} />
                            <div className="sarg-draw-panel">
                                {phase === 'capsule' ? (
                                    <p className="sarg-machine-status">推演载体已生成 · 点击扭蛋开启</p>
                                ) : phase === 'opening' ? (
                                    <p className="sarg-machine-status">正在解除封装……</p>
                                ) : phase === 'drawing' ? (
                                    <p className="sarg-machine-status">正在对齐分歧坐标……</p>
                                ) : (
                                    <>
                                        <div className="sarg-draw-panel__meta"><span>今日配额</span><b>{available ? '免费 1 次' : '已领取'}</b></div>
                                        <button type="button" className="sarg-draw-button" disabled={!available} onClick={startDraw}>
                                            <span>{available ? (pool === 'variant' ? '启动人格推演' : '启动剧情演算') : '等待明日校准'}</span><small>{available ? 'FREE DRAW' : 'DAILY DRAW USED'}</small>
                                        </button>
                                        <p>每日 00:00 按本地时间重置 · 两个卡池各自计算</p>
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
