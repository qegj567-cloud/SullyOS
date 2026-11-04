import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import FriendFeedImageCards from '../../apps/FriendFeedImageCards';
import '../../apps/friendFeed.css';
import '../../apps/friendFeedClassicThemes.css';
import '../../apps/friendFeedSocialThemes.css';
const themes=[['island','森间手记'],['moments','朋友圈'],['insta','照片墙'],['journal','杂志'],['weibo','微博'],['twitter','推特']];
const samples=[{caption:'把下午留在杯子里',description:'半杯冰水放在旧木窗台上，杯壁挂着细细的水珠。斜照进来的阳光穿过玻璃，把一小块晃动的亮斑投在桌面。窗外的树叶很近，最边上还挤进了一只猫的耳朵。'},
    {caption:'另一位摄影助理',description:'一只橘猫趴在窗边，爪子搭着杯垫，正盯着桌上移动的光点。照片的下半截有点歪，还拍进了相机背带。'},
    {caption:'一直等到天快黑的时候才想起那杯水还放在窗台上',description:'玻璃杯里的冰已经化了。窗外是深蓝的天，楼下有人刚把路灯点亮。木桌的纹路在灯光里更清楚了。'.repeat(5)}];
function Preview(){const [theme,setTheme]=useState('all'),[multiple,setMultiple]=useState(false);return <>
    <style>{`*{box-sizing:border-box}body{margin:0;background:#e7eae4;font-family:system-ui,sans-serif;color:#35443a}.preview-switch{max-width:1240px;margin:26px auto 20px;padding:0 20px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;font-size:13px}.preview-switch select{border:0;background:#fff;padding:8px 12px;border-radius:8px;color:inherit}.preview-switch label{display:flex;gap:7px;align-items:center}.preview-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));align-items:start;gap:24px;max-width:1240px;padding:0 20px 32px;margin:auto}.preview-grid.single{max-width:460px;grid-template-columns:minmax(0,1fr)}.preview-cell{min-width:0}.preview-cell>h2{font-size:12px;letter-spacing:.08em;font-weight:500;margin:0 0 12px 4px}.preview-phone{border-radius:18px;overflow:hidden}.preview-phone>.friend-feed{height:auto;min-height:0;padding:20px;background:var(--ff-paper)}.preview-author{display:flex;gap:10px;align-items:center;margin:2px 0 18px}.preview-avatar{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;background:var(--ff-bg);color:var(--ff-accent)}.preview-author strong{font-size:13px;display:block}.preview-author small{font-size:10px;color:var(--ff-muted)}.preview-body{font-size:13px;line-height:1.8;color:var(--ff-ink);margin:0 0 6px}.preview-footer{max-width:1240px;margin:0 auto 24px;padding:0 20px;font-size:11px;color:#657268}@media(max-width:460px){.preview-grid{padding-inline:12px}.preview-switch{margin:16px auto}}`}</style>
    <div className="preview-switch"><span>哔哔 · 配图</span><label><input type="checkbox" checked={multiple} onChange={e=>setMultiple(e.target.checked)}/>三张配图 / 长文本</label><select aria-label="切换主题" value={theme} onChange={e=>setTheme(e.target.value)}><option value="all">六款对照</option>{themes.map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></div>
    <main className={`preview-grid ${theme==='all'?'':'single'}`}>{themes.filter(([id])=>theme==='all'||id===theme).map(([id,name])=><section className="preview-cell" key={id}>
        <h2>{name}</h2><div className="preview-phone"><section className="friend-feed" data-theme={id}>
            <header className="preview-author"><span className="preview-avatar">青</span><div><strong>青柠</strong><small>刚刚 · 随手记一张</small></div></header>
            <p className="preview-body">本来只想喝口水，结果在窗边站了好久。</p>
            <FriendFeedImageCards cards={multiple?samples:samples.slice(0,1)}/>
        </section></div></section>)}</main>
    <footer className="preview-footer">点击配图展开 / 收起 · 纯示例，不保存、不调用 API</footer>
    </>}
const root=createRoot(document.getElementById('root')!);root.render(<Preview/>);if(import.meta.hot)import.meta.hot.dispose(()=>root.unmount());
