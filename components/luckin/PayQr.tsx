import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/**
 * 瑞幸支付二维码
 *
 * createOrder 返回:
 *  - payOrderUrl: weixin://wxpay/bizpayurl?pr=xxx  (微信支付 code-url, 扫码即付)
 *  - payOrderQrCodeUrl: https://.../transfer/qrcode?token=xxx (瑞幸托管的二维码链接)
 *
 * 浏览器里点 weixin:// 拉不起微信, 所以这里**本地把 payOrderUrl 生成二维码**,
 * 用户用微信扫一下就付了, 不用回瑞幸 app。
 * 兜底: 本地生成失败时退回瑞幸官方托管二维码图; 移动端额外给一个"点我用微信打开"。
 */
const PayQr: React.FC<{ payUrl?: string; qrImageUrl?: string; size?: number }> = ({ payUrl, qrImageUrl, size = 168 }) => {
    const [dataUrl, setDataUrl] = useState<string>('');
    const [genFailed, setGenFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        if (!payUrl) { setDataUrl(''); return; }
        QRCode.toDataURL(payUrl, { width: size * 2, margin: 1, errorCorrectionLevel: 'M' })
            .then((url) => { if (!cancelled) { setDataUrl(url); setGenFailed(false); } })
            .catch(() => { if (!cancelled) setGenFailed(true); });
        return () => { cancelled = true; };
    }, [payUrl, size]);

    // 优先本地生成的码; 没有 payUrl 或生成失败时退回官方托管二维码图
    const imgSrc = (!genFailed && dataUrl) ? dataUrl : (qrImageUrl || '');
    if (!imgSrc) {
        // 实在没码: 退回一个跳转链接 (移动端有效)
        if (payUrl || qrImageUrl) {
            return (
                <a href={payUrl || qrImageUrl} target="_blank" rel="noreferrer"
                    className="block text-center px-3 py-2 bg-[#0B1F3A] text-white text-[12px] font-bold rounded-xl active:scale-95">
                    去微信支付 →
                </a>
            );
        }
        return null;
    }

    return (
        <div className="flex flex-col items-center gap-1.5">
            <div className="sully-chat-qr-surface bg-white p-2 rounded-xl border border-[#E6DFCF]" style={{ width: size + 16, height: size + 16 }}>
                <img src={imgSrc} alt="支付二维码" className="w-full h-full object-contain" referrerPolicy="no-referrer"
                    onError={() => { if (dataUrl && imgSrc !== dataUrl) { /* already on fallback */ } else if (qrImageUrl) setGenFailed(true); }} />
            </div>
            <div className="text-[11px] text-[#0B1F3A]/70 font-bold">微信扫码支付</div>
            {payUrl && (
                <a href={payUrl} target="_blank" rel="noreferrer" className="text-[10px] text-[#16386F] underline">手机上点这里直接用微信打开</a>
            )}
        </div>
    );
};

export default PayQr;
