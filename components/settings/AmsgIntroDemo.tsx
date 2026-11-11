import React from 'react';

// 一轮 10 秒：聊天 → 把 App 划掉 → 空桌面 → 通知落下来。四句说明跟着同一条时间轴换。
const DEMO_CSS = `
.amsg-demo{display:flex;flex-direction:column;align-items:center;gap:10px}
.amsg-demo-phone{position:relative;width:132px;height:204px;border-radius:26px;background:#0f172a;padding:6px;box-shadow:0 10px 24px rgba(15,23,42,.18)}
.amsg-demo-screen{position:relative;width:100%;height:100%;border-radius:20px;overflow:hidden;background:linear-gradient(160deg,#ddd6fe,#e0f2fe)}
.amsg-demo-clock{position:absolute;top:52px;left:0;right:0;text-align:center;font-size:26px;font-weight:700;color:#fff;text-shadow:0 1px 6px rgba(76,29,149,.35)}
.amsg-demo-app{position:absolute;inset:0;background:#fff;display:flex;flex-direction:column;gap:6px;padding-bottom:8px;animation:amsg-demo-app 10s infinite}
.amsg-demo-bar{padding:9px 0 7px;text-align:center;font-size:10px;font-weight:700;color:#334155;border-bottom:1px solid #f1f5f9}
.amsg-demo-bubble{max-width:74%;margin:0 8px;padding:5px 8px;border-radius:10px;font-size:9px;line-height:1.4}
.amsg-demo-them{align-self:flex-start;background:#f1f5f9;color:#334155}
.amsg-demo-me{align-self:flex-end;background:#8b5cf6;color:#fff}
.amsg-demo-banner{position:absolute;top:8px;left:6px;right:6px;display:flex;align-items:center;gap:6px;padding:7px 8px;border-radius:12px;background:rgba(255,255,255,.96);box-shadow:0 4px 12px rgba(15,23,42,.18);animation:amsg-demo-banner 10s infinite}
.amsg-demo-avatar{flex:none;width:18px;height:18px;border-radius:6px;background:linear-gradient(135deg,#a78bfa,#f0abfc)}
.amsg-demo-banner div{min-width:0}
.amsg-demo-banner b{display:block;font-size:9px;color:#1e293b}
.amsg-demo-banner span{display:block;font-size:8.5px;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.amsg-demo-captions{position:relative;width:100%;height:18px}
.amsg-demo-captions span{position:absolute;inset:0;text-align:center;font-size:12px;font-weight:700;color:#6d28d9;opacity:0;animation:10s infinite}
.amsg-demo-captions span:nth-child(1){animation-name:amsg-demo-c1}
.amsg-demo-captions span:nth-child(2){animation-name:amsg-demo-c2}
.amsg-demo-captions span:nth-child(3){animation-name:amsg-demo-c3}
.amsg-demo-captions span:nth-child(4){animation-name:amsg-demo-c4}
@keyframes amsg-demo-app{0%,20%{transform:none;opacity:1;border-radius:0}28%{transform:scale(.8);opacity:1;border-radius:14px}36%,92%{transform:translateY(-125%) scale(.8);opacity:0;border-radius:14px}93%{transform:none;opacity:0;border-radius:0}100%{transform:none;opacity:1;border-radius:0}}
@keyframes amsg-demo-banner{0%,58%{transform:translateY(-150%);opacity:0}64%,90%{transform:none;opacity:1}95%,100%{transform:translateY(-150%);opacity:0}}
@keyframes amsg-demo-c1{0%,18%{opacity:1}21%,97%{opacity:0}100%{opacity:1}}
@keyframes amsg-demo-c2{0%,21%{opacity:0}24%,38%{opacity:1}41%,100%{opacity:0}}
@keyframes amsg-demo-c3{0%,41%{opacity:0}44%,58%{opacity:1}61%,100%{opacity:0}}
@keyframes amsg-demo-c4{0%,61%{opacity:0}64%,92%{opacity:1}95%,100%{opacity:0}}
@media(prefers-reduced-motion:reduce){
.amsg-demo-app,.amsg-demo-banner,.amsg-demo-captions span{animation:none}
.amsg-demo-app{opacity:0}
.amsg-demo-captions span:nth-child(4){opacity:1}
}`;

/** 引导第一屏的演示：App 被杀后台之后，TA 的消息照样弹到桌面上。纯 CSS 循环，不读任何数据。 */
const AmsgIntroDemo: React.FC = () => (
  <div className="amsg-demo" role="img" aria-label="演示：把 App 杀后台之后，手机仍然收到 TA 发来的通知">
    <style>{DEMO_CSS}</style>
    <div className="amsg-demo-phone" aria-hidden="true">
      <div className="amsg-demo-screen">
        <div className="amsg-demo-clock">23:41</div>
        <div className="amsg-demo-app">
          <div className="amsg-demo-bar">TA</div>
          <div className="amsg-demo-bubble amsg-demo-them">今天累不累？</div>
          <div className="amsg-demo-bubble amsg-demo-me">有点，先去洗澡啦</div>
          <div className="amsg-demo-bubble amsg-demo-them">去吧，洗完早点睡</div>
        </div>
        <div className="amsg-demo-banner">
          <i className="amsg-demo-avatar" />
          <div>
            <b>TA</b>
            <span>睡了吗？下雨了</span>
          </div>
        </div>
      </div>
    </div>
    <div className="amsg-demo-captions" aria-hidden="true">
      <span>平时，开着 App 才聊得起来</span>
      <span>你把 App 杀后台了</span>
      <span>云端后台替 TA 把话写好</span>
      <span>通知照样送到你手机上</span>
    </div>
  </div>
);

export default AmsgIntroDemo;
