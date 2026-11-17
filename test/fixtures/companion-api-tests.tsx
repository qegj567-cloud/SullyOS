import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CompanionApiTest } from '../../components/companion/CompanionApiTest';
import { companionTestVideo } from '../../utils/companion/testMedia';
import '../../apps/companion.css';

function Fixture() {
  const current = useRef<() => void>(), url = useRef('');
  const [video, setVideo] = useState(''), [info, setInfo] = useState('');
  const begin = (cancel: () => void) => { current.current?.(); current.current = cancel; };
  useEffect(() => () => { current.current?.(); if (url.current) URL.revokeObjectURL(url.current); }, []);
  return <main className="companion-setup" style={{ position: 'relative', maxWidth: 460, minHeight: '100vh', margin: 'auto' }}>
    <header><div><h2>API 测试组件验收</h2><p>模拟结果，不代表真实服务可用；不读取存档或调用模型。</p></div></header>
    <div className="companion-setup-content">
      <CompanionApiTest label="模拟成功" description="固定模拟回复，检查成功状态。" config={{}} begin={begin} run={async () => ({ summary: '模拟接口已回复', detail: '这是固定的界面验收文本。' })}/>
      <CompanionApiTest label="模拟鉴权错误" description="检查错误提示与 Key 隐藏。" config={{ apiKey: 'fixture-secret' }} begin={begin} run={async () => { throw new Error('HTTP 401 fixture-secret'); }}/>
      <CompanionApiTest label="模拟等待" description="检查耗时与取消；切到其他测试也会取消。" config={{}} begin={begin} run={signal => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new DOMException('已取消', 'AbortError')), { once: true }); })}/>
      <CompanionApiTest label="验证视频样片" description="真实生成本地图形 MP4，检查是否可解码；不使用摄像头，不上传。" config={{}} begin={begin} run={async signal => {
        const clip = await companionTestVideo(signal); signal.throwIfAborted();
        if (url.current) URL.revokeObjectURL(url.current);
        url.current = URL.createObjectURL(clip.blob); setVideo(url.current); setInfo('等待解码');
        return { summary: '本地样片已生成', detail: `${clip.blob.type} · ${clip.blob.size} 字节` };
      }}/>
      {video && <><video aria-label="生成的测试样片" controls muted autoPlay loop src={video} style={{ width: '100%' }}
        onLoadedMetadata={event => { const v = event.currentTarget; setInfo(`可解码：${v.videoWidth} × ${v.videoHeight}，${v.duration.toFixed(2)} 秒`); }}/><p role="status">{info}</p></>}
    </div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
