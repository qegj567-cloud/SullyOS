import React, { useMemo, useState } from 'react';
import { luckinItemEmoji } from '../../utils/luckinEmoji';
import PayQr from '../luckin/PayQr';
import { trackEvent } from '../../utils/analytics';

/**
 * 瑞幸 MCP 工具结果卡片 (与 McdCard 同构, 瑞幸蓝主题)
 *
 * 渲染策略: 不知道每个工具具体返回什么字段, 所以做"启发式 + 通用展示":
 *  - 探测常见字段: items / products / stores / coupons / orderId / total ...
 *  - 命中已知形态 → 漂亮的专用卡片
 *  - 未命中 → 折叠的 JSON 详情 (可点击展开)
 */

export interface LuckinCartItem {
    code?: string;
    name: string;
    price?: number | string;
    image?: string;
    spec?: string;
    qty: number;
}

interface LuckinCardProps {
    toolName: string;
    args?: Record<string, any>;
    result?: any;
    error?: string | null;
    rawText?: string;
    kind?: 'menu' | 'order' | 'store' | 'coupon' | 'activity' | 'address' | 'generic' | 'cart' | 'candidate';
    /** 用户在菜单上选好商品后点"发送给角色", 把购物车作为新消息发出去 */
    onSendCart?: (items: LuckinCartItem[]) => void;
    /** 单品候选: 用户点 💭 → 立即把这一项扔给角色让 ta 评价 (不影响购物车) */
    onCandidate?: (item: LuckinCartItem) => void;
    /** kind='cart' 时使用 (历史消息): 之前选过的商品清单 */
    cartItems?: LuckinCartItem[];
    /** kind='candidate' 时使用 (历史消息): 候选的那一条单品 */
    candidateItem?: LuckinCartItem;
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
    for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
    }
    return null;
};

const looksLikeNamedItem = (v: any): boolean => {
    if (!v || typeof v !== 'object') return false;
    return [
        'name', 'title', 'productName', 'goodsName', 'commodityName', 'commodityName', 'displayName',
        'estimatePrice', 'initialPrice', 'currentPrice', 'price', 'salePrice', 'sellPrice', 'realPrice',
        'fullAddress', 'address', 'storeName', 'shopName', 'deptName', 'skuCode',
    ].some(k => v[k] != null);
};

const extractItems = (data: any, prefKeys: string[] = ['items', 'products', 'goods', 'list', 'data', 'menu', 'addresses', 'stores']): any[] | null => {
    if (!data) return null;
    if (Array.isArray(data) && data.length) return data;
    if (typeof data !== 'object') return null;
    for (const k of prefKeys) {
        const v = data[k];
        if (Array.isArray(v) && v.length) return v;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            const vals = Object.values(v).filter(x => x && typeof x === 'object');
            if (vals.length) return vals as any[];
        }
    }
    const vals = Object.values(data).filter(x => x && typeof x === 'object');
    if (vals.length >= 2 && vals.every(x => !Array.isArray(x)) && vals.some(looksLikeNamedItem)) {
        return vals as any[];
    }
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

// ========== 子卡片: 商品/菜单行 ==========

interface MenuItemRowProps {
    item: any;
    qty?: number;
    onAdd?: () => void;
    onSub?: () => void;
    onCandidate?: () => void;
}

const MenuItemRow: React.FC<MenuItemRowProps> = ({ item, qty, onAdd, onSub, onCandidate }) => {
    const name = pickFirst<string>(item, ['name', 'productName', 'title', 'goodsName', 'commodityName', 'displayName']) || '瑞幸商品';
    const desc = pickFirst<string>(item, ['additionDesc', 'description', 'desc', 'subtitle', 'shortDesc', 'remark']);
    const price = pickFirst<any>(item, ['estimatePrice', 'estimateTotalPrice', 'currentPrice', 'price', 'salePrice', 'memberPrice', 'realPrice', 'sellPrice', 'initPrice', 'initialPrice']);
    const image = pickFirst<string>(item, ['pictureUrl', 'breviaryPicUrl', 'bigPicUrl', 'image', 'imageUrl', 'pic', 'picUrl', 'img', 'icon', 'thumbnail', 'productImage']);
    const tags: string[] = Array.isArray((item as any).tags) ? (item as any).tags : [];
    const showStepper = !!onAdd || !!onSub;
    const q = qty || 0;
    return (
        <div className="flex gap-2 p-2 border-b border-[#F4EFE4] last:border-b-0">
            <div className="w-14 h-14 rounded-lg bg-[#FAF7F0] overflow-hidden shrink-0 flex items-center justify-center">
                {image ? (
                    <img src={image} alt="" className="w-full h-full object-cover" loading="lazy" referrerPolicy="no-referrer" onError={(e: any) => { e.target.style.display = 'none'; }} />
                ) : (
                    <span className="text-2xl">{luckinItemEmoji(name)}</span>
                )}
            </div>
            <div className="flex-1 min-w-0">
                <div className="font-bold text-[12px] text-slate-800 truncate">{name}</div>
                {desc && <div className="text-[10px] text-slate-500 line-clamp-2 leading-snug mt-0.5">{desc}</div>}
                {tags.length > 0 && (
                    <div className="flex gap-1 mt-0.5 flex-wrap">
                        {tags.slice(0, 2).map((t, j) => (
                            <span key={j} className="text-[9px] px-1 py-px rounded bg-[#F2ECDD] text-[#16386F]">{t}</span>
                        ))}
                    </div>
                )}
                <div className="flex items-center justify-between mt-1 gap-2">
                    {price != null
                        ? <div className="text-[12px] font-bold text-[#16386F]">{fmtMoney(price)}</div>
                        : <div className="flex-1" />}
                    <div className="flex items-center gap-1 shrink-0">
                        {onCandidate && (
                            <button
                                type="button"
                                onClick={onCandidate}
                                title="问问角色这个怎么样"
                                className="px-1.5 py-0.5 rounded-md bg-white border border-[#DDD3BC] text-[#16386F] text-[10px] font-bold active:scale-95 transition-transform"
                            >💭 问 ta</button>
                        )}
                        {showStepper && (
                            <div className="flex items-center bg-white border border-[#DDD3BC] rounded-md overflow-hidden">
                                <button
                                    type="button"
                                    onClick={onSub}
                                    disabled={q <= 0}
                                    className={`w-6 h-6 flex items-center justify-center text-[14px] font-bold ${q <= 0 ? 'text-slate-300' : 'text-[#16386F] active:bg-[#F2ECDD]'}`}
                                >−</button>
                                <span className="min-w-[20px] text-center text-[11px] font-bold text-slate-700">{q}</span>
                                <button
                                    type="button"
                                    onClick={onAdd}
                                    className="w-6 h-6 flex items-center justify-center text-[14px] font-bold text-[#16386F] active:bg-[#F2ECDD]"
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
    const orderId = pickFirst<string>(data, ['orderIdStr', 'orderId', 'orderNo', 'id', 'orderSn', 'tradeNo', 'orderCode']);
    const total = pickFirst<any>(data, ['discountPrice', 'orderPayAmount', 'totalAmount', 'total', 'amount', 'payAmount', 'realPayAmount']);
    const status = pickFirst<string>(data, ['orderStatusName', 'status', 'statusText', 'state']);
    const takeCode = (data?.takeMealCodeInfo && pickFirst<string>(data.takeMealCodeInfo, ['code'])) || undefined;
    const address = pickFirst<string>(data?.shopInfo || data, ['address', 'deptName', 'deliveryAddress']);
    const payUrl = pickFirst<string>(data, ['payOrderUrl', 'payUrl', 'paymentUrl', 'cashierUrl', 'h5Url']);
    const qrUrl = pickFirst<string>(data, ['payOrderQrCodeUrl']);
    const items = findArray(data, ['orderCommodityList', 'productInfoList', 'items', 'goods', 'products', 'orderItems', 'goodsList']);
    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between">
                <span className="text-[10px] text-[#16386F]/70 font-bold uppercase">订单</span>
                {status && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[#F2ECDD] text-[#16386F] font-bold">{status}</span>}
            </div>
            {orderId && <div className="text-[11px] text-slate-500 font-mono">#{orderId}</div>}
            {address && <div className="text-[10px] text-slate-500 line-clamp-2">📍 {address}</div>}
            {items && items.length > 0 && (
                <div className="bg-white/70 rounded-lg overflow-hidden border border-[#EFE9DC]">
                    {items.slice(0, 5).map((it, i) => <MenuItemRow key={i} item={it} />)}
                    {items.length > 5 && <div className="text-[10px] text-slate-400 text-center py-1.5">还有 {items.length - 5} 项…</div>}
                </div>
            )}
            {total != null && (
                <div className="flex items-center justify-between border-t border-[#ECE6D8]/70 pt-1.5">
                    <span className="text-[11px] text-slate-600">合计</span>
                    <span className="text-[14px] font-bold text-[#16386F]">{fmtMoney(total)}</span>
                </div>
            )}
            {takeCode && takeCode !== '生成中' && (
                <div className="flex items-center justify-between bg-[#FAF7F0] rounded-lg px-2 py-1.5 border border-[#EFE9DC]">
                    <span className="text-[11px] text-slate-600">取餐码</span>
                    <span className="text-[15px] font-black tracking-widest text-[#B8860B]">{takeCode}</span>
                </div>
            )}
            {(payUrl || qrUrl) && (
                <div className="mt-1 flex flex-col items-center bg-white/60 rounded-lg p-2 border border-[#EFE9DC]">
                    <PayQr payUrl={payUrl} qrImageUrl={qrUrl} size={132} />
                </div>
            )}
        </div>
    );
};

// ========== 子卡片: 门店 ==========

const StoreList: React.FC<{ data: any }> = ({ data }) => {
    const stores = extractItems(data, ['stores', 'shops', 'restaurants', 'storeList', 'shopList', 'list', 'data', 'items']) || [];
    if (!stores.length) return null;
    return (
        <div className="space-y-1.5">
            <div className="text-[10px] text-[#16386F]/70 font-bold uppercase">附近门店</div>
            {stores.slice(0, 5).map((s, i) => {
                const name = pickFirst<string>(s, ['deptName', 'name', 'storeName', 'shopName']) || '瑞幸门店';
                const addr = pickFirst<string>(s, ['address', 'storeAddress', 'shopAddress']);
                // 瑞幸 distance 单位是千米 (number, 如 8.2038)
                const distance = pickFirst<any>(s, ['distance', 'distanceM']);
                return (
                    <div key={i} className="bg-white/70 rounded-lg p-2 border border-[#EFE9DC]">
                        <div className="flex items-center justify-between">
                            <div className="font-bold text-[12px] text-slate-800 truncate">{name}</div>
                            {distance != null && <div className="text-[10px] text-[#16386F] shrink-0 ml-2">📍 {typeof distance === 'number' ? `${distance.toFixed(1)}km` : distance}</div>}
                        </div>
                        {addr && <div className="text-[10px] text-slate-500 line-clamp-2 mt-0.5">{addr}</div>}
                    </div>
                );
            })}
            {stores.length > 5 && <div className="text-[10px] text-slate-400 text-center">还有 {stores.length - 5} 家门店…</div>}
        </div>
    );
};

// ========== 子卡片: 菜单列表 (可分页 + 可选购) ==========

const itemKey = (item: any, idx: number): string => {
    return String(item?.code || item?.productCode || item?.skuCode || item?.goodsCode || item?.id || `idx-${idx}`);
};

const itemToCart = (item: any): LuckinCartItem => ({
    code: pickFirst<string>(item, ['skuCode', 'code', 'productCode', 'goodsCode']),
    name: pickFirst<string>(item, ['name', 'productName', 'title', 'goodsName', 'commodityName', 'displayName']) || '瑞幸商品',
    price: pickFirst<any>(item, ['estimatePrice', 'currentPrice', 'price', 'salePrice', 'memberPrice', 'realPrice', 'sellPrice', 'initialPrice']),
    image: pickFirst<string>(item, ['pictureUrl', 'breviaryPicUrl', 'bigPicUrl', 'image', 'imageUrl', 'pic', 'picUrl', 'img', 'icon', 'thumbnail', 'productImage']),
    qty: 1,
});

const MenuList: React.FC<{ items: any[]; pageSize?: number; onSendCart?: (items: LuckinCartItem[]) => void; onCandidate?: (item: LuckinCartItem) => void }> = ({ items, pageSize = 6, onSendCart, onCandidate }) => {
    const [page, setPage] = useState(0);
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
        const out: LuckinCartItem[] = [];
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
        trackEvent('把瑞幸购物车发给角色');
    };

    return (
        <div>
            <div className="bg-white/70 rounded-lg overflow-hidden border border-[#EFE9DC]">
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
                    <div className="flex items-center justify-between gap-2 px-2 py-1.5 border-t border-[#EFE9DC] bg-[#FAF7F0]/60">
                        <button
                            type="button"
                            disabled={safePage === 0}
                            onClick={() => setPage(p => Math.max(0, p - 1))}
                            className={`w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold transition ${safePage === 0 ? 'text-slate-300' : 'text-[#16386F] active:bg-[#EFE9DC] active:scale-90'}`}
                        >‹</button>
                        <div className="text-[11px] text-[#0B1F3A] font-bold">
                            第 {safePage + 1} / {totalPages} 页
                            <span className="text-[9px] text-[#16386F]/60 font-normal ml-1.5">（共 {items.length} 项）</span>
                        </div>
                        <button
                            type="button"
                            disabled={safePage >= totalPages - 1}
                            onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                            className={`w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold transition ${safePage >= totalPages - 1 ? 'text-slate-300' : 'text-[#16386F] active:bg-[#EFE9DC] active:scale-90'}`}
                        >›</button>
                    </div>
                )}
            </div>
            {onSendCart && totalCount > 0 && (
                <div className="mt-2 flex items-center gap-2 bg-[#F2ECDD]/90 rounded-lg p-2 border border-[#DDD3BC]">
                    <div className="flex-1 min-w-0">
                        <div className="text-[10px] text-[#0B1F3A]/70">已选 {totalCount} 件</div>
                        {totalPrice > 0 && <div className="text-[14px] font-bold text-[#0B1F3A]">{fmtMoney(totalPrice)}</div>}
                    </div>
                    <button
                        type="button"
                        onClick={() => { setSelected({}); trackEvent('清空瑞幸购物车'); }}
                        className="text-[10px] text-[#16386F] px-2 py-1.5 active:scale-95"
                    >清空</button>
                    <button
                        type="button"
                        onClick={handleSend}
                        className="px-3 py-1.5 bg-[#0B1F3A] text-white text-[11px] font-bold rounded-lg shadow active:scale-95 transition-transform"
                    >发送给角色 →</button>
                </div>
            )}
        </div>
    );
};

// ========== 子卡片: 用户购物车 ==========

const CartCard: React.FC<{ items: LuckinCartItem[] }> = ({ items }) => {
    const total = items.reduce((sum, c) => {
        const p = typeof c.price === 'string' ? parseFloat(c.price) : (typeof c.price === 'number' ? c.price : 0);
        return sum + (isFinite(p) ? p * c.qty : 0);
    }, 0);
    const totalCount = items.reduce((s, c) => s + c.qty, 0);
    return (
        <div className="space-y-2">
            <div className="text-[10px] text-[#16386F]/80 font-bold uppercase">🛒 想要下单的内容</div>
            <div className="bg-white/80 rounded-lg overflow-hidden border border-[#E6DFCF]">
                {items.map((it, i) => (
                    <div key={i} className="flex items-center gap-2 p-2 border-b border-[#F4EFE4] last:border-b-0">
                        <div className="w-10 h-10 rounded-md bg-[#FAF7F0] overflow-hidden shrink-0 flex items-center justify-center">
                            {it.image ? <img src={it.image} alt="" className="w-full h-full object-cover" loading="lazy" referrerPolicy="no-referrer" onError={(e: any) => { e.target.style.display = 'none'; }} /> : <span className="text-lg">{luckinItemEmoji(it.name)}</span>}
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="font-bold text-[12px] text-slate-800 truncate">{it.name}</div>
                            {it.spec && <div className="text-[9px] text-slate-400 truncate">{it.spec}</div>}
                            {it.price != null && <div className="text-[10px] text-[#16386F]">{fmtMoney(it.price)}</div>}
                        </div>
                        <div className="text-[12px] font-bold text-[#16386F] shrink-0">×{it.qty}</div>
                    </div>
                ))}
            </div>
            <div className="flex items-center justify-between pt-1">
                <span className="text-[11px] text-slate-600">共 {totalCount} 件</span>
                {total > 0 && <span className="text-[15px] font-bold text-[#16386F]">{fmtMoney(total)}</span>}
            </div>
        </div>
    );
};

// ========== 子卡片: 单个商品 (switchProduct / queryProductDetailInfo 返回的单品 + 规格) ==========

const isSingleProduct = (d: any): boolean =>
    !!d && typeof d === 'object' && !Array.isArray(d) && !!d.skuCode && !!(d.productName || d.name);

const SingleProductCard: React.FC<{ data: any }> = ({ data }) => {
    const name = pickFirst<string>(data, ['productName', 'name']) || '瑞幸商品';
    const price = pickFirst<any>(data, ['estimatePrice', 'currentPrice', 'price']);
    const initPrice = pickFirst<any>(data, ['initialPrice', 'initPrice']);
    const image = pickFirst<string>(data, ['pictureUrl', 'breviaryPicUrl', 'bigPicUrl']);
    const attrs: any[] = Array.isArray(data.productAttrs) ? data.productAttrs : [];
    // 已选规格
    const selected: string[] = [];
    for (const g of attrs) {
        const sub = Array.isArray(g?.productSubAttrs) ? g.productSubAttrs.find((s: any) => s?.selected) : null;
        if (sub?.attributeName) selected.push(sub.attributeName);
    }
    return (
        <div className="space-y-2">
            <div className="text-[10px] text-[#16386F]/70 font-bold uppercase">已选规格</div>
            <div className="flex gap-2 bg-white/80 rounded-lg p-2 border border-[#EFE9DC]">
                <div className="w-12 h-12 rounded-md bg-[#FAF7F0] overflow-hidden shrink-0 flex items-center justify-center">
                    {image ? <img src={image} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" onError={(e: any) => { e.target.style.display = 'none'; }} /> : <span className="text-xl">{luckinItemEmoji(name)}</span>}
                </div>
                <div className="flex-1 min-w-0">
                    <div className="font-bold text-[12px] text-slate-800 truncate">{name}</div>
                    {selected.length > 0 && <div className="text-[10px] text-slate-500 truncate">{selected.join(' · ')}</div>}
                    {price != null && (
                        <div className="text-[12px] font-bold text-[#16386F]">
                            {fmtMoney(price)}
                            {initPrice != null && initPrice !== price && <span className="line-through text-slate-300 ml-1 text-[10px]">{fmtMoney(initPrice)}</span>}
                        </div>
                    )}
                </div>
            </div>
            {/* 各规格可选项 (供角色/用户参考) */}
            {attrs.map((g: any, gi: number) => (
                Array.isArray(g?.productSubAttrs) && g.productSubAttrs.length > 1 ? (
                    <div key={gi} className="text-[10px] text-slate-500">
                        <span className="text-slate-400">{g.attributeName}：</span>
                        {g.productSubAttrs.map((s: any) => s?.attributeName).filter(Boolean).join(' / ')}
                    </div>
                ) : null
            ))}
        </div>
    );
};

// ========== 子卡片: 收货地址 ==========

const AddressList: React.FC<{ data: any }> = ({ data }) => {
    const list = extractItems(data, ['addresses', 'addressList', 'list', 'data', 'items']) || [];
    if (!list.length) return null;
    return (
        <div className="space-y-1.5">
            <div className="text-[10px] text-[#16386F]/70 font-bold uppercase">📍 收货地址</div>
            {list.slice(0, 5).map((a, i) => {
                const name = pickFirst<string>(a, ['contactName', 'name', 'consignee', 'consigneeName']) || '收货人';
                const phone = pickFirst<string>(a, ['phone', 'mobile', 'tel', 'contactPhone', 'consigneePhone']);
                const addr = pickFirst<string>(a, ['fullAddress', 'address', 'detailAddress', 'consigneeAddress']);
                const tag = pickFirst<string>(a, ['tag', 'label', 'addressTag', 'addressType']);
                return (
                    <div key={i} className="bg-white/70 rounded-lg p-2 border border-[#EFE9DC]">
                        <div className="flex items-center justify-between">
                            <div className="font-bold text-[12px] text-slate-800 truncate">
                                {name}{phone && <span className="text-[10px] text-slate-500 font-normal ml-1.5">{phone}</span>}
                            </div>
                            {tag && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-[#F2ECDD] text-[#16386F] shrink-0 ml-1">{tag}</span>}
                        </div>
                        {addr && <div className="text-[10px] text-slate-500 line-clamp-2 mt-0.5">{addr}</div>}
                    </div>
                );
            })}
            {list.length > 5 && <div className="text-[10px] text-slate-400 text-center">还有 {list.length - 5} 条…</div>}
        </div>
    );
};

// ========== 子卡片: 优惠券/咖啡券 ==========

const CouponList: React.FC<{ data: any }> = ({ data }) => {
    const coupons = extractItems(data, ['coupons', 'vouchers', 'myCoupons', 'couponList', 'tickets', 'list', 'data', 'items']) || [];
    if (!coupons.length) return null;
    return (
        <div className="space-y-1.5">
            <div className="text-[10px] text-[#16386F]/70 font-bold uppercase">券</div>
            {coupons.slice(0, 6).map((c, i) => {
                const title = pickFirst<string>(c, ['title', 'name', 'couponName', 'goodsName']) || '瑞幸券';
                const value = pickFirst<any>(c, ['value', 'amount', 'discountAmount', 'price', 'points']);
                const expire = pickFirst<string>(c, ['expireDate', 'endTime', 'validTo', 'expireTime']);
                return (
                    <div key={i} className="flex items-center justify-between bg-white/70 rounded-lg p-2 border border-[#EFE9DC]">
                        <div className="min-w-0">
                            <div className="font-bold text-[12px] text-slate-800 truncate">🎟️ {title}</div>
                            {expire && <div className="text-[10px] text-slate-400">有效期至 {expire}</div>}
                        </div>
                        {value != null && <div className="text-[12px] font-bold text-[#16386F] shrink-0 ml-2">{typeof value === 'number' ? fmtMoney(value) : String(value)}</div>}
                    </div>
                );
            })}
        </div>
    );
};

// ========== 文本/长内容 ==========

const TextResultCard: React.FC<{ text: string; toolName: string }> = ({ text, toolName }) => {
    const [expanded, setExpanded] = useState(false);
    const preview = text.length > 240 ? text.slice(0, 240) + '…' : text;
    const isLong = text.length > 240;
    const label = /coupon|券/i.test(toolName) ? '优惠券文本'
        : /menu|product|商品|菜单/i.test(toolName) ? '菜单文本'
        : '文本结果';
    return (
        <div className="bg-white/80 rounded-lg border border-[#EFE9DC] p-2.5">
            <div className="text-[10px] text-[#16386F]/70 font-bold uppercase mb-1">{label}</div>
            <pre className={`text-[10px] text-slate-700 leading-snug font-mono whitespace-pre-wrap break-all ${expanded ? '' : 'max-h-40 overflow-hidden'}`}>{expanded ? text : preview}</pre>
            {isLong && (
                <button onClick={() => setExpanded(v => !v)} className="mt-1 text-[10px] text-[#16386F] active:scale-95">
                    {expanded ? '▲ 收起' : '▼ 展开全部'}
                </button>
            )}
        </div>
    );
};

// ========== 空信封 / 失败信封提示 ==========

const isLuckinEnvelope = (v: any): boolean => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const envKeys = ['success', 'code', 'message', 'datetime', 'traceId', 'msg', 'errorCode', 'errMsg'];
    const hits = envKeys.filter(k => k in v).length;
    return hits >= 2;
};

const EnvelopeNotice: React.FC<{ data: any }> = ({ data }) => {
    const ok = data?.success === true || data?.code === 200 || data?.code === '200' || data?.code === 0;
    const msg = data?.message || data?.msg || data?.errMsg || (ok ? '请求成功，但没有返回数据' : '请求失败');
    const code = data?.code ?? data?.errorCode;
    const traceId = data?.traceId;
    return (
        <div className={`rounded-lg border p-3 ${ok ? 'bg-[#FAF7F0]/70 border-[#E6DFCF]' : 'bg-red-50/60 border-red-200'}`}>
            <div className="flex items-start gap-2">
                <span className="text-xl shrink-0 leading-none mt-0.5">{ok ? 'ℹ️' : '⚠️'}</span>
                <div className="flex-1 min-w-0">
                    <div className={`font-bold text-[12px] ${ok ? 'text-[#16386F]' : 'text-red-600'}`}>{msg}</div>
                    {ok && (
                        <div className="text-[10px] text-[#16386F]/80 mt-1 leading-relaxed">
                            瑞幸没返回内容。常见原因: 该门店此时段不营业 / 不支持当前模式 / 参数不对 / 服务临时抖动。可以换个门店或让角色重试。
                        </div>
                    )}
                    {code != null && <div className="text-[9px] text-slate-400 font-mono mt-1">code: {String(code)}{traceId && ` · trace: ${String(traceId).slice(0, 8)}…`}</div>}
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
        <div className="bg-white/70 rounded-lg border-2 border-dashed border-[#DDD3BC]">
            <div className="px-2 pt-2 pb-1.5 flex items-center gap-1.5">
                <span className="text-[9px] px-1.5 py-0.5 bg-[#F2ECDD] text-[#16386F] rounded-full font-bold">⚠️ 未识别结构</span>
                <span className="text-[10px] text-slate-400 font-mono truncate">{toolName}</span>
            </div>
            <div className="px-2 pb-1.5 space-y-0.5 text-[10px] text-slate-600 font-mono leading-snug">
                <div><span className="text-slate-400">type:</span> {diag.kind}</div>
                {diag.keys && <div className="break-all"><span className="text-slate-400">keys:</span> {diag.keys}</div>}
                {diag.sample && <div className="break-all"><span className="text-slate-400">sample:</span> {diag.sample}</div>}
            </div>
            {fullJson && (
                <div className="flex items-center border-t border-[#ECE6D8]/70">
                    <button onClick={() => setExpanded(v => !v)} className="flex-1 text-left px-2 py-1 text-[10px] text-[#16386F] active:scale-[0.99]">
                        {expanded ? '▼ 收起原始' : '▶ 展开原始 JSON'}
                    </button>
                    <button
                        onClick={handleCopy}
                        className={`px-2.5 py-1 text-[10px] font-bold border-l border-[#ECE6D8]/70 active:scale-95 transition ${
                            copyState === 'ok' ? 'text-emerald-600' : copyState === 'err' ? 'text-red-500' : 'text-[#16386F]'
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

const LuckinCard: React.FC<LuckinCardProps> = ({ toolName, args, result, error, rawText, kind = 'generic', onSendCart, onCandidate, cartItems, candidateItem }) => {
    if (kind === 'cart' && cartItems && cartItems.length) {
        return (
            <div className="sully-chat-card-face w-72 rounded-2xl overflow-hidden border border-[#E6DFCF] shadow-sm bg-gradient-to-br from-[#FAF7F0] to-[#F2EEE3]">
                <div className="flex items-center gap-2 px-3 py-2 bg-gradient-to-r from-[#0B1F3A] to-[#1E4D8C]">
                    <span className="text-lg">🛒</span>
                    <div className="flex-1 min-w-0">
                        <div className="text-[11px] font-bold text-white">瑞幸咖啡</div>
                        <div className="text-[9px] text-white/70">想要下单</div>
                    </div>
                </div>
                <div className="p-3"><CartCard items={cartItems} /></div>
            </div>
        );
    }
    if (kind === 'candidate' && candidateItem) {
        return (
            <div className="sully-chat-card-face w-64 rounded-2xl overflow-hidden border border-[#E6DFCF] shadow-sm bg-gradient-to-br from-[#FAF7F0] to-[#F2EEE3]">
                <div className="flex items-center gap-2 px-3 py-2 bg-gradient-to-r from-[#0B1F3A] to-[#1E4D8C]">
                    <span className="text-lg">💭</span>
                    <div className="flex-1 min-w-0">
                        <div className="text-[11px] font-bold text-white">瑞幸咖啡</div>
                        <div className="text-[9px] text-white/70">想问问你的意见</div>
                    </div>
                </div>
                <div className="p-3 flex items-center gap-2">
                    <div className="w-12 h-12 rounded-md bg-[#FAF7F0] overflow-hidden shrink-0 flex items-center justify-center">
                        {candidateItem.image
                            ? <img src={candidateItem.image} alt="" className="w-full h-full object-cover" loading="lazy" referrerPolicy="no-referrer" onError={(e: any) => { e.target.style.display = 'none'; }} />
                            : <span className="text-xl">{luckinItemEmoji(candidateItem.name)}</span>}
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="font-bold text-[12px] text-slate-800 truncate">{candidateItem.name}</div>
                        {candidateItem.price != null && <div className="text-[11px] text-[#16386F]">{fmtMoney(candidateItem.price)}</div>}
                    </div>
                </div>
            </div>
        );
    }
    const isError = !!error;

    const specializedItems = useMemo(() => {
        if (!result) return null;
        if (kind === 'address') return extractItems(result, ['addresses', 'addressList', 'list', 'data', 'items']);
        if (kind === 'store') return extractItems(result, ['stores', 'shops', 'storeList', 'shopList', 'list', 'data', 'items']);
        if (kind === 'coupon') return extractItems(result, ['coupons', 'vouchers', 'myCoupons', 'couponList', 'tickets', 'list', 'data', 'items']);
        if (kind === 'menu' || kind === 'cart') return extractItems(result, ['items', 'products', 'goods', 'list', 'data', 'menu']);
        return null;
    }, [kind, result]);
    const specializedHasItems = !!(specializedItems && specializedItems.length && specializedItems.some(looksLikeNamedItem));

    const fallbackMenuItems = useMemo(() => {
        if (kind !== 'generic' || !result) return null;
        return extractItems(result, ['items', 'products', 'goods', 'list', 'data', 'menu', 'addresses', 'stores']);
    }, [kind, result]);
    const fallbackMenuHasItems = !!(fallbackMenuItems && fallbackMenuItems.length && fallbackMenuItems.some(looksLikeNamedItem));

    const effectiveKind: LuckinCardProps['kind'] = useMemo(() => {
        if (kind === 'order') return 'order';
        if (kind && kind !== 'generic' && specializedHasItems) return kind;
        if (fallbackMenuHasItems) return 'menu';
        return 'generic';
    }, [kind, specializedHasItems, fallbackMenuHasItems]);

    const menuItems = (kind === 'menu' || kind === 'cart') ? specializedItems : fallbackMenuItems;
    const itemsHaveDisplayFields = effectiveKind === 'menu' && (specializedHasItems || fallbackMenuHasItems);

    return (
        <div className="sully-chat-card-face w-72 rounded-2xl overflow-hidden border border-[#E6DFCF] shadow-sm bg-gradient-to-br from-[#FAF7F0] to-[#F2EEE3]">
            {/* 头部: 瑞幸蓝条 */}
            <div className="flex items-center gap-2 px-3 py-2 bg-gradient-to-r from-[#0B1F3A] to-[#1E4D8C]">
                <span className="text-lg">🦌</span>
                <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-bold text-white">瑞幸咖啡</div>
                    <div className="text-[9px] text-white/70 font-mono truncate">{toolName}</div>
                </div>
                {isError ? (
                    <span className="text-[9px] px-1.5 py-0.5 bg-red-100 text-red-600 rounded-full font-bold">失败</span>
                ) : (
                    <span className="text-[9px] px-1.5 py-0.5 bg-white/80 text-[#0B1F3A] rounded-full font-bold">已返回</span>
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
                        {isSingleProduct(result) ? (
                            <SingleProductCard data={result} />
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
                        ) : isLuckinEnvelope(result) ? (
                            <EnvelopeNotice data={result} />
                        ) : (
                            <UnrecognizedDiag data={result} rawText={rawText} toolName={toolName} />
                        )}
                    </>
                )}
                {!isError && args && Object.keys(args).length > 0 && (
                    <details className="text-[9px] text-slate-400 font-mono">
                        <summary className="cursor-pointer truncate select-none active:text-[#16386F]">
                            参数: {Object.keys(args).join(', ')}
                        </summary>
                        <pre className="text-[10px] text-slate-600 mt-1 px-1 py-1 bg-slate-50/80 rounded overflow-auto max-h-40 whitespace-pre-wrap break-all">{(() => { try { return JSON.stringify(args, null, 2); } catch { return String(args); } })()}</pre>
                    </details>
                )}
            </div>
        </div>
    );
};

export default LuckinCard;
