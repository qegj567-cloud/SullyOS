import React, { useMemo, useState } from 'react';
import { trackEvent } from '../../utils/analytics';

/**
 * 麦当劳 MCP 工具结果卡片
 *
 * 渲染策略: 我们不知道每个工具具体返回什么字段, 所以做"启发式 + 通用展示":
 *  - 探测常见字段: items / products / stores / coupons / orderId / total ...
 *  - 命中已知形态 → 漂亮的专用卡片
 *  - 未命中 → 折叠的 JSON 详情 (可点击展开)
 *
 * 商品图直接从麦当劳 CDN 加载 (用户已同意)。
 */

export interface McdCartItem {
    code?: string;
    name: string;
    price?: number | string;
    image?: string;
    qty: number;
}

interface McdCardProps {
    toolName: string;
    args?: Record<string, any>;
    result?: any;
    error?: string | null;
    rawText?: string;
    kind?: 'menu' | 'order' | 'store' | 'coupon' | 'activity' | 'address' | 'generic' | 'cart' | 'candidate';
    /** 用户在菜单上选好商品后点"发送给角色", 把购物车作为新消息发出去 */
    onSendCart?: (items: McdCartItem[]) => void;
    /** 单品候选: 用户点 💭 → 立即把这一项扔给角色让 ta 评价 (不影响购物车) */
    onCandidate?: (item: McdCartItem) => void;
    /** kind='cart' 时使用 (历史消息): 之前选过的商品清单 */
    cartItems?: McdCartItem[];
    /** kind='candidate' 时使用 (历史消息): 候选的那一条单品 */
    candidateItem?: McdCartItem;
}

// ========== 通用辅助 ==========

const fmtMoney = (v: any): string => {
    if (v == null) return '';
    const n = typeof v === 'string' ? parseFloat(v) : v;
    if (!isFinite(n)) return String(v);
    return `¥${n.toFixed(2)}`;
};

const pickFirst = <T,>(obj: any, keys: string[]): T | undefined => {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const k of keys) if (obj[k] != null) return obj[k];
    return undefined;
};

const findArray = (obj: any, keys: string[]): any[] | null => {
    if (!obj || typeof obj !== 'object') return null;
    for (const k of keys) {
        const v = obj[k];
        if (Array.isArray(v) && v.length) return v;
    }
    // 兜底: 找第一个非空数组字段
    for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
    }
    return null;
};

// 看起来像可展示的 item: 名字/价格/标题之一存在
const looksLikeNamedItem = (v: any): boolean => {
    if (!v || typeof v !== 'object') return false;
    return [
        'name', 'title', 'productName', 'goodsName', 'mealName', 'displayName',
        'currentPrice', 'price', 'salePrice', 'sellPrice',
        'fullAddress', 'address', 'storeName', 'shopName',
    ].some(k => v[k] != null);
};

/**
 * 比 findArray 更宽: 还接受"以 SKU/ID 为键的 dict-of-object" (常见于麦当劳菜单返回),
 * 自动 Object.values 拍扁成数组。
 */
const extractItems = (data: any, prefKeys: string[] = ['items', 'products', 'goods', 'list', 'data', 'meals', 'addresses', 'stores']): any[] | null => {
    if (!data) return null;
    if (Array.isArray(data) && data.length) return data;
    if (typeof data !== 'object') return null;
    // 1) 优先 prefKeys
    for (const k of prefKeys) {
        const v = data[k];
        if (Array.isArray(v) && v.length) return v;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            const vals = Object.values(v).filter(x => x && typeof x === 'object');
            if (vals.length) return vals as any[];
        }
    }
    // 2) data 本身就是 dict-of-objects (键是 SKU 这种)
    const vals = Object.values(data).filter(x => x && typeof x === 'object');
    if (vals.length >= 2 && vals.every(x => !Array.isArray(x)) && vals.some(looksLikeNamedItem)) {
        return vals as any[];
    }
    // 3) 深一层: 在 data 的对象字段里找"含很多 named item 的 dict 或 array"
    //    应对 {categories: [...], meals: {SKU: {...}}} 这种, prefKeys 没覆盖时
    let bestArr: any[] | null = null;
    for (const k of Object.keys(data)) {
        const v = data[k];
        if (Array.isArray(v) && v.length && v.some(looksLikeNamedItem)) {
            if (!bestArr || v.length > bestArr.length) bestArr = v;
        } else if (v && typeof v === 'object' && !Array.isArray(v)) {
            const inner = Object.values(v).filter(x => x && typeof x === 'object');
            if (inner.length >= 2 && inner.some(looksLikeNamedItem)) {
                if (!bestArr || inner.length > bestArr.length) bestArr = inner as any[];
            }
        }
    }
    return bestArr;
};

// ========== 子卡片: 商品/菜单 ==========

interface MenuItemRowProps {
    item: any;
    qty?: number;
    /** 加购到本卡的内部购物车 (累积选, 之后一起发) */
    onAdd?: () => void;
    onSub?: () => void;
    /** 即时把这条单品作为"候选"扔给角色, 让 ta 评价/推荐, 不进购物车 */
    onCandidate?: () => void;
}

const MenuItemRow: React.FC<MenuItemRowProps> = ({ item, qty, onAdd, onSub, onCandidate }) => {
    const name = pickFirst<string>(item, ['name', 'productName', 'title', 'goodsName', 'mealName', 'displayName']) || '麦当劳商品';
    const desc = pickFirst<string>(item, ['description', 'desc', 'subtitle', 'shortDesc', 'remark']);
    const price = pickFirst<any>(item, ['currentPrice', 'price', 'salePrice', 'memberPrice', 'realPrice', 'amount', 'sellPrice']);
    const image = pickFirst<string>(item, ['image', 'imageUrl', 'pic', 'picUrl', 'img', 'icon', 'thumbnail', 'productImage']);
    const showStepper = !!onAdd || !!onSub;
    const q = qty || 0;
    return (
        <div className="flex gap-2 p-2 border-b border-yellow-50 last:border-b-0">
            <div className="w-14 h-14 rounded-lg bg-yellow-50 overflow-hidden shrink-0 flex items-center justify-center">
                {image ? (
                    <img src={image} alt="" className="w-full h-full object-cover" loading="lazy" referrerPolicy="no-referrer" onError={(e: any) => { e.target.style.display = 'none'; }} />
                ) : (
                    <span className="text-2xl">🍔</span>
                )}
            </div>
            <div className="flex-1 min-w-0">
                <div className="font-bold text-[12px] text-slate-800 truncate">{name}</div>
                {desc && <div className="text-[10px] text-slate-500 line-clamp-2 leading-snug mt-0.5">{desc}</div>}
                <div className="flex items-center justify-between mt-1 gap-2">
                    {price != null
                        ? <div className="text-[12px] font-bold text-yellow-700">{fmtMoney(price)}</div>
                        : <div className="flex-1" />}
                    <div className="flex items-center gap-1 shrink-0">
                        {onCandidate && (
                            <button
                                type="button"
                                onClick={onCandidate}
                                title="问问角色这个怎么样"
                                className="px-1.5 py-0.5 rounded-md bg-white border border-yellow-300 text-yellow-700 text-[10px] font-bold active:scale-95 transition-transform"
                            >💭 问 ta</button>
                        )}
                        {showStepper && (
                            <div className="flex items-center bg-white border border-yellow-300 rounded-md overflow-hidden">
                                <button
                                    type="button"
                                    onClick={onSub}
                                    disabled={q <= 0}
                                    className={`w-6 h-6 flex items-center justify-center text-[14px] font-bold ${q <= 0 ? 'text-slate-300' : 'text-yellow-700 active:bg-yellow-100'}`}
                                >−</button>
                                <span className="min-w-[20px] text-center text-[11px] font-bold text-slate-700">{q}</span>
                                <button
                                    type="button"
                                    onClick={onAdd}
                                    className="w-6 h-6 flex items-center justify-center text-[14px] font-bold text-yellow-700 active:bg-yellow-100"
                                >+</button>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

// ========== 子卡片: 订单 ==========

const OrderSummary: React.FC<{ data: any }> = ({ data }) => {
    const orderId = pickFirst<string>(data, ['orderId', 'orderNo', 'id', 'orderSn', 'tradeNo']);
    const total = pickFirst<any>(data, ['totalAmount', 'total', 'amount', 'payAmount', 'realPayAmount']);
    const status = pickFirst<string>(data, ['status', 'statusText', 'orderStatus', 'state']);
    const deliveryType = pickFirst<string>(data, ['deliveryType', 'orderType', 'channel']);
    const address = pickFirst<string>(data, ['address', 'deliveryAddress', 'consigneeAddress']);
    const items = findArray(data, ['items', 'goods', 'products', 'orderItems', 'goodsList']);
    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between">
                <span className="text-[10px] text-yellow-700/70 font-bold uppercase">订单</span>
                {status && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-yellow-100 text-yellow-700 font-bold">{status}</span>}
            </div>
            {orderId && <div className="text-[11px] text-slate-500 font-mono">#{orderId}</div>}
            {deliveryType && <div className="text-[10px] text-slate-500">{deliveryType}</div>}
            {address && <div className="text-[10px] text-slate-500 line-clamp-2">📍 {address}</div>}
            {items && items.length > 0 && (
                <div className="bg-white/70 rounded-lg overflow-hidden border border-yellow-100">
                    {items.slice(0, 5).map((it, i) => <MenuItemRow key={i} item={it} />)}
                    {items.length > 5 && <div className="text-[10px] text-slate-400 text-center py-1.5">还有 {items.length - 5} 项…</div>}
                </div>
            )}
            {total != null && (
                <div className="flex items-center justify-between border-t border-yellow-200/60 pt-1.5">
                    <span className="text-[11px] text-slate-600">合计</span>
                    <span className="text-[14px] font-bold text-yellow-700">{fmtMoney(total)}</span>
                </div>
            )}
        </div>
    );
};

// ========== 子卡片: 门店 ==========

const StoreList: React.FC<{ data: any }> = ({ data }) => {
    const stores = extractItems(data, ['stores', 'shops', 'restaurants', 'storeList', 'list', 'data', 'items']) || [];
    if (!stores.length) return null;
    return (
        <div className="space-y-1.5">
            <div className="text-[10px] text-yellow-700/70 font-bold uppercase">附近门店</div>
            {stores.slice(0, 5).map((s, i) => {
                const name = pickFirst<string>(s, ['name', 'storeName', 'shopName', 'restaurantName']) || '麦当劳门店';
                const addr = pickFirst<string>(s, ['address', 'storeAddress', 'shopAddress']);
                const distance = pickFirst<any>(s, ['distance', 'distanceM']);
                return (
                    <div key={i} className="bg-white/70 rounded-lg p-2 border border-yellow-100">
                        <div className="flex items-center justify-between">
                            <div className="font-bold text-[12px] text-slate-800 truncate">{name}</div>
                            {distance != null && <div className="text-[10px] text-yellow-700 shrink-0 ml-2">📍 {typeof distance === 'number' ? (distance > 1000 ? (distance / 1000).toFixed(1) + 'km' : distance + 'm') : distance}</div>}
                        </div>
                        {addr && <div className="text-[10px] text-slate-500 line-clamp-2 mt-0.5">{addr}</div>}
                    </div>
                );
            })}
            {stores.length > 5 && <div className="text-[10px] text-slate-400 text-center">还有 {stores.length - 5} 家门店…</div>}
        </div>
    );
};

// ========== 子卡片: 菜单列表 (可展开 + 可选购) ==========

const itemKey = (item: any, idx: number): string => {
    return String(item?.code || item?.productCode || item?.skuCode || item?.id || `idx-${idx}`);
};

const itemToCart = (item: any): McdCartItem => ({
    code: pickFirst<string>(item, ['code', 'productCode', 'skuCode', 'mealCode', 'goodsCode']),
    name: pickFirst<string>(item, ['name', 'productName', 'title', 'goodsName', 'mealName', 'displayName']) || '麦当劳商品',
    price: pickFirst<any>(item, ['currentPrice', 'price', 'salePrice', 'memberPrice', 'realPrice', 'sellPrice']),
    image: pickFirst<string>(item, ['image', 'imageUrl', 'pic', 'picUrl', 'img', 'icon', 'thumbnail', 'productImage']),
    qty: 1,
});

const MenuList: React.FC<{ items: any[]; pageSize?: number; onSendCart?: (items: McdCartItem[]) => void; onCandidate?: (item: McdCartItem) => void }> = ({ items, pageSize = 6, onSendCart, onCandidate }) => {
    const [page, setPage] = useState(0);
    // selected: key → quantity (跨页保持)
    const [selected, setSelected] = useState<Record<string, number>>({});

    const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
    const safePage = Math.min(page, totalPages - 1);
    const start = safePage * pageSize;
    const shown = items.slice(start, start + pageSize);

    const change = (k: string, delta: number) => {
        setSelected(s => {
            const cur = s[k] || 0;
            const next = Math.max(0, Math.min(20, cur + delta));
            const out = { ...s };
            if (next === 0) delete out[k]; else out[k] = next;
            return out;
        });
    };

    const cart = useMemo(() => {
        const out: McdCartItem[] = [];
        items.forEach((it, i) => {
            const k = itemKey(it, i);
            const q = selected[k];
            if (q && q > 0) out.push({ ...itemToCart(it), qty: q });
        });
        return out;
    }, [selected, items]);

    const totalCount = cart.reduce((sum, c) => sum + c.qty, 0);
    const totalPrice = cart.reduce((sum, c) => {
        const p = typeof c.price === 'string' ? parseFloat(c.price) : (typeof c.price === 'number' ? c.price : 0);
        return sum + (isFinite(p) ? p * c.qty : 0);
    }, 0);

    const handleSend = () => {
        if (!cart.length || !onSendCart) return;
        onSendCart(cart);
        setSelected({});
        trackEvent('把麦当劳购物车发给角色');
    };

    return (
        <div>
            <div className="bg-white/70 rounded-lg overflow-hidden border border-yellow-100">
                {shown.map((it, idx) => {
                    const globalIdx = start + idx;
                    const k = itemKey(it, globalIdx);
                    const q = selected[k] || 0;
                    return <MenuItemRow
                        key={k}
                        item={it}
                        qty={q}
                        onAdd={onSendCart ? () => change(k, 1) : undefined}
                        onSub={onSendCart ? () => change(k, -1) : undefined}
                        onCandidate={onCandidate ? () => onCandidate({ ...itemToCart(it), qty: 1 }) : undefined}
                    />;
                })}
                {totalPages > 1 && (
                    <div className="flex items-center justify-between gap-2 px-2 py-1.5 border-t border-yellow-100 bg-yellow-50/40">
                        <button
                            type="button"
                            disabled={safePage === 0}
                            onClick={() => setPage(p => Math.max(0, p - 1))}
                            className={`w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold transition ${safePage === 0 ? 'text-slate-300' : 'text-yellow-700 active:bg-yellow-200/60 active:scale-90'}`}
                        >‹</button>
                        <div className="text-[11px] text-yellow-800 font-bold">
                            第 {safePage + 1} / {totalPages} 页
                            <span className="text-[9px] text-yellow-700/60 font-normal ml-1.5">（共 {items.length} 项）</span>
                        </div>
                        <button
                            type="button"
                            disabled={safePage >= totalPages - 1}
                            onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                            className={`w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold transition ${safePage >= totalPages - 1 ? 'text-slate-300' : 'text-yellow-700 active:bg-yellow-200/60 active:scale-90'}`}
                        >›</button>
                    </div>
                )}
            </div>
            {onSendCart && totalCount > 0 && (
                <div className="mt-2 flex items-center gap-2 bg-yellow-100/80 rounded-lg p-2 border border-yellow-300">
                    <div className="flex-1 min-w-0">
                        <div className="text-[10px] text-yellow-800/80">已选 {totalCount} 件</div>
                        {totalPrice > 0 && <div className="text-[14px] font-bold text-yellow-800">{fmtMoney(totalPrice)}</div>}
                    </div>
                    <button
                        type="button"
                        onClick={() => { setSelected({}); trackEvent('清空麦当劳购物车'); }}
                        className="text-[10px] text-yellow-700 px-2 py-1.5 active:scale-95"
                    >清空</button>
                    <button
                        type="button"
                        onClick={handleSend}
                        className="px-3 py-1.5 bg-yellow-500 text-white text-[11px] font-bold rounded-lg shadow active:scale-95 transition-transform"
                    >发送给角色 →</button>
                </div>
            )}
        </div>
    );
};

// ========== 子卡片: 用户购物车 (用户在菜单选完点"发送给角色"后产生的卡片) ==========

const CartCard: React.FC<{ items: McdCartItem[] }> = ({ items }) => {
    const total = items.reduce((sum, c) => {
        const p = typeof c.price === 'string' ? parseFloat(c.price) : (typeof c.price === 'number' ? c.price : 0);
        return sum + (isFinite(p) ? p * c.qty : 0);
    }, 0);
    const totalCount = items.reduce((s, c) => s + c.qty, 0);
    return (
        <div className="space-y-2">
            <div className="text-[10px] text-yellow-700/80 font-bold uppercase">🛒 想要下单的内容</div>
            <div className="bg-white/80 rounded-lg overflow-hidden border border-yellow-200">
                {items.map((it, i) => (
                    <div key={i} className="flex items-center gap-2 p-2 border-b border-yellow-50 last:border-b-0">
                        <div className="w-10 h-10 rounded-md bg-yellow-50 overflow-hidden shrink-0 flex items-center justify-center">
                            {it.image ? <img src={it.image} alt="" className="w-full h-full object-cover" loading="lazy" referrerPolicy="no-referrer" onError={(e: any) => { e.target.style.display = 'none'; }} /> : <span className="text-lg">🍔</span>}
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="font-bold text-[12px] text-slate-800 truncate">{it.name}</div>
                            {it.price != null && <div className="text-[10px] text-yellow-700">{fmtMoney(it.price)}</div>}
                        </div>
                        <div className="text-[12px] font-bold text-yellow-700 shrink-0">×{it.qty}</div>
                    </div>
                ))}
            </div>
            <div className="flex items-center justify-between pt-1">
                <span className="text-[11px] text-slate-600">共 {totalCount} 件</span>
                {total > 0 && <span className="text-[15px] font-bold text-yellow-700">{fmtMoney(total)}</span>}
            </div>
        </div>
    );
};

// ========== 子卡片: 收货地址 ==========

const AddressList: React.FC<{ data: any }> = ({ data }) => {
    const list = extractItems(data, ['addresses', 'addressList', 'list', 'data', 'items']) || [];
    if (!list.length) return null;
    return (
        <div className="space-y-1.5">
            <div className="text-[10px] text-yellow-700/70 font-bold uppercase">📍 收货地址</div>
            {list.slice(0, 5).map((a, i) => {
                const name = pickFirst<string>(a, ['contactName', 'name', 'consignee', 'consigneeName']) || '收货人';
                const phone = pickFirst<string>(a, ['phone', 'mobile', 'tel', 'contactPhone', 'consigneePhone']);
                const addr = pickFirst<string>(a, ['fullAddress', 'address', 'detailAddress', 'consigneeAddress']);
                const tag = pickFirst<string>(a, ['tag', 'label', 'addressTag', 'addressType']);
                return (
                    <div key={i} className="bg-white/70 rounded-lg p-2 border border-yellow-100">
                        <div className="flex items-center justify-between">
                            <div className="font-bold text-[12px] text-slate-800 truncate">
                                {name}{phone && <span className="text-[10px] text-slate-500 font-normal ml-1.5">{phone}</span>}
                            </div>
                            {tag && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-yellow-100 text-yellow-700 shrink-0 ml-1">{tag}</span>}
                        </div>
                        {addr && <div className="text-[10px] text-slate-500 line-clamp-2 mt-0.5">{addr}</div>}
                    </div>
                );
            })}
            {list.length > 5 && <div className="text-[10px] text-slate-400 text-center">还有 {list.length - 5} 条…</div>}
        </div>
    );
};

// ========== 子卡片: 优惠券/券 ==========

const CouponList: React.FC<{ data: any }> = ({ data }) => {
    const coupons = extractItems(data, ['coupons', 'vouchers', 'myCoupons', 'couponList', 'storeCoupons', 'list', 'data', 'items']) || [];
    if (!coupons.length) return null;
    return (
        <div className="space-y-1.5">
            <div className="text-[10px] text-yellow-700/70 font-bold uppercase">券</div>
            {coupons.slice(0, 6).map((c, i) => {
                const title = pickFirst<string>(c, ['title', 'name', 'couponName', 'goodsName']) || '麦当劳券';
                const value = pickFirst<any>(c, ['value', 'amount', 'discountAmount', 'price', 'points']);
                const expire = pickFirst<string>(c, ['expireDate', 'endTime', 'validTo', 'expireTime']);
                return (
                    <div key={i} className="flex items-center justify-between bg-white/70 rounded-lg p-2 border border-yellow-100">
                        <div className="min-w-0">
                            <div className="font-bold text-[12px] text-slate-800 truncate">🎟️ {title}</div>
                            {expire && <div className="text-[10px] text-slate-400">有效期至 {expire}</div>}
                        </div>
                        {value != null && <div className="text-[12px] font-bold text-yellow-700 shrink-0 ml-2">{typeof value === 'number' ? fmtMoney(value) : String(value)}</div>}
                    </div>
                );
            })}
        </div>
    );
};

// ========== 子卡片: 套餐详情 (query-meal-detail 返回) ==========

const MealDetailCard: React.FC<{ data: any }> = ({ data }) => {
    const code = data?.code;
    const price = data?.price;
    const rounds = Array.isArray(data?.rounds) ? data.rounds : [];
    return (
        <div className="space-y-2">
            <div className="text-[10px] text-yellow-700/70 font-bold uppercase">套餐组成</div>
            <div className="bg-white/70 rounded-lg p-2 border border-yellow-100 flex items-center justify-between">
                <span className="text-[10px] text-slate-500 font-mono truncate">code: {code || '?'}</span>
                {price != null && <span className="text-[13px] font-bold text-yellow-700 shrink-0 ml-2">{fmtMoney(price)}</span>}
            </div>
            {rounds.length === 0 ? (
                <div className="text-[10px] text-slate-500 bg-slate-50/80 rounded-lg p-2 leading-relaxed">
                    上游对此 code 没返回 round 结构 (可能本身就是单品, 也可能 code 对不上预期套餐)。下单时若已确认 code 正确, 顶层 code 直接放进 calculate-price.items 即可。
                </div>
            ) : (
                rounds.map((r: any, i: number) => (
                    <div key={i} className="bg-white/70 rounded-lg p-2 border border-yellow-100">
                        <div className="text-[11px] font-bold text-slate-700">
                            {r.name || `第 ${r.id || i + 1} 项`}
                            <span className="text-[10px] text-slate-400 font-normal ml-1.5">×{r.quantity ?? 1}</span>
                        </div>
                        {Array.isArray(r.choices) && r.choices.length > 0 && (
                            <div className="mt-1 pl-2 space-y-0.5">
                                {r.choices.map((c: any, j: number) => (
                                    <div key={j} className="text-[10px] text-slate-500">
                                        • {c.name || c.code} <span className="text-slate-400">×{c.quantity ?? 1}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                ))
            )}
            <div className="text-[9px] text-slate-400 italic leading-snug">
                v1.0.3 不支持更换套餐内单品, 下单直接用顶层 code 即可。
            </div>
        </div>
    );
};

// ========== 文本/toon 长内容 (list-nutrition-foods / campaign-calendar 之类工具返回的) ==========

const TextResultCard: React.FC<{ text: string; toolName: string }> = ({ text, toolName }) => {
    const [expanded, setExpanded] = useState(false);
    const preview = text.length > 240 ? text.slice(0, 240) + '…' : text;
    const isLong = text.length > 240;
    const label = /nutrition/i.test(toolName) ? '营养信息表'
        : /campaign|calendar/i.test(toolName) ? '活动日历'
        : /coupon/i.test(toolName) ? '优惠券文本'
        : '文本结果';
    return (
        <div className="bg-white/80 rounded-lg border border-yellow-100 p-2.5">
            <div className="text-[10px] text-yellow-700/70 font-bold uppercase mb-1">{label}</div>
            <pre className={`text-[10px] text-slate-700 leading-snug font-mono whitespace-pre-wrap break-all ${expanded ? '' : 'max-h-40 overflow-hidden'}`}>{expanded ? text : preview}</pre>
            {isLong && (
                <button onClick={() => setExpanded(v => !v)} className="mt-1 text-[10px] text-yellow-700 active:scale-95">
                    {expanded ? '▲ 收起' : '▼ 展开全部'}
                </button>
            )}
        </div>
    );
};

// ========== 空信封 / 失败信封提示 ==========

const isMcdEnvelope = (v: any): boolean => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const envKeys = ['success', 'code', 'message', 'datetime', 'traceId', 'msg', 'errorCode', 'errMsg'];
    const hits = envKeys.filter(k => k in v).length;
    return hits >= 2; // 至少 2 个信封字段才算
};

const EnvelopeNotice: React.FC<{ data: any }> = ({ data }) => {
    const ok = data?.success === true || data?.code === 200 || data?.code === '200' || data?.code === 0;
    const msg = data?.message || data?.msg || data?.errMsg || (ok ? '请求成功，但没有返回数据' : '请求失败');
    const code = data?.code ?? data?.errorCode;
    const traceId = data?.traceId;
    return (
        <div className={`rounded-lg border p-3 ${ok ? 'bg-blue-50/60 border-blue-200' : 'bg-red-50/60 border-red-200'}`}>
            <div className="flex items-start gap-2">
                <span className="text-xl shrink-0 leading-none mt-0.5">{ok ? 'ℹ️' : '⚠️'}</span>
                <div className="flex-1 min-w-0">
                    <div className={`font-bold text-[12px] ${ok ? 'text-blue-700' : 'text-red-600'}`}>{msg}</div>
                    {ok && (
                        <div className="text-[10px] text-blue-600/80 mt-1 leading-relaxed">
                            麦当劳没返回内容。常见原因: 该门店此时段不营业 / 不支持当前模式 / 参数不对 / 服务临时抖动。可以换个门店或让角色重试。
                        </div>
                    )}
                    {code != null && <div className="text-[9px] text-slate-400 font-mono mt-1">code: {String(code)}{traceId && ` · trace: ${traceId.slice(0, 8)}…`}</div>}
                </div>
            </div>
        </div>
    );
};

const EmptyResultNotice: React.FC<{ toolName: string }> = ({ toolName }) => (
    <div className="rounded-lg border p-3 bg-slate-50/70 border-slate-200">
        <div className="text-[12px] font-bold text-slate-600">这个工具这次没返回可展示的数据</div>
        <div className="text-[10px] text-slate-500 mt-1 leading-relaxed">
            {toolName} 返回了空列表。常见原因：门店/时段不支持、参数组合不匹配、或服务端临时无可用结果。可以换门店或调整参数重试。
        </div>
    </div>
);

const UnrecognizedDiag: React.FC<{ data: any; rawText?: string; toolName: string }> = ({ data, rawText, toolName }) => {
    const [expanded, setExpanded] = useState(false);
    const [copyState, setCopyState] = useState<'idle' | 'ok' | 'err'>('idle');
    const diag = useMemo(() => {
        if (data == null) return { kind: 'empty', keys: '', sample: '', count: 0 };
        if (typeof data === 'string') return { kind: 'string', keys: '', sample: data.slice(0, 100), count: data.length };
        if (Array.isArray(data)) {
            const first = data[0];
            const sample = first && typeof first === 'object' ? Object.keys(first).slice(0, 8).join(', ') : String(first).slice(0, 80);
            return { kind: `array[${data.length}]`, keys: '', sample, count: data.length };
        }
        if (typeof data === 'object') {
            const keys = Object.keys(data);
            const firstObjKey = keys.find(k => data[k] && typeof data[k] === 'object');
            const firstObj = firstObjKey ? data[firstObjKey] : null;
            const sample = firstObj
                ? `${firstObjKey}: { ${Object.keys(firstObj).slice(0, 6).join(', ')} }`
                : '';
            return { kind: 'object', keys: keys.slice(0, 10).join(', '), sample, count: keys.length };
        }
        return { kind: typeof data, keys: '', sample: String(data).slice(0, 80), count: 0 };
    }, [data]);

    const fullJson = useMemo(() => {
        if (typeof data === 'string') return data;
        try { return JSON.stringify(data, null, 2); } catch { return rawText || ''; }
    }, [data, rawText]);

    const handleCopy = async () => {
        const text = fullJson || rawText || '';
        if (!text) return;
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
            } else {
                // 兜底: 老 webview / iOS Capacitor 不支持 clipboard API 的情况
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
            }
            setCopyState('ok');
        } catch {
            setCopyState('err');
        }
        setTimeout(() => setCopyState('idle'), 1500);
    };

    return (
        <div className="bg-white/70 rounded-lg border-2 border-dashed border-orange-300">
            <div className="px-2 pt-2 pb-1.5 flex items-center gap-1.5">
                <span className="text-[9px] px-1.5 py-0.5 bg-orange-100 text-orange-700 rounded-full font-bold">⚠️ 这条点单信息读取失败</span>
                <span className="text-[10px] text-slate-400 font-mono truncate">{toolName}</span>
            </div>
            <div className="px-2 pb-1.5 space-y-0.5 text-[10px] text-slate-600 font-mono leading-snug">
                <div><span className="text-slate-400">type:</span> {diag.kind}</div>
                {diag.keys && <div className="break-all"><span className="text-slate-400">keys:</span> {diag.keys}</div>}
                {diag.sample && <div className="break-all"><span className="text-slate-400">sample:</span> {diag.sample}</div>}
            </div>
            {fullJson && (
                <div className="flex items-center border-t border-orange-200/60">
                    <button onClick={() => setExpanded(v => !v)} className="flex-1 text-left px-2 py-1 text-[10px] text-orange-600 active:scale-[0.99]">
                        {expanded ? '▼ 收起原始' : '▶ 展开原始 JSON'}
                    </button>
                    <button
                        onClick={handleCopy}
                        className={`px-2.5 py-1 text-[10px] font-bold border-l border-orange-200/60 active:scale-95 transition ${
                            copyState === 'ok' ? 'text-emerald-600' : copyState === 'err' ? 'text-red-500' : 'text-orange-600'
                        }`}
                    >
                        {copyState === 'ok' ? '✓ 已复制' : copyState === 'err' ? '× 失败' : '📋 复制'}
                    </button>
                </div>
            )}
            {expanded && fullJson && (
                <pre className="text-[10px] text-slate-600 px-2 pb-2 overflow-auto max-h-64 leading-tight whitespace-pre-wrap break-all">{fullJson}</pre>
            )}
        </div>
    );
};

// ========== 主入口 ==========

const McdCard: React.FC<McdCardProps> = ({ toolName, args, result, error, rawText, kind = 'generic', onSendCart, onCandidate, cartItems, candidateItem }) => {
    // 购物车类型 (用户侧已发送的"想要下单"小卡片)
    if (kind === 'cart' && cartItems && cartItems.length) {
        return (
            <div className="sully-chat-card-face w-72 rounded-2xl overflow-hidden border border-yellow-200 shadow-sm bg-gradient-to-br from-yellow-50 to-amber-50">
                <div className="flex items-center gap-2 px-3 py-2 bg-gradient-to-r from-yellow-400 to-amber-400">
                    <span className="text-lg">🛒</span>
                    <div className="flex-1 min-w-0">
                        <div className="text-[11px] font-bold text-yellow-900">麦当劳</div>
                        <div className="text-[9px] text-yellow-900/70">想要下单</div>
                    </div>
                </div>
                <div className="p-3"><CartCard items={cartItems} /></div>
            </div>
        );
    }
    // 候选类型 (用户侧"问问 ta 这个"扔过来的单品)
    if (kind === 'candidate' && candidateItem) {
        return (
            <div className="sully-chat-card-face w-64 rounded-2xl overflow-hidden border border-yellow-200 shadow-sm bg-gradient-to-br from-yellow-50 to-amber-50">
                <div className="flex items-center gap-2 px-3 py-2 bg-gradient-to-r from-yellow-300 to-amber-300">
                    <span className="text-lg">💭</span>
                    <div className="flex-1 min-w-0">
                        <div className="text-[11px] font-bold text-yellow-900">麦当劳</div>
                        <div className="text-[9px] text-yellow-900/70">想问问你的意见</div>
                    </div>
                </div>
                <div className="p-3 flex items-center gap-2">
                    <div className="w-12 h-12 rounded-md bg-yellow-50 overflow-hidden shrink-0 flex items-center justify-center">
                        {candidateItem.image
                            ? <img src={candidateItem.image} alt="" className="w-full h-full object-cover" loading="lazy" referrerPolicy="no-referrer" onError={(e: any) => { e.target.style.display = 'none'; }} />
                            : <span className="text-xl">🍔</span>}
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="font-bold text-[12px] text-slate-800 truncate">{candidateItem.name}</div>
                        {candidateItem.price != null && <div className="text-[11px] text-yellow-700">{fmtMoney(candidateItem.price)}</div>}
                    </div>
                </div>
            </div>
        );
    }
    const isError = !!error;

    // 针对每种 kind 尝试抽 items, 抽到才走专门渲染, 抽不到就走通用 JSON 兜底
    const specializedItems = useMemo(() => {
        if (!result) return null;
        if (kind === 'address') return extractItems(result, ['addresses', 'addressList', 'list', 'data', 'items']);
        if (kind === 'store') return extractItems(result, ['stores', 'shops', 'restaurants', 'storeList', 'list', 'data', 'items']);
        if (kind === 'coupon') return extractItems(result, ['coupons', 'vouchers', 'myCoupons', 'couponList', 'storeCoupons', 'list', 'data', 'items']);
        if (kind === 'menu') return extractItems(result, ['items', 'products', 'goods', 'list', 'data', 'meals']);
        return null;
    }, [kind, result]);
    const specializedHasItems = !!(specializedItems && specializedItems.length && specializedItems.some(looksLikeNamedItem));

    // 通用菜单识别 (kind 没识别但 result 里能挖出商品列表)
    const fallbackMenuItems = useMemo(() => {
        if (kind !== 'generic' || !result) return null;
        return extractItems(result, ['items', 'products', 'goods', 'list', 'data', 'meals', 'addresses', 'stores']);
    }, [kind, result]);
    const fallbackMenuHasItems = !!(fallbackMenuItems && fallbackMenuItems.length && fallbackMenuItems.some(looksLikeNamedItem));

    const effectiveKind: McdCardProps['kind'] = useMemo(() => {
        if (kind === 'order') return 'order'; // 订单永远走专属 (即使内容简单也至少展示状态)
        if (kind && kind !== 'generic' && specializedHasItems) return kind;
        if (fallbackMenuHasItems) return 'menu';
        return 'generic';
    }, [kind, specializedHasItems, fallbackMenuHasItems]);

    const menuItems = kind === 'menu' ? specializedItems : fallbackMenuItems;
    const itemsHaveDisplayFields = effectiveKind === 'menu' && (specializedHasItems || fallbackMenuHasItems);

    return (
        <div className="sully-chat-card-face w-72 rounded-2xl overflow-hidden border border-yellow-200 shadow-sm bg-gradient-to-br from-yellow-50 to-amber-50">
            {/* 头部: 麦当劳红黄条 */}
            <div className="flex items-center gap-2 px-3 py-2 bg-gradient-to-r from-yellow-400 to-amber-400">
                <span className="text-lg">🍟</span>
                <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-bold text-yellow-900">麦当劳</div>
                    <div className="text-[9px] text-yellow-900/70 font-mono truncate">{toolName}</div>
                </div>
                {isError ? (
                    <span className="text-[9px] px-1.5 py-0.5 bg-red-100 text-red-600 rounded-full font-bold">失败</span>
                ) : (
                    <span className="text-[9px] px-1.5 py-0.5 bg-white/70 text-yellow-900 rounded-full font-bold">已返回</span>
                )}
            </div>

            <div className="p-3 space-y-2">
                {isError ? (
                    <>
                        <div className="text-[11px] text-red-600 leading-relaxed whitespace-pre-wrap">{error}</div>
                        {args && Object.keys(args).length > 0 && (
                            <details className="bg-red-50/60 border border-red-200 rounded-lg">
                                <summary className="text-[10px] text-red-700 px-2 py-1 cursor-pointer font-bold">▶ 模型这次传的参数</summary>
                                <pre className="text-[10px] text-slate-700 px-2 pb-2 overflow-auto max-h-48 leading-tight whitespace-pre-wrap break-all font-mono">{(() => { try { return JSON.stringify(args, null, 2); } catch { return String(args); } })()}</pre>
                            </details>
                        )}
                    </>
                ) : (
                    <>
                        {/^query[-_]?meal[-_]?detail$/i.test(toolName) && result && typeof result === 'object' && !Array.isArray(result) && ('rounds' in result || 'code' in result) ? (
                            <MealDetailCard data={result} />
                        ) : effectiveKind === 'menu' && menuItems && menuItems.length > 0 && itemsHaveDisplayFields ? (
                            <MenuList items={menuItems} onSendCart={onSendCart} onCandidate={onCandidate} />
                        ) : effectiveKind === 'address' && result ? (
                            <AddressList data={result} />
                        ) : effectiveKind === 'order' && result ? (
                            <OrderSummary data={result} />
                        ) : effectiveKind === 'store' && result ? (
                            <StoreList data={result} />
                        ) : effectiveKind === 'coupon' && result ? (
                            <CouponList data={result} />
                        ) : Array.isArray(result) && result.length === 0 ? (
                            <EmptyResultNotice toolName={toolName} />
                        ) : typeof result === 'string' && result.trim().length > 0 ? (
                            <TextResultCard text={result} toolName={toolName} />
                        ) : isMcdEnvelope(result) ? (
                            <EnvelopeNotice data={result} />
                        ) : (
                            <UnrecognizedDiag data={result} rawText={rawText} toolName={toolName} />
                        )}
                    </>
                )}
                {!isError && args && Object.keys(args).length > 0 && (
                    <details className="text-[9px] text-slate-400 font-mono">
                        <summary className="cursor-pointer truncate select-none active:text-yellow-700">
                            参数: {Object.keys(args).join(', ')}
                        </summary>
                        <pre className="text-[10px] text-slate-600 mt-1 px-1 py-1 bg-slate-50/80 rounded overflow-auto max-h-40 whitespace-pre-wrap break-all">{(() => { try { return JSON.stringify(args, null, 2); } catch { return String(args); } })()}</pre>
                    </details>
                )}
            </div>
        </div>
    );
};

export default McdCard;
