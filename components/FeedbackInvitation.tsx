import React, { useEffect, useRef, useState } from 'react';
import { claimFeedbackInvitation, FEEDBACK_INVITATION_EVENT, hasPendingFeedbackInvitation, recordFeedbackVisit } from '../utils/feedbackInvitation';
import './FeedbackInvitation.css';
import wechatCode from '../assets/sully-support/wechat-sully-code.png';

export default function FeedbackInvitation({ ready, blocked }: { ready: boolean; blocked: boolean }) {
    const [open, setOpen] = useState(false);

    useEffect(() => {
        if (!ready || open || !hasPendingFeedbackInvitation()) return;
        const visit = () => { if (document.visibilityState === 'visible') recordFeedbackVisit(); };
        visit();
        document.addEventListener('visibilitychange', visit);
        const timer = window.setInterval(visit, 60_000);
        return () => { document.removeEventListener('visibilitychange', visit); window.clearInterval(timer); };
    }, [ready, open]);

    useEffect(() => {
        if (!ready || blocked || open || !hasPendingFeedbackInvitation()) return;
        // 先让启动公告和备份提醒完成状态更新，不与其他弹窗抢同一帧。
        const check = async () => {
            const claim = () => {
                if (cancelled || document.visibilityState !== 'visible') return;
                recordFeedbackVisit();
                if (claimFeedbackInvitation()) setOpen(true);
            };
            try {
                if (navigator.locks) await navigator.locks.request('sully-feedback-invitation', claim);
                else claim();
            } catch { /* 无法取得展示锁时宁可不弹。 */ }
        };
        let cancelled = false;
        const timer = window.setTimeout(() => { void check(); }, 1500);
        const interval = window.setInterval(() => { void check(); }, 60_000);
        document.addEventListener('visibilitychange', check);
        return () => {
            cancelled = true;
            window.clearTimeout(timer); window.clearInterval(interval);
            document.removeEventListener('visibilitychange', check);
        };
    }, [ready, blocked, open]);

    useEffect(() => {
        const suppress = () => setOpen(false);
        window.addEventListener(FEEDBACK_INVITATION_EVENT, suppress);
        return () => window.removeEventListener(FEEDBACK_INVITATION_EVENT, suppress);
    }, []);

    if (!open || blocked || !ready) return null;
    return <FeedbackInvitationDialog onClose={() => setOpen(false)} />;
}

/** 独立展示组件，预览与正式弹窗共用，不在预览中修改邀请资格。 */
export function FeedbackInvitationDialog({ onClose }: { onClose: () => void }) {
    const button = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        const previous = document.activeElement as HTMLElement | null;
        button.current?.focus();
        return () => { if (previous?.isConnected) previous.focus(); };
    }, []);

    return (
        <div className="sully-repo-overlay">
            <div className="sully-repo-backdrop" onClick={onClose} />
            <section role="dialog" aria-modal="true" aria-labelledby="feedback-invitation-title" aria-describedby="feedback-invitation-body"
                className="sully-repo-letter"
                onKeyDown={event => {
                    if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
                    if (event.key === 'Tab') { event.preventDefault(); button.current?.focus(); }
                }}>
                <div className="sully-repo-tape" aria-hidden="true" />
                <div className="sully-repo-scroll">
                    <header className="sully-repo-topline"><span>糯米机 · 作者来信</span><span aria-hidden="true">一张小纸条 ↗</span></header>
                    <div className="sully-repo-hero">
                        <div>
                            <span className="sully-repo-aside">（悄悄探头）</span>
                            <h2 id="feedback-invitation-title">想蹲一份<br /><span>你的 repo</span><i aria-hidden="true">！</i></h2>
                        </div>
                        <svg className="sully-repo-cat" viewBox="0 0 132 152" fill="none" aria-hidden="true">
                            <path d="M18 78 22 32 43 43Q63 33 84 44L108 26 113 79Q117 108 68 112 20 111 18 78Z" fill="#302d35" stroke="#242129" strokeWidth="2.6" strokeLinejoin="round" />
                            <path d="m27 40 4 17 11-9m58-11-11 14 12 4" stroke="#b4a2d2" strokeWidth="3.6" strokeLinecap="round" />
                            <path d="m43 66 6 2m37-5-6 4" stroke="#f7e9bb" strokeWidth="4" strokeLinecap="round" />
                            <path d="m61 73 5 3 5-4m-5 4v6m0-1q-7 7-12 0m12 0q7 6 12-1" stroke="#e3d6ec" strokeWidth="2" strokeLinecap="round" />
                            <ellipse cx="37" cy="78" rx="8" ry="4" fill="#796583" /><ellipse cx="94" cy="76" rx="8" ry="4" fill="#796583" />
                            <path d="m14 68-9-3m10 12-10 3m110-14 10-5m-9 15 11 1" stroke="#484139" strokeWidth="1.8" strokeLinecap="round" />
                            <path d="m19 103 90-8 4 43-91 8Z" fill="#dcd0ec" stroke="#484139" strokeWidth="2.2" strokeLinejoin="round" />
                            <path d="m25 104 43 21 37-29" stroke="#86729c" strokeWidth="1.7" strokeLinejoin="round" />
                            <path d="M29 107q-14 6-13-5 2-9 14-5m65 2q13-9 16 1 3 9-11 10" fill="#302d35" stroke="#242129" strokeWidth="2.3" strokeLinecap="round" />
                            <path d="M69 112c-9-9-15 2-2 10 15-7 13-18 2-10Z" fill="#86729c" />
                            <path d="m110 10 3 5 6 1-5 4v6l-5-4-6 1 3-6-2-5Z" fill="#c6b5de" />
                        </svg>
                    </div>
                    <div id="feedback-invitation-body" className="sully-repo-copy">
                        <p>你的小手机里，最近发生了什么？</p>
                        <p>欢迎在 <strong>小红书 / DC 社区</strong> 晒晒使用体验。喜欢的小功能、和角色发生的趣事，都想看看！几句话、几张图就很好。</p>
                        <div className="sully-repo-note">
                            <span className="sully-repo-note-label">作者的更新动力</span>
                            <p>原来真的有人在玩<br />我做的小手机啊 <span aria-hidden="true">:)</span></p>
                            <span className="sully-repo-note-star" aria-hidden="true">✳</span>
                        </div>
                        <p className="sully-repo-closing">糯米机是免费项目。你愿意分享的每一份真实 repo，都是让我继续更新的一点动力。</p>
                        <section className="sully-repo-support" aria-label="打赏 Sully">
                            <h3>也可以打赏 Sully</h3>
                            <p>用于项目的更新与维护。按心意与余力，完全自愿，不影响正常使用。</p>
                            <img src={wechatCode} alt="Sully 的微信赞赏码" width="168" height="168" loading="lazy" />
                            <span>长按保存图片，用微信扫一扫</span>
                        </section>
                    </div>
                    <div className="sully-repo-signoff"><span>谢谢你来玩，故事还在继续。</span><span>— 作者留</span></div>
                </div>
                <button ref={button} type="button" onClick={onClose} className="sully-repo-button">我知道了</button>
            </section>
        </div>
    );
}
