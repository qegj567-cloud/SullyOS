import React, { useEffect, useMemo, useState } from 'react';
import {
    ArrowClockwise,
    CaretLeft,
    Check,
    Package,
    ShoppingBag,
    Sparkle,
    Ticket,
    UserCircle,
    MagicWand,
    ShieldCheck,
    X,
} from '@phosphor-icons/react';
import { useOS } from '../../context/OSContext';
import TokenImg from '../../components/os/TokenImg';
import { getChibi } from '../../utils/vrWorld/chibi';
import {
    consumeSARModule,
    getSARModuleById,
    getSARModuleOffers,
    purchaseSARModule,
    readSARModuleShopState,
    rollSARModuleOffers,
    SAR_MODULE_CATALOG,
    SAR_MODULE_SHOP_DEVELOPMENT_MODE,
    type SARModuleCategory,
    type SARModuleDefinition,
    type SARModuleShopState,
} from '../../utils/vrWorld/sarModuleShop';
import {
    installSARModuleOnCharacter,
    installSARModuleOnUser,
} from '../../utils/vrWorld/sarModuleRuntime';

const SAFE_TOP = 'var(--chrome-top)';
const SAFE_BOTTOM = 'var(--safe-bottom)';

const categoryMeta: Record<SARModuleCategory, { label: string; code: string; color: string; glow: string; mark: string }> = {
    voice: { label: '译码', code: 'VOC', color: '#9bd7ce', glow: 'rgba(83,193,181,.22)', mark: '⌁' },
    bond: { label: '关系', code: 'BND', color: '#e2b6c5', glow: 'rgba(216,123,160,.2)', mark: '◇' },
    genre: { label: '剧目', code: 'GEN', color: '#b9b0e8', glow: 'rgba(142,123,220,.22)', mark: '✦' },
    stage: { label: '演出', code: 'SYS', color: '#d9c995', glow: 'rgba(210,180,91,.2)', mark: '◈' },
};

const ModuleGlyph: React.FC<{ module: SARModuleDefinition; large?: boolean }> = ({ module, large = false }) => {
    const meta = categoryMeta[module.category];
    return (
        <div className={`sar-module-glyph ${large ? 'is-large' : ''}`} style={{ '--module-color': meta.color, '--module-glow': meta.glow } as React.CSSProperties} aria-hidden="true">
            <span className="sar-module-glyph__orbit" />
            <span className="sar-module-glyph__core">{meta.mark}</span>
            <span className="sar-module-glyph__pin sar-module-glyph__pin--a" />
            <span className="sar-module-glyph__pin sar-module-glyph__pin--b" />
        </div>
    );
};

const ModuleCard: React.FC<{
    module: SARModuleDefinition;
    index: number;
    owned: number;
    onOpen: () => void;
}> = ({ module, index, owned, onOpen }) => {
    const meta = categoryMeta[module.category];
    return (
        <button
            type="button"
            className="sar-module-card"
            style={{ '--module-color': meta.color, '--module-glow': meta.glow, '--card-order': index } as React.CSSProperties}
            onClick={onOpen}
            aria-label={`查看模块：${module.title}`}
        >
            <div className="sar-module-card__serial">M-{String(SAR_MODULE_CATALOG.indexOf(module) + 1).padStart(2, '0')}</div>
            <div className="sar-module-card__kind">{meta.code} / {meta.label}</div>
            <ModuleGlyph module={module} />
            <div className="sar-module-card__copy">
                <div className="sar-module-card__title">{module.title}</div>
                <div className="sar-module-card__effect">{module.effectLabel}</div>
            </div>
            <div className="sar-module-card__footer">
                <span><Ticket size={11} weight="fill" />{module.price}</span>
                <span>{owned > 0 ? `持有 ${owned}` : '查看'}</span>
            </div>
        </button>
    );
};

const ModuleDetail: React.FC<{
    module: SARModuleDefinition;
    owned: number;
    npcEnabled: boolean;
    onClose: () => void;
    onPurchase: () => void;
    inventoryMode: boolean;
    onInstall: () => void;
    targetName?: string;
}> = ({ module, owned, npcEnabled, onClose, onPurchase, inventoryMode, onInstall, targetName }) => {
    const meta = categoryMeta[module.category];
    return (
        <div className="sar-module-detail-backdrop" onPointerDown={event => {
            if (event.currentTarget === event.target) onClose();
        }}>
            <section className="sar-module-detail" role="dialog" aria-modal="true" aria-labelledby="sar-module-detail-title" style={{ '--module-color': meta.color, '--module-glow': meta.glow } as React.CSSProperties}>
                <button type="button" className="sar-module-detail__close" onClick={onClose} aria-label="关闭模块详情"><X size={17} /></button>
                <div className="sar-module-detail__hero">
                    <ModuleGlyph module={module} large />
                    <div>
                        <div className="sar-module-detail__code">{meta.code} · MODULE {String(SAR_MODULE_CATALOG.indexOf(module) + 1).padStart(2, '0')}</div>
                        <h2 id="sar-module-detail-title">{module.title}</h2>
                        <p>{module.effectLabel}</p>
                    </div>
                </div>
                <div className="sar-module-detail__rule" />
                <p className="sar-module-detail__description">{module.description}</p>
                {npcEnabled && (
                    <div className="sar-module-caian-note">
                        <span className="sar-module-caian-note__avatar">C</span>
                        <div><b>凯恩的说明</b><p>{module.caianNote}</p></div>
                    </div>
                )}
                <div className="sar-module-example">
                    <span>外显效果 · 原意 → 外显</span>
                    <p>{module.example}</p>
                </div>
                <div className="sar-module-detail__tags">
                    <span>{module.supportsUserTarget ? '可对角色 / 用户装载' : '仅角色端演出'}</span>
                    {module.requiresConfiguration && <span>装载时需设定关键词</span>}
                    <span>角色 10 回合</span>
                    {module.supportsUserTarget && <span>用户 5 回合</span>}
                </div>
                <button type="button" className="sar-module-buy" onClick={inventoryMode ? onInstall : onPurchase}>
                    <span>{inventoryMode ? <><MagicWand size={17} weight="fill" />{targetName ? `装载给 ${targetName}` : '选择装载对象'}</> : <><ShoppingBag size={17} weight="fill" />{SAR_MODULE_SHOP_DEVELOPMENT_MODE ? '试运行领取' : '购买模块'}</>}</span>
                    <span>{inventoryMode ? '消耗 1 枚' : SAR_MODULE_SHOP_DEVELOPMENT_MODE ? '不扣票据' : <><Ticket size={12} weight="fill" /> {module.price}</>}</span>
                </button>
                <div className="sar-module-detail__owned">当前持有 {owned} 枚 · {inventoryMode ? '角色端持续 10 次成功互动' : '领取后收入模块袋，不会自动装载'}</div>
            </section>
        </div>
    );
};

export const SARModuleShopOverlay: React.FC<{
    npcEnabled: boolean;
    initialTargetCharacterId?: string | null;
    onClose: () => void;
}> = ({ npcEnabled, initialTargetCharacterId = null, onClose }) => {
    const { characters, userProfile, updateCharacter, updateUserProfile, addToast } = useOS();
    const [state, setState] = useState<SARModuleShopState>(() => readSARModuleShopState());
    const [view, setView] = useState<'market' | 'inventory'>(() => initialTargetCharacterId ? 'inventory' : 'market');
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [receipt, setReceipt] = useState<{ title: string; count: number } | null>(null);
    const [installingId, setInstallingId] = useState<string | null>(null);
    const [installTargetId, setInstallTargetId] = useState<string | null>(initialTargetCharacterId);
    const [installPhase, setInstallPhase] = useState<'select' | 'confirm' | 'loading' | 'done'>('select');
    const [reverseInstall, setReverseInstall] = useState<{ charName: string; moduleTitle: string } | null>(null);
    const offers = useMemo(() => getSARModuleOffers(state), [state]);
    const inventoryModules = useMemo(() => Object.entries(state.inventory)
        .filter(([, count]) => count > 0)
        .map(([id]) => getSARModuleById(id))
        .filter((module): module is SARModuleDefinition => Boolean(module)), [state.inventory]);
    const selected = selectedId ? getSARModuleById(selectedId) : undefined;
    const ownedTotal = Object.values(state.inventory).reduce((sum, count) => sum + count, 0);
    const eligibleChars = useMemo(() => characters.filter(character => character.vrState?.enabled), [characters]);
    const capturedTarget = initialTargetCharacterId
        ? eligibleChars.find(character => character.id === initialTargetCharacterId)
        : undefined;
    const installing = installingId ? getSARModuleById(installingId) : undefined;
    const installTarget = installTargetId ? eligibleChars.find(character => character.id === installTargetId) : undefined;
    const allowReverse = userProfile.vrState?.allowCharacterModules === true;

    useEffect(() => {
        if (!receipt) return undefined;
        const timer = window.setTimeout(() => setReceipt(null), 1700);
        return () => window.clearTimeout(timer);
    }, [receipt]);

    useEffect(() => {
        const target = window as typeof window & {
            render_game_to_text?: () => string;
            advanceTime?: (milliseconds: number) => void;
        };
        const previousRender = target.render_game_to_text;
        const previousAdvance = target.advanceTime;
        const render = () => JSON.stringify({
            screen: 'sar_module_shop',
            view,
            entry: capturedTarget ? 'captured-character' : 'counter',
            capturedTarget: capturedTarget?.name || null,
            day: state.market.dayKey,
            rollsRemaining: state.market.rollsRemaining,
            developmentMode: SAR_MODULE_SHOP_DEVELOPMENT_MODE,
            offers: offers.map(module => ({ id: module.id, title: module.title, price: module.price, owned: state.inventory[module.id] || 0 })),
            inventory: inventoryModules.map(module => ({ id: module.id, title: module.title, count: state.inventory[module.id] || 0 })),
            selected: selected?.title || null,
            allowCharacterModules: allowReverse,
            installation: installing ? {
                module: installing.title,
                phase: installPhase,
                target: installTarget?.name || null,
                reverseInstall,
            } : null,
        });
        target.render_game_to_text = render;
        target.advanceTime = () => undefined;
        return () => {
            if (target.render_game_to_text === render) {
                if (previousRender) target.render_game_to_text = previousRender;
                else delete target.render_game_to_text;
            }
            if (previousAdvance) target.advanceTime = previousAdvance;
            else delete target.advanceTime;
        };
    }, [allowReverse, capturedTarget?.name, installPhase, installTarget?.name, installing, inventoryModules, offers, reverseInstall, selected, state.inventory, state.market.dayKey, state.market.rollsRemaining, view]);

    const roll = () => {
        if (state.market.rollsRemaining <= 0) return;
        const next = rollSARModuleOffers(state);
        setState(next);
        setSelectedId(null);
    };

    const purchase = (module: SARModuleDefinition) => {
        const result = purchaseSARModule(state, module.id, { developmentMode: SAR_MODULE_SHOP_DEVELOPMENT_MODE });
        if (!result.ok) return;
        setState(result.state);
        setReceipt({ title: module.title, count: result.state.inventory[module.id] || 1 });
    };

    const beginInstall = (module: SARModuleDefinition) => {
        setSelectedId(null);
        setInstallingId(module.id);
        setInstallTargetId(capturedTarget?.id || eligibleChars[0]?.id || null);
        setInstallPhase(capturedTarget ? 'confirm' : 'select');
        setReverseInstall(null);
    };

    const commitInstall = () => {
        if (!installing || !installTarget || installPhase === 'loading') return;
        setInstallPhase('loading');
        window.setTimeout(() => {
            const runtime = installSARModuleOnCharacter(installing);
            updateCharacter(installTarget.id, previous => ({
                vrState: {
                    ...(previous.vrState || { enabled: true, intervalMinutes: 120 }),
                    sarModule: runtime,
                },
            }));
            const consumed = consumeSARModule(state, installing.id);
            if (consumed.ok) setState(consumed.state);

            // 反向触发只在用户明确许可、本人此刻在 SAR、且确有角色逛到模块区时发生。
            // 角色购买的是自己的那枚，不动用户模块袋。
            const reverseCandidates = characters.filter(character => character.vrState?.enabled
                && character.vrState.currentRoom === 'sar'
                && (character.vrState.sarActivity === 'module-shop' || character.id === installTarget.id));
            if (allowReverse
                && userProfile.vrState?.enabled
                && userProfile.vrState.currentRoom === 'sar'
                && !userProfile.vrState.sarModule
                && reverseCandidates.length > 0) {
                const source = reverseCandidates[Math.floor(Math.random() * reverseCandidates.length)];
                const compatible = SAR_MODULE_CATALOG.filter(module => module.supportsUserTarget);
                const reverseModule = compatible[Math.floor(Math.random() * compatible.length)];
                if (source && reverseModule) {
                    updateUserProfile(previous => ({
                        vrState: {
                            ...(previous.vrState || { enabled: true }),
                            sarModule: installSARModuleOnUser(reverseModule, source),
                        },
                    }));
                    setReverseInstall({ charName: source.name, moduleTitle: reverseModule.title });
                }
            }
            setInstallPhase('done');
            addToast?.(`${installing.title} 已装载到 ${installTarget.name}`, 'success');
        }, 920);
    };

    const closeInstall = () => {
        setInstallingId(null);
        setInstallTargetId(capturedTarget?.id || null);
        setInstallPhase('select');
        setReverseInstall(null);
    };

    const toggleReversePermission = () => {
        updateUserProfile(previous => ({
            vrState: {
                ...(previous.vrState || { enabled: false }),
                allowCharacterModules: previous.vrState?.allowCharacterModules !== true,
            },
        }));
    };

    const modules = capturedTarget ? inventoryModules : view === 'market' ? offers : inventoryModules;
    const capturedChibi = capturedTarget ? getChibi(capturedTarget) : null;
    const installTargetChibi = installTarget ? getChibi(installTarget) : null;

    return (
        <div className="sar-module-shop" role="dialog" aria-modal="true" aria-label={capturedTarget ? `给 ${capturedTarget.name} 使用模块` : 'SAR 模块商店'}>
            <style>{`
                .sar-module-shop{position:fixed;inset:0;z-index:390;overflow:hidden;color:#edf4f0;background:linear-gradient(180deg,rgba(7,15,20,.94),rgba(10,15,19,.985));font-family:ui-sans-serif,system-ui,-apple-system,"Noto Sans SC",sans-serif;isolation:isolate}
                .sar-module-shop:before{content:"";position:absolute;inset:0;z-index:-2;background:radial-gradient(circle at 76% 10%,rgba(111,173,170,.13),transparent 32%),radial-gradient(circle at 10% 62%,rgba(142,123,193,.11),transparent 38%),linear-gradient(rgba(151,203,196,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(151,203,196,.035) 1px,transparent 1px);background-size:auto,auto,28px 28px,28px 28px}
                .sar-module-shop:after{content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;background:linear-gradient(90deg,transparent 3.5%,rgba(159,207,200,.12) 3.7%,transparent 3.9%,transparent 96.1%,rgba(159,207,200,.1) 96.3%,transparent 96.5%)}
                .sar-module-shop__header{position:absolute;inset:0 0 auto;height:58px;display:grid;grid-template-columns:52px 1fr auto;align-items:center;padding:0 12px;border-bottom:1px solid rgba(174,218,210,.12);background:rgba(6,13,17,.82);backdrop-filter:blur(14px)}
                .sar-module-shop__back{width:38px;height:38px;border:1px solid rgba(181,224,216,.16);background:rgba(255,255,255,.025);color:#c5d7d2;display:grid;place-items:center;clip-path:polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px)}
                .sar-module-shop__title{text-align:center}.sar-module-shop__title small{display:block;font-family:ui-monospace,monospace;font-size:7px;letter-spacing:.34em;color:rgba(157,212,203,.48)}.sar-module-shop__title h1{margin:3px 0 0;font:500 17px/1.1 "Noto Serif SC",serif;letter-spacing:.2em;color:#edf4f0}
                .sar-module-shop__currency{min-width:64px;text-align:right;font:600 10px/1 ui-monospace,monospace;color:#a8d8d0}.sar-module-shop__currency span{display:block;margin-top:5px;font:400 7px/1 ui-sans-serif,system-ui;color:rgba(219,238,234,.4);letter-spacing:.12em}
                .sar-module-shop__body{position:absolute;inset:58px 0 0;overflow:auto;padding:16px 14px calc(${SAFE_BOTTOM} + 90px);scrollbar-width:none}.sar-module-shop__body::-webkit-scrollbar{display:none}
                .sar-module-shop__notice{display:grid;grid-template-columns:auto 1fr;gap:11px;align-items:center;padding:12px 13px;background:linear-gradient(120deg,rgba(137,195,186,.09),rgba(255,255,255,.025));border:1px solid rgba(170,218,210,.13);clip-path:polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px)}
                .sar-module-shop__guide{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;font:700 15px/1 ui-monospace,monospace;color:#d6f0ea;background:radial-gradient(circle at 35% 25%,#647f8f,#283746 55%,#151e27 56%);border:1px solid rgba(192,232,224,.2);box-shadow:0 0 18px rgba(105,183,174,.12)}
                .sar-module-shop__notice small{display:block;margin-bottom:4px;font:600 7px/1 ui-monospace,monospace;letter-spacing:.18em;color:rgba(155,213,204,.5)}.sar-module-shop__notice p{margin:0;font-size:10px;line-height:1.65;color:rgba(228,240,236,.65)}
                .sar-module-captured{display:grid;grid-template-columns:68px 1fr;gap:13px;align-items:center;min-height:92px;padding:10px 14px 10px 8px;border:1px solid rgba(163,222,212,.18);background:linear-gradient(110deg,rgba(88,171,158,.13),rgba(111,86,170,.08));clip-path:polygon(12px 0,100% 0,100% calc(100% - 12px),calc(100% - 12px) 100%,0 100%,0 12px)}.sar-module-captured__figure{height:72px;display:grid;place-items:end center;overflow:hidden}.sar-module-captured__figure img{max-width:62px;max-height:70px;object-fit:contain;filter:drop-shadow(0 5px 7px rgba(0,0,0,.5))}.sar-module-captured__fallback{width:48px;height:48px;border-radius:50%;display:grid;place-items:center;background:rgba(166,217,208,.1);color:#bfe5df}.sar-module-captured small{display:block;font:600 7px/1 ui-monospace,monospace;letter-spacing:.2em;color:rgba(156,218,208,.5)}.sar-module-captured h2{margin:6px 0 4px;font:500 17px/1.2 "Noto Serif SC",serif;letter-spacing:.08em}.sar-module-captured p{margin:0;font-size:9px;line-height:1.6;color:rgba(219,237,232,.52)}.sar-module-captured__state{margin-top:5px!important;color:rgba(238,208,157,.68)!important}
                .sar-module-shop__switch{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:14px;padding:3px;border:1px solid rgba(177,218,211,.1);background:rgba(2,8,11,.3)}
                .sar-module-shop__switch button{height:34px;border:0;background:transparent;color:rgba(218,236,231,.38);font-size:10px;letter-spacing:.06em}.sar-module-shop__switch button.is-active{color:#dff1ed;background:rgba(135,194,185,.11);box-shadow:inset 0 0 0 1px rgba(159,213,205,.1)}.sar-module-shop__switch span{display:inline-flex;align-items:center;gap:6px}.sar-module-shop__switch i{font-style:normal;min-width:16px;padding:2px 4px;border-radius:8px;background:rgba(255,255,255,.07);font:600 8px/1 ui-monospace,monospace}
                .sar-module-shop__rack-head{display:flex;align-items:end;justify-content:space-between;margin:18px 1px 10px}.sar-module-shop__rack-head small{display:block;font:500 7px/1 ui-monospace,monospace;letter-spacing:.26em;color:rgba(162,213,205,.45)}.sar-module-shop__rack-head h2{margin:5px 0 0;font:500 15px/1.2 "Noto Serif SC",serif;letter-spacing:.08em}.sar-module-shop__rack-date{font:500 8px/1 ui-monospace,monospace;color:rgba(210,233,228,.38)}
                .sar-module-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}
                .sar-module-card{--module-color:#a8d8d0;position:relative;min-height:196px;overflow:hidden;padding:10px 9px 0;text-align:left;color:#edf4f0;background:linear-gradient(155deg,rgba(31,46,50,.92),rgba(11,18,23,.96));border:1px solid color-mix(in srgb,var(--module-color) 28%,transparent);clip-path:polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px);box-shadow:inset 0 1px rgba(255,255,255,.03);animation:sar-module-arrive .3s both;animation-delay:calc(var(--card-order) * 35ms)}
                .sar-module-card:before{content:"";position:absolute;inset:0;pointer-events:none;background:radial-gradient(circle at 50% 39%,var(--module-glow),transparent 38%),linear-gradient(135deg,transparent 49.7%,color-mix(in srgb,var(--module-color) 8%,transparent) 50%,transparent 50.3%)}
                .sar-module-card:active{transform:scale(.975)}.sar-module-card__serial,.sar-module-card__kind{position:relative;z-index:1;font:500 6px/1 ui-monospace,monospace;letter-spacing:.12em;color:color-mix(in srgb,var(--module-color) 70%,transparent)}.sar-module-card__kind{position:absolute;right:8px;top:10px;text-align:right;color:rgba(220,236,232,.28)}
                .sar-module-glyph{--module-color:#a8d8d0;position:relative;width:66px;height:66px;margin:17px auto 12px;display:grid;place-items:center;border:1px solid color-mix(in srgb,var(--module-color) 45%,transparent);border-radius:20%;transform:rotate(45deg);background:radial-gradient(circle,var(--module-glow),transparent 66%);box-shadow:0 0 22px var(--module-glow),inset 0 0 13px rgba(0,0,0,.46)}
                .sar-module-glyph__orbit{position:absolute;inset:8px;border:1px dashed color-mix(in srgb,var(--module-color) 35%,transparent);border-radius:50%}.sar-module-glyph__core{transform:rotate(-45deg);font:400 25px/1 "Noto Serif SC",serif;color:var(--module-color);text-shadow:0 0 10px var(--module-color)}.sar-module-glyph__pin{position:absolute;width:4px;height:4px;border-radius:50%;background:var(--module-color);box-shadow:0 0 7px var(--module-color)}.sar-module-glyph__pin--a{top:7px;left:7px}.sar-module-glyph__pin--b{right:7px;bottom:7px}.sar-module-glyph.is-large{width:76px;height:76px;margin:4px 13px 4px 7px;flex:0 0 auto}.sar-module-glyph.is-large .sar-module-glyph__core{font-size:29px}
                .sar-module-card__copy{position:relative;z-index:1;text-align:center}.sar-module-card__title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:600 12px/1.3 "Noto Serif SC",serif;letter-spacing:.03em}.sar-module-card__effect{margin-top:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:8px;color:rgba(223,237,233,.42)}
                .sar-module-card__footer{position:absolute;z-index:1;inset:auto 0 0;display:flex;align-items:center;justify-content:space-between;height:31px;padding:0 9px;border-top:1px solid color-mix(in srgb,var(--module-color) 17%,transparent);background:rgba(0,0,0,.18);font:500 8px/1 ui-monospace,monospace;color:rgba(225,239,235,.5)}.sar-module-card__footer span:first-child{display:flex;align-items:center;gap:4px;color:var(--module-color)}
                .sar-module-empty{grid-column:1/-1;margin-top:18px;padding:46px 18px;text-align:center;border:1px dashed rgba(169,213,205,.14);color:rgba(222,237,233,.42)}.sar-module-empty svg{margin:0 auto 10px}.sar-module-empty h3{margin:0;font:500 13px/1.4 "Noto Serif SC",serif}.sar-module-empty p{margin:7px 0 0;font-size:9px;line-height:1.6}
                .sar-module-roll{position:fixed;z-index:5;left:14px;right:14px;bottom:calc(${SAFE_BOTTOM} + 12px);display:flex;align-items:center;gap:10px;padding:8px 9px 8px 13px;background:rgba(8,15,19,.92);border:1px solid rgba(170,216,208,.14);box-shadow:0 12px 30px rgba(0,0,0,.4);backdrop-filter:blur(14px);clip-path:polygon(9px 0,100% 0,100% calc(100% - 9px),calc(100% - 9px) 100%,0 100%,0 9px)}.sar-module-roll__copy{min-width:0;flex:1}.sar-module-roll__copy b{display:block;font-size:9px;font-weight:600;color:rgba(228,241,237,.7)}.sar-module-roll__copy span{display:block;margin-top:3px;font:400 7px/1 ui-monospace,monospace;color:rgba(193,222,216,.36)}.sar-module-roll button{height:35px;min-width:112px;display:flex;align-items:center;justify-content:center;gap:7px;border:1px solid rgba(168,220,211,.22);background:linear-gradient(105deg,rgba(82,143,137,.42),rgba(99,91,158,.35));color:#e6f4f0;font-size:10px}.sar-module-roll button:disabled{opacity:.35}.sar-module-roll button:active:not(:disabled){transform:scale(.97)}
                .sar-module-detail-backdrop{position:fixed;inset:0;z-index:10;display:flex;align-items:flex-end;background:rgba(0,0,0,.58);backdrop-filter:blur(4px);animation:sar-module-fade .18s both}.sar-module-detail{position:relative;width:100%;max-height:85%;overflow:auto;padding:18px 16px calc(${SAFE_BOTTOM} + 18px);background:linear-gradient(160deg,#172127,#0b1217 72%);border-top:1px solid color-mix(in srgb,var(--module-color) 35%,transparent);box-shadow:0 -18px 55px rgba(0,0,0,.62);animation:sar-module-sheet .28s cubic-bezier(.2,.85,.2,1) both}.sar-module-detail:before{content:"";position:absolute;inset:0 0 auto;height:135px;pointer-events:none;background:radial-gradient(circle at 18% 25%,var(--module-glow),transparent 42%)}.sar-module-detail__close{position:absolute;z-index:2;right:14px;top:14px;width:34px;height:34px;display:grid;place-items:center;border:1px solid rgba(220,238,233,.12);background:rgba(0,0,0,.2);color:rgba(231,242,239,.6)}.sar-module-detail__hero{position:relative;display:flex;align-items:center;padding-right:36px}.sar-module-detail__code{font:500 7px/1 ui-monospace,monospace;letter-spacing:.2em;color:var(--module-color)}.sar-module-detail h2{margin:7px 0 4px;font:500 21px/1.2 "Noto Serif SC",serif;letter-spacing:.06em}.sar-module-detail__hero p{margin:0;font-size:9px;color:rgba(224,239,235,.42)}.sar-module-detail__rule{height:1px;margin:15px 0;background:linear-gradient(90deg,var(--module-color),transparent);opacity:.26}.sar-module-detail__description{margin:0;font-size:11px;line-height:1.8;color:rgba(230,241,238,.7)}
                .sar-module-caian-note{display:grid;grid-template-columns:auto 1fr;gap:10px;margin-top:14px;padding:10px;background:rgba(255,255,255,.035);border-left:2px solid color-mix(in srgb,var(--module-color) 55%,transparent)}.sar-module-caian-note__avatar{width:29px;height:29px;border-radius:50%;display:grid;place-items:center;background:#273644;border:1px solid rgba(210,236,231,.14);font:700 11px/1 ui-monospace,monospace;color:#d9eee9}.sar-module-caian-note b{font-size:8px;letter-spacing:.1em;color:var(--module-color)}.sar-module-caian-note p{margin:4px 0 0;font-size:9px;line-height:1.65;color:rgba(230,242,239,.62)}
                .sar-module-example{margin-top:12px;padding:11px 12px;border:1px solid rgba(194,225,219,.09);background:rgba(0,0,0,.16)}.sar-module-example span{font:500 7px/1 ui-monospace,monospace;letter-spacing:.13em;color:rgba(173,217,209,.45)}.sar-module-example p{margin:7px 0 0;font:400 10px/1.75 "Noto Serif SC",serif;color:rgba(236,245,242,.76)}.sar-module-detail__tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:11px}.sar-module-detail__tags span{padding:4px 6px;border:1px solid rgba(177,216,209,.1);font-size:7px;color:rgba(211,232,227,.42)}
                .sar-module-buy{width:100%;height:45px;margin-top:15px;padding:0 13px;display:flex;align-items:center;justify-content:space-between;border:1px solid color-mix(in srgb,var(--module-color) 38%,transparent);background:linear-gradient(105deg,color-mix(in srgb,var(--module-color) 28%,#112027),rgba(102,86,155,.38));color:#f1f7f5;font-size:11px}.sar-module-buy span{display:flex;align-items:center;gap:7px}.sar-module-buy span:last-child{font:500 8px/1 ui-monospace,monospace;color:rgba(236,246,243,.62)}.sar-module-buy:active{transform:scale(.985)}.sar-module-detail__owned{text-align:center;margin-top:8px;font-size:7px;color:rgba(207,230,224,.34)}
                .sar-module-receipt{position:fixed;z-index:20;left:50%;top:44%;width:min(260px,75vw);transform:translate(-50%,-50%);padding:18px;text-align:center;background:rgba(11,22,26,.96);border:1px solid rgba(167,221,211,.28);box-shadow:0 18px 55px rgba(0,0,0,.58),0 0 32px rgba(94,183,170,.12);animation:sar-module-receipt .34s cubic-bezier(.2,.9,.25,1) both}.sar-module-receipt svg{color:#9bd7ce}.sar-module-receipt b{display:block;margin-top:8px;font:500 14px/1.3 "Noto Serif SC",serif}.sar-module-receipt p{margin:5px 0 0;font-size:9px;color:rgba(220,238,233,.48)}
                .sar-module-permission{display:flex;align-items:center;gap:10px;margin-top:8px;padding:10px 11px;border:1px solid rgba(171,216,209,.1);background:rgba(3,9,12,.26)}.sar-module-permission__copy{min-width:0;flex:1}.sar-module-permission__copy b{display:block;font-size:9px;color:rgba(229,242,238,.72)}.sar-module-permission__copy span{display:block;margin-top:3px;font-size:7px;line-height:1.5;color:rgba(207,230,224,.34)}.sar-module-permission button{position:relative;width:38px;height:21px;flex:0 0 auto;border-radius:20px;border:1px solid rgba(173,215,208,.18);background:rgba(255,255,255,.06)}.sar-module-permission button:after{content:"";position:absolute;top:3px;left:3px;width:13px;height:13px;border-radius:50%;background:#7a8d8a;transition:transform .2s,background .2s}.sar-module-permission button.is-on{background:rgba(88,173,160,.22);border-color:rgba(145,224,211,.34)}.sar-module-permission button.is-on:after{transform:translateX(17px);background:#a9e2d9;box-shadow:0 0 8px rgba(126,226,210,.5)}
                .sar-module-install{position:fixed;inset:0;z-index:30;display:grid;place-items:end center;background:rgba(1,6,9,.7);backdrop-filter:blur(7px);animation:sar-module-fade .18s both}.sar-module-install__sheet{width:100%;max-width:560px;max-height:88%;overflow:auto;padding:18px 16px calc(${SAFE_BOTTOM} + 18px);background:linear-gradient(165deg,#172329,#091116 78%);border-top:1px solid rgba(161,219,209,.25);box-shadow:0 -24px 70px rgba(0,0,0,.65);animation:sar-module-sheet .28s cubic-bezier(.2,.85,.2,1) both}.sar-module-install__head{display:flex;align-items:center;justify-content:space-between}.sar-module-install__head small{font:500 7px/1 ui-monospace,monospace;letter-spacing:.22em;color:rgba(152,213,203,.48)}.sar-module-install__head h2{margin:6px 0 0;font:500 19px/1.2 "Noto Serif SC",serif;letter-spacing:.08em}.sar-module-install__head button{width:34px;height:34px;display:grid;place-items:center;border:1px solid rgba(220,238,233,.12);color:#bed0cb;background:transparent}.sar-module-targets{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:16px}.sar-module-target{display:flex;align-items:center;gap:9px;min-width:0;padding:9px;text-align:left;border:1px solid rgba(170,216,208,.11);background:rgba(255,255,255,.025);color:rgba(228,241,237,.62)}.sar-module-target.is-selected{border-color:rgba(143,224,210,.38);background:rgba(88,173,160,.12);color:#eff8f5}.sar-module-target img,.sar-module-target__fallback{width:34px;height:34px;border-radius:50%;object-fit:cover;background:#26353a;display:grid;place-items:center;font-size:12px}.sar-module-target div{min-width:0}.sar-module-target b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px}.sar-module-target span{display:block;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:7px;color:rgba(201,225,220,.36)}.sar-module-install__empty{margin-top:16px;padding:26px 16px;text-align:center;border:1px dashed rgba(170,216,208,.14);font-size:10px;line-height:1.7;color:rgba(220,236,232,.48)}.sar-module-install__summary{margin-top:14px;padding:13px;border:1px solid rgba(169,219,210,.13);background:rgba(0,0,0,.18)}.sar-module-install__summary b{font:500 14px/1.3 "Noto Serif SC",serif}.sar-module-install__summary p{margin:7px 0 0;font-size:9px;line-height:1.7;color:rgba(220,237,233,.52)}.sar-module-install__warning{margin-top:9px;font-size:8px;line-height:1.6;color:rgba(227,199,152,.65)}.sar-module-install__actions{display:flex;gap:8px;margin-top:14px}.sar-module-loading>.sar-module-install__actions{width:min(260px,100%)}.sar-module-install__actions button{height:42px;flex:1;border:1px solid rgba(170,216,208,.14);background:rgba(255,255,255,.035);color:rgba(225,240,236,.58);font-size:10px}.sar-module-install__actions button:disabled{opacity:.28}.sar-module-install__actions button:last-child{background:linear-gradient(105deg,rgba(75,151,140,.55),rgba(96,84,157,.46));color:#f2f8f6;border-color:rgba(151,224,212,.28)}.sar-module-loading{min-height:330px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}.sar-module-loading__stage{position:relative;width:190px;height:150px;display:grid;place-items:center}.sar-module-loading__avatar{width:76px;height:76px;border-radius:50%;overflow:hidden;border:1px solid rgba(189,232,224,.35);background:#223138;box-shadow:0 0 0 16px rgba(100,200,184,.04),0 0 35px rgba(100,200,184,.18);animation:sar-module-target-approach .7s cubic-bezier(.2,.8,.2,1) both}.sar-module-loading__avatar img{width:100%;height:100%;object-fit:cover}.sar-module-loading__chip{position:absolute;width:32px;height:32px;display:grid;place-items:center;border:1px solid #a8ded5;background:#18302f;color:#c7f3eb;transform:rotate(45deg);animation:sar-module-chip-insert .9s cubic-bezier(.2,.8,.2,1) both}.sar-module-loading__chip span{transform:rotate(-45deg)}.sar-module-loading h3{margin:8px 0 0;font:500 16px/1.3 "Noto Serif SC",serif}.sar-module-loading p{margin:7px 0 0;font-size:9px;line-height:1.65;color:rgba(214,234,229,.47)}.sar-module-reverse{margin-top:14px;padding:10px 12px;border:1px solid rgba(185,157,230,.22);background:rgba(132,104,187,.09);font-size:9px;line-height:1.65;color:rgba(232,220,250,.72)}
                @keyframes sar-module-arrive{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}@keyframes sar-module-fade{from{opacity:0}to{opacity:1}}@keyframes sar-module-sheet{from{transform:translateY(28px);opacity:.6}to{transform:none;opacity:1}}@keyframes sar-module-receipt{0%{opacity:0;transform:translate(-50%,-44%) scale(.92)}55%{opacity:1;transform:translate(-50%,-50%) scale(1.02)}100%{opacity:1;transform:translate(-50%,-50%) scale(1)}}@keyframes sar-module-target-approach{0%{opacity:0;transform:translateX(-42px) scale(.86)}65%{opacity:1;transform:translateX(0) scale(1.03)}100%{transform:none}}@keyframes sar-module-chip-insert{0%{opacity:0;transform:translate(75px,-38px) rotate(45deg) scale(.7)}55%{opacity:1;transform:translate(28px,-8px) rotate(45deg) scale(1)}80%{transform:translate(18px,0) rotate(45deg) scale(.72)}100%{opacity:0;transform:translate(14px,0) rotate(45deg) scale(.35)}}
                @media (min-width:620px){.sar-module-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.sar-module-detail{left:50%;max-width:560px;transform:translateX(-50%);border-left:1px solid rgba(180,220,212,.12);border-right:1px solid rgba(180,220,212,.12)}@keyframes sar-module-sheet{from{transform:translate(-50%,28px);opacity:.6}to{transform:translate(-50%,0);opacity:1}}}
                @media (prefers-reduced-motion:reduce){.sar-module-card,.sar-module-detail-backdrop,.sar-module-detail,.sar-module-receipt,.sar-module-install,.sar-module-install__sheet,.sar-module-loading__avatar,.sar-module-loading__chip{animation:none!important}.sar-module-card:active,.sar-module-buy:active,.sar-module-roll button:active:not(:disabled){transform:none}}
            `}</style>
            <header className="sar-module-shop__header" style={{ paddingTop: `max(0px, calc(${SAFE_TOP} - 44px))`, height: `calc(58px + max(0px, calc(${SAFE_TOP} - 44px)))` }}>
                <button type="button" className="sar-module-shop__back" onClick={onClose} aria-label={capturedTarget ? '放开角色并返回' : '离开模块商店'}><CaretLeft size={18} /></button>
                <div className="sar-module-shop__title"><small>{capturedTarget ? 'SAR · FIELD LOADOUT' : 'SAR · MODULE COUNTER'}</small><h1>{capturedTarget ? '现场装载' : '模块商店'}</h1></div>
                <div className="sar-module-shop__currency">{capturedTarget ? ownedTotal : SAR_MODULE_SHOP_DEVELOPMENT_MODE ? '∞' : state.credits}<span>{capturedTarget ? '袋中模块' : '试运行票据'}</span></div>
            </header>
            <main className="sar-module-shop__body" style={{ top: `calc(58px + max(0px, calc(${SAFE_TOP} - 44px)))` }}>
                {capturedTarget && capturedChibi ? (
                    <div className="sar-module-captured">
                        <div className="sar-module-captured__figure">
                            {capturedChibi.img
                                ? <TokenImg value={capturedChibi.img} alt={capturedTarget.name} style={{ transform: `scaleX(${capturedChibi.flip ? -1 : 1}) translateY(${capturedChibi.offsetY}px)` }} />
                                : <span className="sar-module-captured__fallback"><UserCircle size={22} /></span>}
                        </div>
                        <div>
                            <small>CAPTURED FROM {capturedTarget.vrState?.currentRoom?.toUpperCase() || 'KANATA'}</small>
                            <h2>抓住了 {capturedTarget.name}</h2>
                            <p>TA 不必来到活动室。直接从模块袋挑一枚，在这里完成装载。</p>
                            {capturedTarget.vrState?.sarModule && <p className="sar-module-captured__state">当前已有「{capturedTarget.vrState.sarModule.moduleTitle}」，新模块会替换旧状态。</p>}
                        </div>
                    </div>
                ) : (
                    <>
                        <div className="sar-module-shop__notice">
                            {npcEnabled ? <span className="sar-module-shop__guide">C</span> : <Sparkle size={24} className="text-emerald-100/45" />}
                            <div>
                                <small>{npcEnabled ? 'CAIAN / COUNTER GUIDE' : 'MODULE COUNTER / NOTICE'}</small>
                                <p>{npcEnabled ? '今天只摆五枚！没看中可以重排三次。先买回去，再去彼方任何区域直接点那个小人装载。' : '每日随机提供 5 枚模块，可重排 3 次。买进模块袋后，在彼方任何区域点击角色小人即可装载。'}</p>
                            </div>
                        </div>
                        <div className="sar-module-permission">
                            <ShieldCheck size={19} weight={allowReverse ? 'fill' : 'regular'} color={allowReverse ? '#a9e2d9' : '#70827f'} />
                            <div className="sar-module-permission__copy">
                                <b>允许角色对我使用模块</b>
                                <span>默认关闭。开启后，仅当你和逛商店的角色同时身处 SAR 时可能触发；用户端持续 5 次成功互动。</span>
                            </div>
                            <button type="button" role="switch" aria-checked={allowReverse} aria-label="允许角色对我使用模块" className={allowReverse ? 'is-on' : ''} onClick={toggleReversePermission} />
                        </div>
                        <div className="sar-module-shop__switch" role="tablist" aria-label="商店视图">
                            <button type="button" role="tab" aria-selected={view === 'market'} className={view === 'market' ? 'is-active' : ''} onClick={() => setView('market')}><span><Sparkle size={13} />今日货架 <i>5</i></span></button>
                            <button type="button" role="tab" aria-selected={view === 'inventory'} className={view === 'inventory' ? 'is-active' : ''} onClick={() => setView('inventory')}><span><Package size={13} />模块袋 <i>{ownedTotal}</i></span></button>
                        </div>
                    </>
                )}
                <div className="sar-module-shop__rack-head">
                    <div><small>{capturedTarget ? 'SELECT FROM YOUR BAG' : view === 'market' ? 'DAILY ARRIVALS' : 'YOUR INVENTORY'}</small><h2>{capturedTarget ? `给 ${capturedTarget.name} 选模块` : view === 'market' ? '今日到货' : '已经领取的模块'}</h2></div>
                    <div className="sar-module-shop__rack-date">{capturedTarget ? `${ownedTotal} 枚` : state.market.dayKey.replaceAll('-', '.')}</div>
                </div>
                <div className="sar-module-grid">
                    {modules.map((module, index) => (
                        <ModuleCard key={module.id} module={module} index={index} owned={state.inventory[module.id] || 0} onOpen={() => setSelectedId(module.id)} />
                    ))}
                    {modules.length === 0 && (
                        <div className="sar-module-empty"><Package size={25} /><h3>模块袋还是空的</h3><p>{capturedTarget ? '先放开 TA，去 SAR 活动空间的模块商店领取一枚。' : '去今日货架领一枚吧。领取不会立即装载。'}</p></div>
                    )}
                </div>
            </main>
            {!capturedTarget && view === 'market' && (
                <div className="sar-module-roll">
                    <div className="sar-module-roll__copy"><b>今天还可重排 {state.market.rollsRemaining} 次</b><span>每日零点恢复，不影响已经购买的模块</span></div>
                    <button type="button" disabled={state.market.rollsRemaining <= 0} onClick={roll}><ArrowClockwise size={15} />重排货架 {state.market.rollsRemaining}/3</button>
                </div>
            )}
            {selected && (
                <ModuleDetail
                    module={selected}
                    owned={state.inventory[selected.id] || 0}
                    npcEnabled={npcEnabled}
                    onClose={() => setSelectedId(null)}
                    onPurchase={() => purchase(selected)}
                    inventoryMode={Boolean(capturedTarget) || view === 'inventory'}
                    onInstall={() => beginInstall(selected)}
                    targetName={capturedTarget?.name}
                />
            )}
            {receipt && (
                <div className="sar-module-receipt" role="status"><Check size={25} weight="bold" /><b>{receipt.title} 已封装</b><p>模块袋现有 {receipt.count} 枚</p></div>
            )}
            {installing && (
                <div className="sar-module-install" role="dialog" aria-modal="true" aria-label="装载模块">
                    <section className="sar-module-install__sheet">
                        {installPhase === 'loading' || installPhase === 'done' ? (
                            <div className="sar-module-loading" role="status">
                                <div className="sar-module-loading__stage">
                                    <div className="sar-module-loading__avatar">
                                        {installTargetChibi?.img
                                            ? <TokenImg value={installTargetChibi.img} alt={installTarget?.name || ''} style={{ objectFit: 'contain', transform: `scaleX(${installTargetChibi.flip ? -1 : 1})` }} />
                                            : <span className="sar-module-target__fallback">{installTarget?.name?.[0] || '?'}</span>}
                                    </div>
                                    {installPhase === 'loading' && <div className="sar-module-loading__chip"><span><MagicWand size={15} weight="fill" /></span></div>}
                                </div>
                                {installPhase === 'loading' ? (
                                    <>
                                        <h3>正在装载「{installing.title}」</h3>
                                        <p>{installTarget?.name} 正在接收临时表达协议。<br />真实意图与长期记忆不会被改写。</p>
                                    </>
                                ) : (
                                    <>
                                        <Check size={24} weight="bold" color="#a9e2d9" />
                                        <h3>装载完成</h3>
                                        <p>「{installing.title}」已交给 {installTarget?.name}。<br />接下来 10 次成功互动中，只有外显表达会被模块改写。</p>
                                        {reverseInstall && (
                                            <div className="sar-module-reverse">
                                                <b>{reverseInstall.charName} 趁机靠近了你。</b><br />
                                                对方为你装载了「{reverseInstall.moduleTitle}」；用户端持续 5 次成功互动。
                                            </div>
                                        )}
                                        <div className="sar-module-install__actions">
                                            <button type="button" onClick={capturedTarget ? onClose : closeInstall}>{capturedTarget ? '放回现场' : '返回模块袋'}</button>
                                        </div>
                                    </>
                                )}
                            </div>
                        ) : (
                            <>
                                <div className="sar-module-install__head">
                                    <div><small>MODULE INSTALLATION</small><h2>{installPhase === 'select' ? '选择装载对象' : '确认装载'}</h2></div>
                                    <button type="button" onClick={closeInstall} aria-label="取消装载"><X size={17} /></button>
                                </div>
                                <div className="sar-module-install__summary">
                                    <b>{installing.title}</b>
                                    <p>{installing.description}</p>
                                </div>
                                {installPhase === 'select' ? (
                                    <>
                                        {eligibleChars.length > 0 ? (
                                            <div className="sar-module-targets">
                                                {eligibleChars.map(character => (
                                                    <button
                                                        type="button"
                                                        key={character.id}
                                                        className={`sar-module-target ${installTargetId === character.id ? 'is-selected' : ''}`}
                                                        onClick={() => setInstallTargetId(character.id)}
                                                    >
                                                        {character.avatar
                                                            ? <TokenImg value={character.avatar} alt={character.name} />
                                                            : <span className="sar-module-target__fallback"><UserCircle size={18} /></span>}
                                                        <div><b>{character.name}</b><span>{character.vrState?.sarModule
                                                            ? `${character.vrState.sarModule.moduleTitle} · ${character.vrState.sarModule.phase === 'active' ? `余 ${character.vrState.sarModule.remainingTurns} 回合` : `稳定 ${character.vrState.sarModule.afterglowTurns}/3`}`
                                                            : character.vrState?.currentRoom === 'sar' ? '正在 SAR' : '已接入彼方'}</span></div>
                                                    </button>
                                                ))}
                                            </div>
                                        ) : (
                                            <div className="sar-module-install__empty">没有可装载的对象。<br />请先在彼方接入设置中开启至少一名角色。</div>
                                        )}
                                        <div className="sar-module-install__actions">
                                            <button type="button" onClick={closeInstall}>取消</button>
                                            <button type="button" disabled={!installTarget} onClick={() => setInstallPhase('confirm')}>继续</button>
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <div className="sar-module-install__summary">
                                            <b>{installTarget?.name}</b>
                                            <p>模块将在 Chat 与 Date 的下一次成功互动开始生效，共 10 回合；结束后保留 3 回合稳定提示。</p>
                                        </div>
                                        {installTarget?.vrState?.sarModule && <p className="sar-module-install__warning">该角色已有「{installTarget.vrState.sarModule.moduleTitle}」。继续将封存旧模块状态并替换。</p>}
                                        <div className="sar-module-install__actions">
                                            <button type="button" onClick={capturedTarget ? closeInstall : () => setInstallPhase('select')}>{capturedTarget ? '换个模块' : '返回选择'}</button>
                                            <button type="button" onClick={commitInstall}><MagicWand size={15} weight="fill" />确认装载</button>
                                        </div>
                                    </>
                                )}
                            </>
                        )}
                    </section>
                </div>
            )}
        </div>
    );
};
