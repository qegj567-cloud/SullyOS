/**
 * 麦当劳小程序 (Phase 1)
 *
 * 替代之前"LLM 驱动 MCP 工具"的脆弱链路, 改成纯按钮驱动的小程序壳:
 *   模式选 → 拉地址/门店 → 拉菜单 → 加购 → (Phase 2 算价/下单)
 *
 * 全程直接调 callMcdTool, 不经过 LLM, 不会有 productCode 幻觉 / orderType
 * 错配 / 券 code 误用 这些坑。
 *
 * char 想参与时, user 在菜单某条点 💭 把单品作为候选发到聊天, 复用之前的
 * mcd_card kind=candidate 流。char 看不到 mini-app 的整体状态 (那是 Phase 3
 * 才接, 会以 system prompt 注入"用户购物车有 X")。
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { callMcdTool, isMcdConfigured } from '../../utils/mcdMcpClient';
import { autoFixProposalCodesByName } from '../../utils/mcdToolBridge';
import { mcdItemEmoji } from '../../utils/mcdEmoji';
import type { McdCartItem } from '../chat/McdCard';
import TokenImg from '../os/TokenImg';

interface McdMiniAppProps {
    open: boolean;
    onClose: () => void;
    /** 角色信息, 用于显示头像/名字 (实际 LLM 调用在主聊天 pipeline) */
    char?: any;
    userProfile?: any;
    /** 主聊天的消息历史, 我们 filter fromMcdMiniApp:true 显示在小程序内 */
    messages?: any[];
    /** 主聊天是否正在生成中 (loading 指示) */
    isTyping?: boolean;
    /** 用户在小程序内输入 → 走主聊天 send pipeline (完整人设/记忆/日程上下文) */
    onSendMessage?: (text: string) => void | Promise<void>;
    /** 当前小程序状态变化时回调上去, 主聊天的 useChatAI 会读取并注入 system prompt */
    onStateChange?: (state: import('../../utils/mcdToolBridge').McdMiniAppSnapshot) => void;
    /** 用户最终敲定下单时调 (Phase 2 接 create-order) */
    onConfirmOrder?: (cart: CartLine[], context: OrderContext) => void;
}

interface CartLine {
    code: string;
    name: string;
    price?: string | number;
    qty: number;
}

interface OrderContext {
    orderType: 1 | 2;
    /** 业务类型: 1 到店自取 / 2 麦乐送。query-meals / calculate-price / create-order 现在都必填 (MCP v1.0.4) */
    beType?: 1 | 2;
    storeCode: string;
    storeName?: string;
    beCode?: string;
    addressId?: string;
    addressLabel?: string;
}

type Step = 'mode' | 'pick' | 'menu' | 'review' | 'success';

// ========== 通用 UI ==========

const fmtMoney = (v: any): string => {
    if (v == null) return '';
    const n = typeof v === 'string' ? parseFloat(v) : v;
    if (!isFinite(n)) return String(v);
    return `¥${n.toFixed(2)}`;
};

// 上游 calculate-price 返回的是分 (整数), 比如 2200 = ¥22.00; 而菜单的 currentPrice
// 是元字符串 (e.g. "55.5"), create-order 的 totalAmount 也是元字符串。这俩格式得分开。
const fmtFen = (v: any): string => {
    if (v == null) return '';
    const n = typeof v === 'string' ? parseFloat(v) : v;
    if (!isFinite(n)) return String(v);
    return `¥${(n / 100).toFixed(2)}`;
};

const Spinner: React.FC<{ label?: string }> = ({ label }) => (
    <div className="flex flex-col items-center justify-center py-12 gap-3 text-yellow-700">
        <div className="w-8 h-8 border-3 border-yellow-300 border-t-yellow-600 rounded-full animate-spin" />
        {label && <div className="text-[12px] text-yellow-700/70">{label}</div>}
    </div>
);

const ErrorBox: React.FC<{ msg: string; onRetry?: () => void }> = ({ msg, onRetry }) => (
    <div className="m-3 p-3 rounded-xl bg-red-50 border border-red-200 text-[12px] text-red-700 leading-relaxed">
        <div className="font-bold mb-1">😣 出错了</div>
        <div className="mb-2 whitespace-pre-wrap break-all">{msg}</div>
        {onRetry && (
            <button onClick={onRetry} className="px-3 py-1 bg-red-500 text-white rounded-lg text-[11px] font-bold active:scale-95">重试</button>
        )}
    </div>
);

// ========== Step 1: 选模式 ==========

const ModeStep: React.FC<{ onPick: (t: 1 | 2) => void }> = ({ onPick }) => (
    <div className="px-4 py-6 space-y-3">
        <div className="text-[20px] font-bold text-yellow-900 text-center mb-1">🍟 想怎么吃？</div>
        <div className="text-[12px] text-yellow-800/70 text-center mb-4">麦当劳官方 MCP · 点完会让 ta 给点意见</div>
        <button
            onClick={() => onPick(2)}
            className="w-full p-4 rounded-2xl bg-gradient-to-br from-yellow-300 to-amber-300 border-2 border-yellow-400 active:scale-[0.98] transition-transform text-left"
        >
            <div className="flex items-center gap-3">
                <span className="text-3xl">🛵</span>
                <div className="flex-1">
                    <div className="text-[15px] font-bold text-yellow-900">麦乐送外卖</div>
                    <div className="text-[11px] text-yellow-800/70 mt-0.5">从已存的收货地址里选一个</div>
                </div>
                <span className="text-yellow-700 text-xl">›</span>
            </div>
        </button>
        <button
            onClick={() => onPick(1)}
            className="w-full p-4 rounded-2xl bg-gradient-to-br from-amber-100 to-yellow-100 border-2 border-yellow-300 active:scale-[0.98] transition-transform text-left"
        >
            <div className="flex items-center gap-3">
                <span className="text-3xl">🏪</span>
                <div className="flex-1">
                    <div className="text-[15px] font-bold text-yellow-900">到店取餐 / 堂食</div>
                    <div className="text-[11px] text-yellow-800/70 mt-0.5">从收藏门店里选, 或附近搜索</div>
                </div>
                <span className="text-yellow-700 text-xl">›</span>
            </div>
        </button>
    </div>
);

// ========== Step 2: 选地址 / 门店 ==========

interface AddressItem { addressId: string; storeCode?: string; beCode?: string; fullAddress?: string; storeName?: string; phone?: string; contactName?: string; }
interface StoreItem { storeCode: string; beCode?: string; storeName: string; address?: string; distance?: any; }

const AddressStep: React.FC<{ orderType: 1 | 2; onPick: (ctx: OrderContext) => void; onBack: () => void }> = ({ orderType, onPick, onBack }) => {
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState<string | null>(null);
    const [addresses, setAddresses] = useState<AddressItem[]>([]);
    const [stores, setStores] = useState<StoreItem[]>([]);
    // 外送二级页: MCP v1.0.4 起 delivery-query-addresses 不再返回 storeCode/beCode,
    // 选完地址后必须再调 delivery-query-stores 拿可配送门店的 storeCode + beCode。
    const [pickedAddr, setPickedAddr] = useState<AddressItem | null>(null);
    const [deliveryStores, setDeliveryStores] = useState<StoreItem[]>([]);
    const [dsLoading, setDsLoading] = useState(false);
    const [dsErr, setDsErr] = useState<string | null>(null);

    const reload = async () => {
        setLoading(true); setErr(null);
        try {
            if (orderType === 2) {
                // 麦乐送 (beType=2)
                const r = await callMcdTool('delivery-query-addresses', { beType: 2 });
                if (!r.success) throw new Error(r.error || '拉取地址失败');
                const list = (r.data?.addresses || r.data || []) as AddressItem[];
                setAddresses(Array.isArray(list) ? list : []);
            } else {
                // 到店: 先查收藏门店 (searchType=1)
                const r = await callMcdTool('query-nearby-stores', { searchType: 1, beType: 1 });
                if (!r.success) throw new Error(r.error || '拉取门店失败');
                const list = (Array.isArray(r.data) ? r.data : (r.data?.stores || r.data?.list || [])) as StoreItem[];
                setStores(list || []);
            }
        } catch (e: any) {
            setErr(e?.message || String(e));
        } finally {
            setLoading(false);
        }
    };

    const finishDelivery = (addr: AddressItem, s: StoreItem) => {
        onPick({
            orderType: 2,
            beType: 2,
            storeCode: s.storeCode,
            beCode: s.beCode,
            addressId: addr.addressId,
            addressLabel: addr.fullAddress,
            storeName: s.storeName,
        });
    };

    // 外送: 选了一个地址 → 用 delivery-query-stores 拉这个地址可配送的门店
    const loadDeliveryStores = async (addr: AddressItem) => {
        setPickedAddr(addr);
        setDsLoading(true); setDsErr(null); setDeliveryStores([]);
        try {
            const r = await callMcdTool('delivery-query-stores', { addressId: addr.addressId, beType: 2 });
            if (!r.success) throw new Error(r.error || '拉取可配送门店失败');
            const list = (Array.isArray(r.data) ? r.data : (r.data?.stores || r.data?.list || [])) as StoreItem[];
            const arr = (list || []).filter((s: StoreItem) => s?.storeCode);
            setDeliveryStores(arr);
            // 只有一家可配送门店时直接进菜单, 省一次点击
            if (arr.length === 1) finishDelivery(addr, arr[0]);
        } catch (e: any) {
            setDsErr(e?.message || String(e));
        } finally {
            setDsLoading(false);
        }
    };

    useEffect(() => { reload(); /* eslint-disable-next-line */ }, [orderType]);

    if (loading) return <Spinner label={orderType === 2 ? '正在拉取你的收货地址...' : '正在拉取收藏门店...'} />;
    if (err) return <ErrorBox msg={err} onRetry={reload} />;

    // 外送二级页: 已选地址 → 展示该地址可配送门店列表
    if (orderType === 2 && pickedAddr) {
        return (
            <div className="px-3 py-3 space-y-2">
                <div className="flex items-center justify-between mb-1">
                    <button onClick={() => { setPickedAddr(null); setDeliveryStores([]); setDsErr(null); }} className="text-[12px] text-yellow-700 active:scale-95">‹ 换地址</button>
                    <div className="text-[13px] font-bold text-yellow-900">选配送门店</div>
                    <div className="w-12" />
                </div>
                <div className="text-[11px] text-slate-500 px-1 line-clamp-2">📍 {pickedAddr.fullAddress}</div>
                {dsLoading ? <Spinner label="正在查可配送门店..." />
                : dsErr ? <ErrorBox msg={dsErr} onRetry={() => loadDeliveryStores(pickedAddr)} />
                : deliveryStores.length === 0 ? (
                    <div className="text-center py-8 text-[12px] text-slate-500 leading-relaxed">
                        这个地址附近暂时没有可配送的门店。<br />换个地址试试。
                    </div>
                ) : deliveryStores.map((s: StoreItem) => (
                    <button
                        key={s.storeCode}
                        onClick={() => finishDelivery(pickedAddr, s)}
                        className="w-full p-3 rounded-xl bg-white border border-yellow-200 active:scale-[0.99] active:bg-yellow-50 transition text-left"
                    >
                        <div className="flex items-start gap-2">
                            <span className="text-xl shrink-0 mt-0.5">🏪</span>
                            <div className="flex-1 min-w-0">
                                <div className="font-bold text-[13px] text-slate-800 truncate">{s.storeName}</div>
                                {s.address && <div className="text-[11px] text-slate-600 line-clamp-2 leading-snug mt-0.5">{s.address}</div>}
                            </div>
                        </div>
                    </button>
                ))}
            </div>
        );
    }

    return (
        <div className="px-3 py-3 space-y-2">
            <div className="flex items-center justify-between mb-1">
                <button onClick={onBack} className="text-[12px] text-yellow-700 active:scale-95">‹ 换模式</button>
                <div className="text-[13px] font-bold text-yellow-900">{orderType === 2 ? '选收货地址' : '选门店'}</div>
                <div className="w-12" />
            </div>
            {orderType === 2 ? (
                addresses.length === 0 ? (
                    <div className="text-center py-8 text-[12px] text-slate-500">
                        还没有收货地址。请先在麦当劳 App 里添加。
                    </div>
                ) : addresses.map((a: AddressItem) => (
                    <button
                        key={a.addressId}
                        onClick={() => loadDeliveryStores(a)}
                        className="w-full p-3 rounded-xl bg-white border border-yellow-200 active:scale-[0.99] active:bg-yellow-50 transition text-left"
                    >
                        <div className="flex items-start gap-2">
                            <span className="text-xl shrink-0 mt-0.5">📍</span>
                            <div className="flex-1 min-w-0">
                                <div className="font-bold text-[13px] text-slate-800 truncate">
                                    {a.contactName || '收货人'}
                                    {a.phone && <span className="text-[10px] text-slate-500 font-normal ml-1.5">{a.phone}</span>}
                                </div>
                                <div className="text-[11px] text-slate-600 line-clamp-2 leading-snug mt-0.5">{a.fullAddress}</div>
                            </div>
                            <span className="text-yellow-700 text-sm shrink-0 mt-1">›</span>
                        </div>
                    </button>
                ))
            ) : (
                stores.length === 0 ? (
                    <div className="text-center py-8 text-[12px] text-slate-500 leading-relaxed">
                        没找到收藏门店。<br />请先在麦当劳 App 里收藏一家。
                    </div>
                ) : stores.map((s: StoreItem) => (
                    <button
                        key={s.storeCode}
                        onClick={() => onPick({
                            orderType: 1,
                            beType: 1,
                            storeCode: s.storeCode,
                            storeName: s.storeName,
                        })}
                        className="w-full p-3 rounded-xl bg-white border border-yellow-200 active:scale-[0.99] active:bg-yellow-50 transition text-left"
                    >
                        <div className="flex items-start gap-2">
                            <span className="text-xl shrink-0 mt-0.5">🏪</span>
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between gap-2">
                                    <div className="font-bold text-[13px] text-slate-800 truncate flex-1">{s.storeName}</div>
                                    {s.distance != null && (
                                        <div className="text-[10px] text-yellow-700 shrink-0">
                                            {typeof s.distance === 'number'
                                                ? (s.distance > 1000 ? (s.distance / 1000).toFixed(1) + 'km' : s.distance + 'm')
                                                : s.distance}
                                        </div>
                                    )}
                                </div>
                                {s.address && <div className="text-[11px] text-slate-600 line-clamp-2 leading-snug mt-0.5">{s.address}</div>}
                            </div>
                        </div>
                    </button>
                ))
            )}
        </div>
    );
};

// ========== Step 3: 浏览菜单 + 加购 ==========

interface MealsData {
    categories?: Array<{ name: string; meals?: Array<{ code: string; tags?: string[] }> }>;
    meals?: Record<string, { name: string; currentPrice?: string }>;
}

const MenuStep: React.FC<{
    ctx: OrderContext;
    cart: Map<string, CartLine>;
    onCart: (code: string, delta: number, item?: { name: string; price?: any }) => void;
    onMenuLoaded?: (data: MealsData) => void;
    onBack: () => void;
    onReview: () => void;
}> = ({ ctx, cart, onCart, onMenuLoaded, onBack, onReview }) => {
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState<string | null>(null);
    const [data, setData] = useState<MealsData | null>(null);
    const [activeCat, setActiveCat] = useState<number>(0);

    const reload = async () => {
        setLoading(true); setErr(null);
        try {
            const args: any = { storeCode: ctx.storeCode, orderType: ctx.orderType };
            if (ctx.beType) args.beType = ctx.beType;
            if (ctx.orderType === 2 && ctx.beCode) args.beCode = ctx.beCode;
            const r = await callMcdTool('query-meals', args);
            if (!r.success) throw new Error(r.error || '拉取菜单失败');
            const d = r.data || {};
            setData(d);
            onMenuLoaded?.(d);
        } catch (e: any) {
            setErr(e?.message || String(e));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { reload(); /* eslint-disable-next-line */ }, [ctx.storeCode, ctx.orderType, ctx.beCode, ctx.beType]);

    const cats = data?.categories || [];
    const mealMap = data?.meals || {};
    const cur = cats[activeCat];
    const items = (cur?.meals || []).map((m: any) => ({ code: m.code, ...mealMap[m.code], tags: m.tags })).filter((x: any) => x.name);

    const cartCount = (Array.from(cart.values()) as CartLine[]).reduce((s, l) => s + l.qty, 0);
    const cartTotal = (Array.from(cart.values()) as CartLine[]).reduce((s, l) => {
        const p = typeof l.price === 'string' ? parseFloat(l.price) : (typeof l.price === 'number' ? l.price : 0);
        return s + (isFinite(p) ? p * l.qty : 0);
    }, 0);

    if (loading) return <Spinner label="正在拉取菜单..." />;
    if (err) return <ErrorBox msg={err} onRetry={reload} />;

    return (
        <div className="flex flex-col h-full">
            <div className="flex items-center justify-between px-3 py-2 border-b border-yellow-200/60 bg-yellow-50/60">
                <button onClick={onBack} className="text-[12px] text-yellow-700 active:scale-95">‹ 换{ctx.orderType === 2 ? '地址' : '门店'}</button>
                <div className="text-[12px] font-bold text-yellow-900 truncate mx-2">
                    {ctx.storeName || ctx.storeCode}
                    <span className="text-[10px] text-yellow-700/60 font-normal ml-1.5">{ctx.orderType === 2 ? '外送' : '到店'}</span>
                </div>
                <div className="w-14" />
            </div>

            <div className="flex flex-1 min-h-0">
                {/* 左侧分类 */}
                <div className="w-20 shrink-0 overflow-y-auto mcd-scroll bg-yellow-50/40 border-r border-yellow-100">
                    {cats.map((c: any, i: number) => (
                        <button
                            key={i}
                            onClick={() => setActiveCat(i)}
                            className={`block w-full px-2 py-3 text-[11px] leading-snug border-l-2 transition ${
                                i === activeCat
                                    ? 'bg-white text-yellow-900 font-bold border-yellow-500'
                                    : 'text-slate-600 border-transparent active:bg-yellow-100'
                            }`}
                        >{c.name}</button>
                    ))}
                </div>

                {/* 右侧商品网格 */}
                <div className="flex-1 overflow-y-auto mcd-scroll p-2 space-y-2">
                    {items.length === 0
                        ? <div className="text-center py-8 text-[11px] text-slate-400">这个分类下没找到可售商品</div>
                        : items.map((it: any) => {
                            const inCart = cart.get(it.code);
                            const q = inCart?.qty || 0;
                            return (
                                <div key={it.code} className="flex gap-2 p-2 bg-white rounded-xl border border-yellow-100">
                                    <div className="w-14 h-14 rounded-lg bg-gradient-to-br from-yellow-50 to-amber-50 shrink-0 flex items-center justify-center text-3xl">
                                        {mcdItemEmoji(it.name)}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="font-bold text-[12px] text-slate-800 line-clamp-2 leading-snug">{it.name}</div>
                                        {it.tags && it.tags.length > 0 && (
                                            <div className="flex gap-1 mt-0.5 flex-wrap">
                                                {it.tags.slice(0, 2).map((t: string, j: number) => (
                                                    <span key={j} className="text-[9px] px-1 py-px rounded bg-red-100 text-red-600">{t}</span>
                                                ))}
                                            </div>
                                        )}
                                        <div className="flex items-center justify-between mt-1 gap-2">
                                            {it.currentPrice != null
                                                ? <div className="text-[12px] font-bold text-yellow-700">{fmtMoney(it.currentPrice)}</div>
                                                : <div className="flex-1" />}
                                            <div className="flex items-center gap-1 shrink-0">
                                                <div className="flex items-center bg-white border border-yellow-300 rounded-md overflow-hidden">
                                                    <button
                                                        onClick={() => onCart(it.code, -1)}
                                                        disabled={q <= 0}
                                                        className={`w-6 h-6 flex items-center justify-center text-[14px] font-bold ${q <= 0 ? 'text-slate-300' : 'text-yellow-700 active:bg-yellow-100'}`}
                                                    >−</button>
                                                    <span className="min-w-[20px] text-center text-[11px] font-bold text-slate-700">{q}</span>
                                                    <button
                                                        onClick={() => onCart(it.code, 1, { name: it.name, price: it.currentPrice })}
                                                        className="w-6 h-6 flex items-center justify-center text-[14px] font-bold text-yellow-700 active:bg-yellow-100"
                                                    >+</button>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                </div>
            </div>

            {/* 底部购物车浮条 */}
            {cartCount > 0 && (
                <div className="border-t border-yellow-300 bg-gradient-to-r from-yellow-100 to-amber-100 px-3 py-2.5 flex items-center gap-3">
                    <div className="text-2xl">🛒</div>
                    <div className="flex-1 min-w-0">
                        <div className="text-[10px] text-yellow-800/70">已选 {cartCount} 件</div>
                        {cartTotal > 0 && <div className="text-[15px] font-bold text-yellow-800">{fmtMoney(cartTotal)}</div>}
                    </div>
                    <button
                        onClick={onReview}
                        className="px-4 py-2 bg-yellow-600 text-white text-[12px] font-bold rounded-xl shadow active:scale-95"
                    >去结算 →</button>
                </div>
            )}
        </div>
    );
};

// ========== 子: 优惠券列表 (Review 步骤里展开) ==========

interface CouponProduct { productCode: string; productName: string; }
interface CouponEntry {
    couponId: string;
    couponCode: string;
    title?: string;
    tradeDateTime?: string;
    products?: CouponProduct[];
}

const CouponPicker: React.FC<{
    storeCode: string;
    beCode?: string;
    orderType: 1 | 2;
    beType?: 1 | 2;
    selected: Set<string>;
    onToggle: (c: CouponEntry) => void;
    onClose: () => void;
}> = ({ storeCode, beCode, orderType, beType, selected, onToggle, onClose }) => {
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState<string | null>(null);
    const [coupons, setCoupons] = useState<CouponEntry[]>([]);
    const [autoBinding, setAutoBinding] = useState(false);
    const [autoBindMsg, setAutoBindMsg] = useState<string | null>(null);

    const reload = async () => {
        setLoading(true); setErr(null);
        try {
            const args: any = { storeCode, orderType };
            if (beType) args.beType = beType;
            if (orderType === 2 && beCode) args.beCode = beCode;
            const r = await callMcdTool('query-store-coupons', args);
            if (!r.success) throw new Error(r.error || '拉取优惠券失败');
            const list = Array.isArray(r.data) ? r.data : (r.data?.coupons || r.data?.list || []);
            setCoupons(list || []);
        } catch (e: any) {
            setErr(e?.message || String(e));
        } finally {
            setLoading(false);
        }
    };

    const handleAutoBind = async () => {
        if (autoBinding) return;
        setAutoBinding(true); setAutoBindMsg(null);
        try {
            const r = await callMcdTool('auto-bind-coupons', {});
            if (!r.success) throw new Error(r.error || '一键领券失败');
            // r.data 是 markdown 文本, 解析"成功 X 张/失败 Y 张"出来给个 toast
            const txt = typeof r.data === 'string' ? r.data : (r.rawText || '');
            const okMatch = txt.match(/成功[^0-9]*(\d+)/);
            const failMatch = txt.match(/失败[^0-9]*(\d+)/);
            const successCount = okMatch ? parseInt(okMatch[1], 10) : 0;
            const failCount = failMatch ? parseInt(failMatch[1], 10) : 0;
            setAutoBindMsg(successCount > 0
                ? `🎉 领到 ${successCount} 张${failCount > 0 ? ` (${failCount} 张失败)` : ''}`
                : '没有可领的麦麦省券了');
            await reload();
        } catch (e: any) {
            setAutoBindMsg(`领取失败: ${e?.message || e}`);
        } finally {
            setAutoBinding(false);
            setTimeout(() => setAutoBindMsg(null), 4000);
        }
    };

    useEffect(() => { reload(); /* eslint-disable-next-line */ }, [storeCode, beCode, orderType, beType]);

    return (
        <div className="fixed inset-0 z-[60] bg-black/40 flex items-end justify-center" style={{ paddingBottom: 'var(--safe-bottom)' }} onClick={onClose}>
            <div
                className="bg-gradient-to-b from-yellow-50 to-amber-50 w-full sm:max-w-md rounded-t-2xl shadow-2xl flex flex-col"
                style={{ maxHeight: '70vh' }}
                onClick={(e: any) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between gap-2 px-4 py-3 bg-gradient-to-r from-yellow-400 to-amber-400 rounded-t-2xl shrink-0">
                    <div className="min-w-0">
                        <div className="text-[13px] font-bold text-yellow-900">🎟️ 选优惠券</div>
                        <div className="text-[10px] text-yellow-900/70">{coupons.length} 张可用 · 已选 {selected.size}</div>
                    </div>
                    <button
                        onClick={handleAutoBind}
                        disabled={autoBinding}
                        className="shrink-0 px-2.5 py-1.5 bg-white/80 rounded-full text-[10px] font-bold text-yellow-800 active:scale-95 disabled:opacity-50"
                    >{autoBinding ? '🎁 领中...' : '🎁 一键领麦麦省券'}</button>
                    <button onClick={onClose} className="shrink-0 w-8 h-8 rounded-full bg-white/40 flex items-center justify-center text-yellow-900 active:scale-90">✕</button>
                </div>
                {autoBindMsg && (
                    <div className="px-3 py-1.5 bg-emerald-50 border-b border-emerald-200 text-[11px] text-emerald-700 text-center">
                        {autoBindMsg}
                    </div>
                )}
                <div className="flex-1 overflow-y-auto mcd-scroll p-3 space-y-2 min-h-0">
                    {loading ? <Spinner label="拉取门店可用券..." />
                    : err ? <ErrorBox msg={err} onRetry={reload} />
                    : coupons.length === 0 ? (
                        <div className="text-center py-8 text-[12px] text-slate-500">这个门店当前没有可用的优惠券</div>
                    ) : coupons.map((c: CouponEntry, i: number) => {
                        const isOn = selected.has(c.couponId);
                        const products = c.products || [];
                        return (
                            <button
                                key={c.couponId || i}
                                onClick={() => onToggle(c)}
                                className={`w-full p-3 rounded-xl border-2 text-left transition active:scale-[0.99] ${isOn ? 'bg-yellow-100 border-yellow-500' : 'bg-white border-yellow-200'}`}
                            >
                                <div className="flex items-start gap-2">
                                    <span className="text-2xl shrink-0">🎟️</span>
                                    <div className="flex-1 min-w-0">
                                        <div className="font-bold text-[12px] text-slate-800 line-clamp-2">{c.title || '优惠券'}</div>
                                        {products.length > 0 && (
                                            <div className="text-[10px] text-slate-500 mt-0.5 line-clamp-1">
                                                适用: {products.map((p: CouponProduct) => p.productName).slice(0, 3).join('、')}
                                            </div>
                                        )}
                                        {c.tradeDateTime && <div className="text-[9px] text-slate-400 mt-0.5">{c.tradeDateTime}</div>}
                                    </div>
                                    <div className={`shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center text-[10px] font-bold ${isOn ? 'bg-yellow-500 border-yellow-500 text-white' : 'border-yellow-300 text-transparent'}`}>
                                        ✓
                                    </div>
                                </div>
                            </button>
                        );
                    })}
                </div>
                <div className="border-t border-yellow-300 bg-gradient-to-r from-yellow-100 to-amber-100 px-3 py-2.5">
                    <button onClick={onClose} className="w-full px-3 py-2 bg-yellow-600 text-white text-[12px] font-bold rounded-xl active:scale-95">完成</button>
                </div>
            </div>
        </div>
    );
};

// ========== Step 4: 确认订单 (auto calculate-price + 敲定 → create-order) ==========

interface PriceData {
    price?: number | string;
    productPrice?: number | string;
    productOriginalPrice?: number | string;
    deliveryPrice?: number | string;
    originalPrice?: number | string;
    discount?: number | string;
    productList?: Array<{ productCode: string; productName: string; quantity: number; subtotal: number; originalSubtotal?: number }>;
    takeWayList?: Array<{ takeWayCode?: string; code?: string }>;
}

const ReviewStep: React.FC<{
    ctx: OrderContext;
    cart: Map<string, CartLine>;
    onCart: (code: string, delta: number) => void;
    onBack: () => void;
    onOrderPlaced: (orderResult: any) => void;
}> = ({ ctx, cart, onCart, onBack, onOrderPlaced }) => {
    const lines = (Array.from(cart.values()) as CartLine[]);
    const localTotal = lines.reduce((s: number, l: CartLine) => {
        const p = typeof l.price === 'string' ? parseFloat(l.price) : (typeof l.price === 'number' ? l.price : 0);
        return s + (isFinite(p) ? p * l.qty : 0);
    }, 0);

    const [priceLoading, setPriceLoading] = useState(false);
    const [priceData, setPriceData] = useState<PriceData | null>(null);
    const [priceErr, setPriceErr] = useState<string | null>(null);
    const [orderLoading, setOrderLoading] = useState(false);
    const [orderErr, setOrderErr] = useState<string | null>(null);
    const [couponPickerOpen, setCouponPickerOpen] = useState(false);
    const [selectedCoupons, setSelectedCoupons] = useState<Map<string, CouponEntry>>(new Map());

    const cartHash = useMemo(() => lines.map((l: CartLine) => `${l.code}x${l.qty}`).sort().join('|'), [lines]);
    const couponsHash = useMemo(() => Array.from(selectedCoupons.keys()).sort().join('|'), [selectedCoupons]);

    const buildItemsForCalc = (): any[] => {
        const out: any[] = lines.map((l: CartLine) => ({ productCode: l.code, quantity: l.qty }));
        for (const c of (Array.from(selectedCoupons.values()) as CouponEntry[])) {
            const prod = c.products?.[0];
            if (!prod?.productCode) continue;
            out.push({ productCode: prod.productCode, quantity: 1, couponId: c.couponId, couponCode: c.couponCode });
        }
        return out;
    };

    useEffect(() => {
        if (!lines.length) { setPriceData(null); return; }
        let cancelled = false;
        setPriceLoading(true); setPriceErr(null);
        const args: any = {
            storeCode: ctx.storeCode,
            orderType: ctx.orderType,
            items: buildItemsForCalc(),
        };
        if (ctx.beType) args.beType = ctx.beType;
        if (ctx.orderType === 2 && ctx.beCode) args.beCode = ctx.beCode;
        callMcdTool('calculate-price', args).then((r: any) => {
            if (cancelled) return;
            if (!r.success) { setPriceErr(r.error || '算价失败'); setPriceData(null); }
            else setPriceData(r.data || {});
            setPriceLoading(false);
        }).catch((e: any) => {
            if (cancelled) return;
            setPriceErr(e?.message || String(e));
            setPriceLoading(false);
        });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cartHash, couponsHash, ctx.storeCode, ctx.orderType, ctx.beCode, ctx.beType]);

    const handleOrder = async () => {
        if (!lines.length) return;
        setOrderLoading(true); setOrderErr(null);
        const args: any = {
            storeCode: ctx.storeCode,
            orderType: ctx.orderType,
            items: buildItemsForCalc(),
        };
        if (ctx.beType) args.beType = ctx.beType;
        if (ctx.orderType === 2) {
            if (ctx.beCode) args.beCode = ctx.beCode;
            if (ctx.addressId) args.addressId = ctx.addressId;
        } else {
            const tw = priceData?.takeWayList?.[0];
            const takeWayCode = tw?.takeWayCode || tw?.code;
            if (takeWayCode) args.takeWayCode = takeWayCode;
        }
        try {
            const r = await callMcdTool('create-order', args);
            if (!r.success) throw new Error(r.error || '下单失败');
            onOrderPlaced(r.data);
        } catch (e: any) {
            setOrderErr(e?.message || String(e));
        } finally {
            setOrderLoading(false);
        }
    };

    const finalPrice = priceData?.price != null ? priceData.price : null;
    const productPrice = priceData?.productPrice;
    const deliveryPrice = priceData?.deliveryPrice;
    const originalPrice = priceData?.originalPrice;
    const discount = priceData?.discount;
    const showDiscount = discount != null && Number(discount) > 0;

    return (
        <div className="flex flex-col h-full">
            <div className="flex items-center justify-between px-3 py-2 border-b border-yellow-200/60 bg-yellow-50/60">
                <button onClick={onBack} className="text-[12px] text-yellow-700 active:scale-95">‹ 继续选</button>
                <div className="text-[13px] font-bold text-yellow-900">确认订单</div>
                <div className="w-12" />
            </div>
            <div className="flex-1 overflow-y-auto mcd-scroll p-3 space-y-2">
                <div className="text-[10px] text-yellow-700/70 font-bold uppercase">送达 / 取餐</div>
                <div className="bg-white rounded-xl border border-yellow-100 p-2.5 text-[12px] text-slate-700">
                    {ctx.orderType === 2
                        ? <>📍 <span className="text-slate-500">{ctx.storeName || '配送门店'} → </span>{ctx.addressLabel || ctx.addressId}</>
                        : <>🏪 {ctx.storeName || ctx.storeCode} (到店取餐)</>}
                </div>
                <div className="text-[10px] text-yellow-700/70 font-bold uppercase mt-2">商品</div>
                <div className="bg-white rounded-xl border border-yellow-100 overflow-hidden">
                    {lines.map((l: CartLine) => (
                        <div key={l.code} className="flex items-center gap-2 p-2 border-b border-yellow-50 last:border-b-0">
                            <span className="text-2xl shrink-0">{mcdItemEmoji(l.name)}</span>
                            <div className="flex-1 min-w-0">
                                <div className="font-bold text-[12px] text-slate-800 truncate">{l.name}</div>
                                {l.price != null && <div className="text-[10px] text-yellow-700">{fmtMoney(l.price)}</div>}
                            </div>
                            <div className="flex items-center bg-yellow-50 border border-yellow-200 rounded-md overflow-hidden shrink-0">
                                <button onClick={() => onCart(l.code, -1)} className="w-6 h-6 flex items-center justify-center text-[14px] font-bold text-yellow-700 active:bg-yellow-100">−</button>
                                <span className="min-w-[20px] text-center text-[11px] font-bold text-slate-700">{l.qty}</span>
                                <button onClick={() => onCart(l.code, 1)} className="w-6 h-6 flex items-center justify-center text-[14px] font-bold text-yellow-700 active:bg-yellow-100">+</button>
                            </div>
                        </div>
                    ))}
                </div>

                {/* 优惠券 */}
                <div className="text-[10px] text-yellow-700/70 font-bold uppercase mt-2">优惠券</div>
                <button
                    onClick={() => setCouponPickerOpen(true)}
                    className="w-full bg-white rounded-xl border border-yellow-200 p-2.5 flex items-center gap-2 active:scale-[0.99] active:bg-yellow-50"
                >
                    <span className="text-xl">🎟️</span>
                    <div className="flex-1 min-w-0 text-left">
                        {selectedCoupons.size === 0
                            ? <div className="text-[12px] text-slate-600">看看有什么券可以用</div>
                            : (
                                <div className="text-[11px] text-yellow-800 font-bold truncate">
                                    已选 {selectedCoupons.size} 张: {(Array.from(selectedCoupons.values()) as CouponEntry[]).map((c: CouponEntry) => c.title || '券').join(' / ')}
                                </div>
                            )}
                    </div>
                    <span className="text-yellow-700 text-sm shrink-0">›</span>
                </button>

                {/* 费用细分 (来自 calculate-price 真实结果) */}
                <div className="text-[10px] text-yellow-700/70 font-bold uppercase mt-2">费用</div>
                <div className="bg-white rounded-xl border border-yellow-100 p-3 text-[12px] text-slate-700 space-y-1.5">
                    {priceLoading ? (
                        <div className="flex items-center gap-2 py-1 text-slate-500">
                            <div className="w-3 h-3 border-2 border-yellow-300 border-t-yellow-600 rounded-full animate-spin" />
                            <span className="text-[11px]">算价中...</span>
                        </div>
                    ) : priceErr ? (
                        <div className="text-[11px] text-red-600 leading-relaxed whitespace-pre-wrap break-all">{priceErr}</div>
                    ) : priceData ? (
                        <>
                            {productPrice != null && (
                                <div className="flex justify-between"><span className="text-slate-500">商品小计</span><span>{fmtFen(productPrice)}</span></div>
                            )}
                            {deliveryPrice != null && Number(deliveryPrice) > 0 && (
                                <div className="flex justify-between"><span className="text-slate-500">配送费</span><span>{fmtFen(deliveryPrice)}</span></div>
                            )}
                            {showDiscount && (
                                <div className="flex justify-between text-emerald-600"><span>优惠</span><span>-{fmtFen(discount)}</span></div>
                            )}
                            {originalPrice != null && finalPrice != null && Number(originalPrice) !== Number(finalPrice) && (
                                <div className="flex justify-between text-[10px] text-slate-400"><span>原价</span><span className="line-through">{fmtFen(originalPrice)}</span></div>
                            )}
                        </>
                    ) : (
                        <div className="text-[11px] text-slate-500">购物车为空</div>
                    )}
                </div>

                {orderErr && (
                    <div className="rounded-xl bg-red-50 border border-red-200 p-2.5 text-[11px] text-red-700 leading-relaxed whitespace-pre-wrap break-all">
                        <div className="font-bold mb-0.5">下单失败</div>
                        {orderErr}
                    </div>
                )}
            </div>
            <div className="border-t border-yellow-300 bg-gradient-to-r from-yellow-100 to-amber-100 px-3 py-2.5 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                    <div className="text-[10px] text-yellow-800/70">合计</div>
                    <div className="text-[17px] font-bold text-yellow-800">
                        {priceLoading ? '...' : (finalPrice != null ? fmtFen(finalPrice) : (localTotal > 0 ? fmtMoney(localTotal) : '—'))}
                    </div>
                </div>
                <button
                    onClick={handleOrder}
                    disabled={lines.length === 0 || priceLoading || !!priceErr || orderLoading}
                    className="px-5 py-2.5 bg-yellow-600 text-white text-[13px] font-bold rounded-xl shadow active:scale-95 disabled:opacity-40 disabled:active:scale-100"
                >{orderLoading ? '下单中...' : '敲定 →'}</button>
            </div>
            {couponPickerOpen && (
                <CouponPicker
                    storeCode={ctx.storeCode}
                    beCode={ctx.beCode}
                    orderType={ctx.orderType}
                    beType={ctx.beType}
                    selected={new Set(selectedCoupons.keys())}
                    onToggle={(c: CouponEntry) => {
                        setSelectedCoupons((prev: Map<string, CouponEntry>) => {
                            const next = new Map<string, CouponEntry>(prev);
                            if (next.has(c.couponId)) next.delete(c.couponId);
                            else next.set(c.couponId, c);
                            return next;
                        });
                    }}
                    onClose={() => setCouponPickerOpen(false)}
                />
            )}
        </div>
    );
};

// ========== Step 5: 下单成功 ==========

const SuccessStep: React.FC<{
    orderResult: any;
    onClose: () => void;
}> = ({ orderResult, onClose }) => {
    const orderId: string | undefined = orderResult?.orderId;
    const payH5Url: string | undefined = orderResult?.payH5Url;
    const detail: any = orderResult?.orderDetail || {};
    return (
        <div className="flex flex-col h-full">
            <div className="flex-1 overflow-y-auto mcd-scroll p-4 space-y-3">
                <div className="text-center py-3">
                    <div className="text-5xl mb-2">🎉</div>
                    <div className="text-[16px] font-bold text-yellow-900">下单成功！</div>
                    <div className="text-[11px] text-yellow-700/70 mt-1">订单已创建, 等待支付</div>
                </div>
                <div className="bg-white rounded-xl border border-yellow-100 p-3 space-y-2 text-[12px] text-slate-700">
                    {orderId && (
                        <div>
                            <div className="text-[10px] text-slate-400">订单号</div>
                            <div className="font-mono text-[11px] break-all">{orderId}</div>
                        </div>
                    )}
                    {detail.storeName && (
                        <div>
                            <div className="text-[10px] text-slate-400">门店</div>
                            <div>{detail.storeName}</div>
                        </div>
                    )}
                    {detail.realTotalAmount != null && (
                        <div>
                            <div className="text-[10px] text-slate-400">实付</div>
                            <div className="font-bold text-yellow-700">{fmtMoney(detail.realTotalAmount)}</div>
                        </div>
                    )}
                    {Array.isArray(detail.orderProductList) && detail.orderProductList.length > 0 && (
                        <div>
                            <div className="text-[10px] text-slate-400 mb-1">商品</div>
                            {detail.orderProductList.map((p: any, i: number) => (
                                <div key={i} className="flex items-center gap-1.5 text-[11px]">
                                    <span>{mcdItemEmoji(p.productName)}</span>
                                    <span className="truncate">{p.productName}</span>
                                    <span className="text-slate-400 shrink-0">×{p.quantity}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
            <div className="border-t border-yellow-300 bg-gradient-to-r from-yellow-100 to-amber-100 px-3 py-2.5 flex items-center gap-2">
                {payH5Url && (
                    <a href={payH5Url} target="_blank" rel="noreferrer"
                        className="flex-1 text-center px-3 py-2.5 bg-yellow-600 text-white text-[12px] font-bold rounded-xl shadow active:scale-95"
                    >去支付 →</a>
                )}
                <button
                    onClick={onClose}
                    className={`${payH5Url ? 'shrink-0' : 'flex-1'} px-3 py-2.5 bg-white border border-yellow-300 text-yellow-800 text-[12px] font-bold rounded-xl active:scale-95`}
                >完成</button>
            </div>
        </div>
    );
};

// ========== 协同聊天面板 (modal 内嵌) ==========
//
// 不再自己 build prompt / 自己 fetch。
// 用户输入 → onSendMessage → 主聊天 handleSendText pipeline (完整人设/
// 记忆/日程/情绪上下文) + useChatAI 会从 mcdMiniAppRef 读当前状态注入。
// 显示来自主聊天 messages 数组, filter fromMcdMiniApp:true 拿到 in-app
// 那部分对话。

interface McdProposalItem { code: string; name: string; qty: number; reason?: string; }
interface McdProposalPayload { items: McdProposalItem[]; overall_note?: string; }
interface McdChatViewMsg {
    role: 'user' | 'assistant';
    content: string;
    ts: number;
    /** 'text' / 'emoji'; emoji 时 content 是图片 url */
    type?: string;
    /** char 调 propose_cart_items 后挂这里, 渲染成 + 加按钮卡片 */
    proposal?: McdProposalPayload;
}

const ProposalCard: React.FC<{
    payload: McdProposalPayload;
    onAddItem: (it: McdProposalItem) => void;
    onAddAll: (items: McdProposalItem[]) => void;
}> = ({ payload, onAddItem, onAddAll }) => {
    const [added, setAdded] = useState<Set<string>>(new Set());
    const handle = (it: McdProposalItem) => {
        onAddItem(it);
        setAdded((prev: Set<string>) => { const n = new Set(prev); n.add(it.code); return n; });
    };
    const handleAll = () => {
        onAddAll(payload.items);
        setAdded(new Set(payload.items.map((i: McdProposalItem) => i.code)));
    };
    return (
        <div className="bg-gradient-to-br from-yellow-50 to-amber-50 border border-yellow-300 rounded-2xl overflow-hidden">
            <div className="px-2.5 py-1.5 bg-yellow-200/60 border-b border-yellow-300/60 flex items-center justify-between">
                <span className="text-[10px] font-bold text-yellow-900">📋 这些怎么样？</span>
                <button onClick={handleAll} className="text-[10px] px-2 py-0.5 bg-yellow-500 text-white rounded-full font-bold active:scale-95">全部加</button>
            </div>
            {payload.overall_note && (
                <div className="px-2.5 py-1.5 text-[11px] text-slate-600 italic border-b border-yellow-200/60">{payload.overall_note}</div>
            )}
            <div className="divide-y divide-yellow-200/60">
                {payload.items.map((it: McdProposalItem, i: number) => {
                    const isAdded = added.has(it.code);
                    return (
                        <div key={i} className="flex items-center gap-2 px-2.5 py-2">
                            <span className="text-2xl shrink-0">{mcdItemEmoji(it.name)}</span>
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5">
                                    <span className="font-bold text-[12px] text-slate-800 truncate">{it.name}</span>
                                    <span className="text-[10px] text-yellow-700 shrink-0">×{it.qty}</span>
                                </div>
                                {it.reason && <div className="text-[10px] text-slate-500 leading-snug truncate">{it.reason}</div>}
                            </div>
                            <button
                                onClick={() => handle(it)}
                                disabled={isAdded}
                                className={`shrink-0 px-2 py-1 rounded-md text-[10px] font-bold active:scale-95 ${isAdded ? 'bg-emerald-100 text-emerald-700' : 'bg-white border border-yellow-400 text-yellow-700'}`}
                            >{isAdded ? '✓ 已加' : '+ 加'}</button>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

const InAppChat: React.FC<{
    char: any;
    visibleMessages: McdChatViewMsg[];
    isTyping: boolean;
    onSendMessage?: (text: string) => void | Promise<void>;
    onAddCartFromProposal?: (it: McdProposalItem) => void;
    onAddAllFromProposal?: (items: McdProposalItem[]) => void;
}> = ({ char, visibleMessages, isTyping, onSendMessage, onAddCartFromProposal, onAddAllFromProposal }) => {
    const [expanded, setExpanded] = useState(false);
    const [input, setInput] = useState('');
    const scrollRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [visibleMessages, isTyping, expanded]);

    const send = () => {
        const text = input.trim();
        if (!text || !onSendMessage) return;
        setInput('');
        setExpanded(true);
        onSendMessage(text);
    };

    const lastChar = [...visibleMessages].reverse().find((m: McdChatViewMsg) => m.role === 'assistant');
    const charAvatar = char?.avatar;
    const charName = char?.name || 'TA';

    return (
        <div className="border-t-2 border-yellow-300/60 bg-gradient-to-b from-yellow-100/60 to-amber-50 shrink-0 flex flex-col" style={{ maxHeight: expanded ? '50%' : 'calc(52px + var(--safe-bottom, 0px))' }}>
            {/* 折叠条 / 展开切换 */}
            <button
                onClick={() => setExpanded((v: boolean) => !v)}
                className="flex items-center gap-2 px-3 py-2 bg-yellow-100/80 active:bg-yellow-200/60 transition border-b border-yellow-200/60"
                style={!expanded ? { paddingBottom: 'calc(0.5rem + var(--safe-bottom, 0px))' } : undefined}
            >
                <div className="w-7 h-7 rounded-full bg-yellow-300 overflow-hidden shrink-0 flex items-center justify-center text-sm">
                    {charAvatar ? <TokenImg value={charAvatar} alt="" className="w-full h-full object-cover" /> : '🐾'}
                </div>
                <div className="flex-1 min-w-0 text-left">
                    {!expanded && lastChar
                        ? <div className="text-[11px] text-slate-700 truncate"><span className="text-yellow-700 font-bold">{charName}: </span>{lastChar.content}</div>
                        : <div className="text-[11px] font-bold text-yellow-900">跟 {charName} 一起选 · {expanded ? '点这里收起' : '点这里展开聊'}</div>}
                </div>
                <span className="text-yellow-700 text-xs shrink-0">{expanded ? '▼' : '▲'}</span>
            </button>

            {expanded && (
                <>
                    <div ref={scrollRef} className="flex-1 overflow-y-auto mcd-scroll px-3 py-2 space-y-2 min-h-0">
                        {visibleMessages.length === 0 && (
                            <div className="text-center py-4 text-[11px] text-slate-500 leading-relaxed">
                                可以这样问 {charName}:<br />
                                <span className="text-yellow-700">"帮我挑个 800 大卡以内的"</span><br />
                                <span className="text-yellow-700">"我已经选了这些, 你看怎么样"</span><br />
                                <span className="text-yellow-700">"今天想吃辣的"</span>
                            </div>
                        )}
                        {visibleMessages.map((m: McdChatViewMsg, i: number) => (
                            <div key={i} className={`flex gap-1.5 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                {m.role === 'assistant' && (
                                    <div className="w-6 h-6 rounded-full bg-yellow-300 overflow-hidden shrink-0 flex items-center justify-center text-xs mt-0.5">
                                        {charAvatar ? <TokenImg value={charAvatar} alt="" className="w-full h-full object-cover" /> : '🐾'}
                                    </div>
                                )}
                                <div className="max-w-[80%] flex flex-col gap-1 min-w-0">
                                    {m.proposal ? (
                                        <ProposalCard
                                            payload={m.proposal}
                                            onAddItem={(it: McdProposalItem) => onAddCartFromProposal?.(it)}
                                            onAddAll={(items: McdProposalItem[]) => onAddAllFromProposal?.(items)}
                                        />
                                    ) : m.type === 'emoji' ? (
                                        <TokenImg
                                            value={m.content}
                                            alt="表情"
                                            className="w-20 h-20 sm:w-24 sm:h-24 object-contain rounded-lg bg-white/40 p-1"
                                            loading="lazy"
                                            referrerPolicy="no-referrer"
                                            onError={(e: any) => { e.target.style.display = 'none'; }}
                                        />
                                    ) : (
                                        <div className={`px-2.5 py-1.5 rounded-2xl text-[12px] leading-relaxed whitespace-pre-wrap break-words ${
                                            m.role === 'user'
                                                ? 'bg-yellow-500 text-white rounded-br-sm'
                                                : 'bg-white border border-yellow-200 text-slate-800 rounded-bl-sm'
                                        }`}>
                                            {m.content}
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))}
                        {isTyping && (
                            <div className="flex gap-1.5 justify-start">
                                <div className="w-6 h-6 rounded-full bg-yellow-300 overflow-hidden shrink-0 flex items-center justify-center text-xs">
                                    {charAvatar ? <TokenImg value={charAvatar} alt="" className="w-full h-full object-cover" /> : '🐾'}
                                </div>
                                <div className="px-2.5 py-1.5 rounded-2xl bg-white border border-yellow-200">
                                    <span className="inline-flex gap-0.5">
                                        <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 animate-bounce" style={{ animationDelay: '0ms' }} />
                                        <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 animate-bounce" style={{ animationDelay: '150ms' }} />
                                        <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 animate-bounce" style={{ animationDelay: '300ms' }} />
                                    </span>
                                </div>
                            </div>
                        )}
                    </div>
                    <div className="border-t border-yellow-200/60 p-2 flex items-end gap-2 bg-white" style={{ paddingBottom: 'calc(0.5rem + var(--safe-bottom, 0px))' }}>
                        <textarea
                            value={input}
                            onChange={(e: any) => setInput(e.target.value)}
                            onKeyDown={(e: any) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    send();
                                }
                            }}
                            placeholder={`问问 ${charName}...`}
                            rows={1}
                            className="flex-1 resize-none bg-yellow-50/60 border border-yellow-200 rounded-xl px-3 py-1.5 text-[12px] text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-yellow-400 max-h-20"
                        />
                        <button
                            onClick={send}
                            disabled={!input.trim() || isTyping}
                            className="px-3 py-1.5 bg-yellow-500 text-white text-[12px] font-bold rounded-xl shadow active:scale-95 disabled:opacity-40 shrink-0"
                        >发送</button>
                    </div>
                </>
            )}
        </div>
    );
};

// ========== 主组件 ==========

const McdMiniApp: React.FC<McdMiniAppProps> = ({ open, onClose, char, userProfile, messages, isTyping, onSendMessage, onStateChange, onConfirmOrder }) => {
    const [step, setStep] = useState<Step>('mode');
    const [orderType, setOrderType] = useState<1 | 2 | null>(null);
    const [ctx, setCtx] = useState<OrderContext | null>(null);
    const [cart, setCart] = useState<Map<string, CartLine>>(new Map());
    const [menuData, setMenuData] = useState<MealsData | null>(null);
    const [nutritionData, setNutritionData] = useState<string>('');
    const [orderResult, setOrderResult] = useState<any>(null);

    useEffect(() => {
        if (open) {
            // 重新打开时重置
            setStep('mode');
            setOrderType(null);
            setCtx(null);
            setCart(new Map());
            setMenuData(null);
            setOrderResult(null);
            // 营养表全量, 一次性拉, 给 char 选品时参考
            if (!nutritionData) {
                callMcdTool('list-nutrition-foods', {}).then((r: any) => {
                    if (r?.success) {
                        if (typeof r.data === 'string') setNutritionData(r.data);
                        else if (typeof r.rawText === 'string') setNutritionData(r.rawText);
                    }
                }).catch(() => { /* 没拉到也不阻塞主流程 */ });
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    // 菜单加载/切换后, 把购物车里"当前不在售的 code"清掉:
    // 1) 换了门店/取餐方式 → 旧店 code 残留 → calculate-price 一直空
    // 2) 跨过 daypart (例如 5am 从夜宵 → 早餐) → 旧时段 code 不在新 categories[] 里 → 同样会被拒
    // 用 categories[].meals[] 的 code 集合作为"当下可下单"权威集; 没有 categories 时回退到全量 meals 字典
    useEffect(() => {
        const meals = menuData?.meals;
        if (!meals || !Object.keys(meals).length) return;
        let activeCodes: Set<string> | null = null;
        if (Array.isArray(menuData?.categories) && menuData.categories.length) {
            const s = new Set<string>();
            for (const cat of menuData.categories) {
                for (const m of (cat?.meals || [])) {
                    if (m?.code) s.add(String(m.code));
                }
            }
            if (s.size > 0) activeCodes = s;
        }
        setCart((prev: Map<string, CartLine>) => {
            let dirty = false;
            const next = new Map<string, CartLine>();
            for (const [code, line] of prev) {
                const orderable = activeCodes ? activeCodes.has(code) : !!meals[code];
                if (orderable) next.set(code, line);
                else { dirty = true; console.warn(`🍔 [MCD-MiniApp] 购物车清掉当前不在售的 code: ${code} (${line.name})`); }
            }
            return dirty ? next : prev;
        });
    }, [menuData]);

    // 每次状态变化推给父组件 → useChatAI 注入到 system prompt 末尾
    useEffect(() => {
        if (!onStateChange) return;
        const cartArr: Array<{ code: string; name: string; price?: any; qty: number }> = (Array.from(cart.values()) as CartLine[]).map((l: CartLine) => ({
            code: l.code, name: l.name, price: l.price, qty: l.qty,
        }));
        // 只把"当前 daypart 真正在售"的 code 推给 AI 上下文。
        // query-meals 的 data.meals 是跨 daypart 的扁平字典 (午餐 + 夜宵 + 麦满分早餐 全在里面),
        // 但只有 categories[].meals[] 里出现过的 code 是当下时段实际可下单的。
        // 不过滤 → AI 在凌晨 2 点会推"吉士汉堡中套餐"这种白天才有的, calculate-price 一定空。
        const fullMeals = menuData?.meals;
        let menuMealsForAI: typeof fullMeals = fullMeals;
        if (fullMeals && Array.isArray(menuData?.categories) && menuData.categories.length) {
            const activeCodes = new Set<string>();
            for (const cat of menuData.categories) {
                for (const m of (cat?.meals || [])) {
                    if (m?.code) activeCodes.add(String(m.code));
                }
            }
            if (activeCodes.size > 0) {
                const filtered: NonNullable<MealsData['meals']> = {};
                for (const code of activeCodes) {
                    if (fullMeals[code]) filtered[code] = fullMeals[code];
                }
                menuMealsForAI = filtered;
            }
        }
        onStateChange({
            open,
            step,
            orderType: ctx?.orderType ?? (orderType || undefined),
            storeCode: ctx?.storeCode,
            storeName: ctx?.storeName,
            addressLabel: ctx?.addressLabel,
            cart: cartArr,
            menuMeals: menuMealsForAI,
            nutritionData,
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, step, orderType, ctx, cart, menuData, nutritionData]);

    // modal 关闭时显式清掉 (open=false 通知父侧)
    useEffect(() => {
        if (!open && onStateChange) {
            onStateChange({ open: false });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    // 从主聊天历史里筛出"小程序内"的轮次, 按时间排序后渲染到底部聊天面板
    const visibleChatMessages = useMemo<McdChatViewMsg[]>(() => {
        if (!Array.isArray(messages)) return [];
        const out: McdChatViewMsg[] = [];
        for (const m of messages) {
            if (!m?.metadata?.fromMcdMiniApp) continue;
            // proposal 卡片 (mcd_card kind=proposal)
            if (m.type === 'mcd_card' && m.metadata?.mcdCardKind === 'proposal' && m.metadata?.mcdProposal) {
                out.push({
                    role: 'assistant',
                    content: '',
                    ts: m.timestamp || 0,
                    proposal: m.metadata.mcdProposal,
                });
                continue;
            }
            if (m.role !== 'user' && m.role !== 'assistant') continue;
            if (typeof m.content !== 'string' || !m.content.trim()) continue;
            // emoji/sticker: content 是图片 url, 渲染成 <img>; type 信息保留下来
            out.push({ role: m.role, content: m.content, ts: m.timestamp || 0, type: m.type || 'text' });
        }
        return out;
    }, [messages]);

    // 提案卡片 + 加 / 全部加 按钮 → 往购物车里塞 (从菜单里拿真实价格)
    // 严格模式: code 必须在当前门店菜单里存在, 否则拒绝加购 (calculate-price 也会拒)。
    // 客户端兜底再做一次名字匹配, 万一服务端 (useChatAI) 里那道修没生效也不至于把烂 code 塞进购物车。
    const handleAddFromProposal = (it: McdProposalItem) => {
        if (!it?.code && !it?.name) return;
        if (!menuData?.meals || !Object.keys(menuData.meals).length) {
            console.warn('🍔 [MCD-MiniApp] 拒绝加购: 当前菜单还没加载, 不能从 proposal 加购');
            return;
        }
        let realCode: string | undefined = menuData.meals[it.code || ''] ? it.code : undefined;
        let meal = realCode ? menuData.meals[realCode] : undefined;
        if (!meal) {
            // 服务端没修上 / propose 直接漏了 code 校准: 在这儿按 name 兜底
            const { fixed, fixes } = autoFixProposalCodesByName([it], menuData.meals);
            const fixedCode = fixed[0]?.code;
            if (fixes.length && fixedCode && menuData.meals[fixedCode]) {
                realCode = fixedCode;
                meal = menuData.meals[fixedCode];
                console.log(`🍔 [MCD-MiniApp] 客户端兜底修 code: '${it.code}' → '${realCode}' (${fixes[0].name})`);
            }
        }
        if (!realCode || !meal) {
            console.warn(`🍔 [MCD-MiniApp] 拒绝加购: code='${it.code}' name='${it.name}' 在当前门店菜单里找不到匹配`);
            return;
        }
        const price = meal.currentPrice;
        const name = meal.name || it.name;
        for (let i = 0; i < (it.qty || 1); i++) {
            updateCart(realCode, 1, { name, price });
        }
    };
    const handleAddAllFromProposal = (items: McdProposalItem[]) => {
        for (const it of items) handleAddFromProposal(it);
    };

    const updateCart = (code: string, delta: number, item?: { name: string; price?: any }) => {
        setCart((prev: Map<string, CartLine>) => {
            const next = new Map<string, CartLine>(prev);
            const cur = next.get(code);
            if (cur) {
                const nextQty = Math.max(0, Math.min(20, cur.qty + delta));
                if (nextQty === 0) next.delete(code);
                else next.set(code, { ...cur, qty: nextQty });
            } else if (delta > 0 && item) {
                next.set(code, { code, name: item.name, price: item.price, qty: delta });
            }
            return next;
        });
    };

    const handleOrderPlaced = (result: any) => {
        setOrderResult(result);
        if (ctx) {
            const lines = (Array.from(cart.values()) as CartLine[]);
            onConfirmOrder?.(lines, ctx);
        }
        setStep('success');
    };

    if (!open) return null;
    if (!isMcdConfigured()) {
        return (
            <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
                <div className="bg-white text-slate-800 rounded-2xl p-6 max-w-sm w-full text-center" onClick={(e: any) => e.stopPropagation()}>
                    <div className="text-3xl mb-2">🍔</div>
                    <div className="font-bold text-slate-800 mb-2">麦当劳还没开启</div>
                    <div className="text-[12px] text-slate-500 mb-4 leading-relaxed">请到设置 → 麦当劳填入 MCP token 并开启功能</div>
                    <button onClick={onClose} className="px-4 py-2 bg-yellow-500 text-white rounded-lg text-[12px] font-bold">知道了</button>
                </div>
            </div>
        );
    }

    return (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center" style={{ paddingBottom: 'var(--safe-bottom)' }} onClick={onClose}>
            <style>{`
                .mcd-scroll::-webkit-scrollbar { width: 4px; height: 4px; }
                .mcd-scroll::-webkit-scrollbar-track { background: transparent; }
                .mcd-scroll::-webkit-scrollbar-thumb { background: rgba(202, 138, 4, 0.25); border-radius: 999px; }
                .mcd-scroll::-webkit-scrollbar-thumb:hover { background: rgba(202, 138, 4, 0.5); }
                .mcd-scroll { scrollbar-width: thin; scrollbar-color: rgba(202, 138, 4, 0.25) transparent; }
            `}</style>
            <div
                className="bg-gradient-to-b from-yellow-50 to-amber-50 text-slate-800 w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl shadow-2xl overflow-hidden flex flex-col"
                style={{ height: '85vh', maxHeight: '85vh' }}
                onClick={(e: any) => e.stopPropagation()}
            >
                {/* 顶栏 */}
                <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-yellow-400 to-amber-400 shrink-0">
                    <div className="flex items-center gap-2">
                        <span className="text-2xl">🍟</span>
                        <div>
                            <div className="text-[13px] font-bold text-yellow-900">麦当劳</div>
                            <div className="text-[9px] text-yellow-900/70">官方 MCP · 直连下单</div>
                        </div>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-full bg-white/40 flex items-center justify-center text-yellow-900 active:scale-90">✕</button>
                </div>

                {/* 内容区 */}
                <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                    {step === 'mode' && (
                        <ModeStep onPick={(t: 1 | 2) => { setOrderType(t); setStep('pick'); }} />
                    )}
                    {step === 'pick' && orderType && (
                        <AddressStep
                            orderType={orderType}
                            onBack={() => setStep('mode')}
                            onPick={(c: OrderContext) => { setCtx(c); setStep('menu'); }}
                        />
                    )}
                    {step === 'menu' && ctx && (
                        <MenuStep
                            ctx={ctx}
                            cart={cart}
                            onCart={updateCart}
                            onMenuLoaded={setMenuData}
                            onBack={() => setStep('pick')}
                            onReview={() => setStep('review')}
                        />
                    )}
                    {step === 'review' && ctx && (
                        <ReviewStep
                            ctx={ctx}
                            cart={cart}
                            onCart={updateCart}
                            onBack={() => setStep('menu')}
                            onOrderPlaced={handleOrderPlaced}
                        />
                    )}
                    {step === 'success' && orderResult && (
                        <SuccessStep orderResult={orderResult} onClose={onClose} />
                    )}
                </div>

                {/* 协同聊天面板: 跟着 modal 永久挂在底部, 进入选地址那步开始就能聊 */}
                {char && step !== 'mode' && (
                    <InAppChat
                        char={char}
                        visibleMessages={visibleChatMessages}
                        isTyping={!!isTyping}
                        onSendMessage={onSendMessage}
                        onAddCartFromProposal={handleAddFromProposal}
                        onAddAllFromProposal={handleAddAllFromProposal}
                    />
                )}
            </div>
        </div>
    );
};

export default McdMiniApp;
export type { CartLine, OrderContext };
