import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight } from '@phosphor-icons/react';
import type { APIConfig, CharacterProfile, CompanionVideoApiConfig, TtsProvider } from '../../types';
import { resolveDialogueApi } from '../../utils/characterApi';
import { isVisionApiReady } from '../../utils/visionApi';
import { canSynthesizeSpeech, characterHasVoice } from '../../utils/ttsRouter';
import { resolveTtsProvider } from '../../utils/ttsProvider';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import { COMPANION_SETUP_LINKS as links, COMPANION_VOICE_GUIDES, companionDialogueReady, type CompanionSetupTarget } from '../../utils/companion/setup';
import { companionVideoReady, type CompanionImageMode } from '../../utils/companion/vision';
import { normalizeApiBaseUrl, normalizeApiCredential, normalizeApiModel } from '../../utils/apiConfigNormalize';
import { COMPANION_VIDEO_PROVIDERS, type CompanionVideoProvider } from '../../utils/companion/videoProviders';
import { clipUploadBase } from '../../utils/companion/videoUpload';
import uploadWorkerSource from '../../worker/companion-video/index.js?raw';

function VideoApiFields({ config, save }: { config?: CompanionVideoApiConfig; save?: (config: CompanionVideoApiConfig) => void }) {
  const [provider, setProvider] = useState<CompanionVideoProvider>(config ? config.provider ?? 'custom' : 'doubao');
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? COMPANION_VIDEO_PROVIDERS.doubao.baseUrl);
  const [model, setModel] = useState(config?.model ?? COMPANION_VIDEO_PROVIDERS.doubao.model);
  const [key, setKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [message, setMessage] = useState('');
  const [uploadBase, setUploadBase] = useState(config?.upload?.baseUrl ?? '');
  const [uploadToken, setUploadToken] = useState('');
  const [clearUploadToken, setClearUploadToken] = useState(false);
  const guide = COMPANION_VIDEO_PROVIDERS[provider];
  const sameEndpoint = normalizeApiBaseUrl(baseUrl) === config?.baseUrl && provider === (config?.provider ?? 'custom');
  const retainedUploadToken = !clearUploadToken && provider === config?.provider && uploadBase.trim().replace(/\/+$/, '') === config?.upload?.baseUrl ? config?.upload?.token ?? '' : '';
  return <form className="companion-video-fields" onSubmit={event => {
    event.preventDefault();
    if (!save) return;
    const url = normalizeApiBaseUrl(baseUrl);
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('请填写有效的 HTTP(S) Base URL');
      const normalizedModel = normalizeApiModel(model);
      if (!normalizedModel) throw new Error('请填写支持视频输入的模型 ID');
      let upload: CompanionVideoApiConfig['upload'];
      if (provider === 'zhipu') {
        if (!uploadBase.trim()) throw new Error('智谱需配置临时视频上传服务，见下方部署指引');
        const token = normalizeApiCredential(uploadToken) || retainedUploadToken;
        if (!token) throw new Error('请填写临时上传口令，与智谱 API Key 分开');
        upload = { baseUrl: clipUploadBase(uploadBase), token };
      }
      save({ provider, baseUrl: url, model: normalizedModel, apiKey: normalizeApiCredential(key) || (!clearKey && sameEndpoint ? config?.apiKey ?? '' : ''), ...(upload ? { upload } : {}) });
      setKey(''); setUploadToken(''); setClearKey(false); setClearUploadToken(false); setMessage('已保存。返回同行开启镜头后，才会录制并发送视频。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败'); }
  }}>
    <label className="companion-setup-provider">视频服务商<select aria-label="视频服务商" value={provider} onChange={event => {
      const next = event.target.value as CompanionVideoProvider;
      setProvider(next); setBaseUrl(COMPANION_VIDEO_PROVIDERS[next].baseUrl); setModel(COMPANION_VIDEO_PROVIDERS[next].model);
      setKey(''); setClearKey(true); setUploadBase(''); setUploadToken(''); setClearUploadToken(true); setMessage('已切换草稿，请填写对应凭据并保存。');
    }}>{Object.entries(COMPANION_VIDEO_PROVIDERS).map(([id, item]) => <option key={id} value={id}>{item.name}</option>)}</select></label>
    <p>{guide.note}</p>
    <div className="companion-setup-links"><ExternalLink href={guide.signup}>注册 / 登录{guide.name}</ExternalLink><ExternalLink href={guide.keys}>获取视频模型 Key</ExternalLink><ExternalLink href={guide.docs}>视频输入文档</ExternalLink></div>
    <label>视频 API Base URL<input aria-label="视频 API Base URL" type="url" required value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="填写平台的 OpenAI 兼容地址"/></label>
    <label>视频模型 ID<input aria-label="视频模型 ID" required value={model} onChange={event => setModel(event.target.value)} placeholder="账号已开通的视频理解模型"/></label>
    <label>视频 API Key<input aria-label="视频 API Key" type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} placeholder={config?.apiKey && sameEndpoint && !clearKey ? '已保存，留空保留原 Key' : '粘贴 Key；无 Key 代理可留空'}/></label>
    {config?.apiKey && <label className="companion-image-choice"><input type="checkbox" checked={clearKey} onChange={event => setClearKey(event.target.checked)}/>保存时移除旧 Key</label>}
    <small>只用于同行视频理解。切换服务商或修改地址时不会复用旧 Key；请同时填写对应凭据。模型 ID 可修改，需选支持视频输入的型号。配置保存在本机，随系统配置备份。</small>
    {provider === 'zhipu' && <>
      <p>录像先上传到你配置的临时存储，再由智谱读取。示例服务的链接 120 秒到期，请求结束后尝试删除；断网遗留由定时任务清理。未配置时不能开启镜头。</p>
      <label>临时上传服务地址<input aria-label="临时上传服务地址" type="url" required value={uploadBase} onChange={event => setUploadBase(event.target.value)} placeholder="https://your-video-worker.workers.dev"/></label>
      <label>临时上传口令<input aria-label="临时上传口令" type="password" autoComplete="off" value={uploadToken} onChange={event => setUploadToken(event.target.value)} placeholder={retainedUploadToken ? '已保存，留空保留原口令' : '自建服务的 UPLOAD_TOKEN，不是模型 Key'}/></label>
      {config?.upload?.token && <label className="companion-image-choice"><input type="checkbox" checked={clearUploadToken} onChange={event => setClearUploadToken(event.target.checked)}/>保存时移除旧上传口令（需填写新口令）</label>}
      <details><summary>部署智谱所需的临时上传服务</summary>
        <ol><li>在自己的 Cloudflare 账号创建私有 R2 bucket 和独立 Worker，粘贴下方下载的代码；不打开 bucket 公共访问。</li>
          <li>给 Worker 绑定 R2，变量名 CLIPS；设置 Secret UPLOAD_TOKEN（至少 32 位随机字符）。模型 Key 不填到 Worker。</li>
          <li>设置 ALLOWED_ORIGINS 为本站 origin：<code>{window.location.origin}</code>；多个 origin 用逗号分隔。关闭请求日志采集。</li>
          <li>添加 Cron Trigger：<code>*/5 * * * *</code>，清理过期录像。建议给 companion-clips/ 前缀另设 1 天 R2 生命周期兜底。</li>
          <li>将 Worker 的 HTTPS 根地址和上传口令填到上方并保存。它只暂存视频，不转发模型请求；R2 / Workers 可能产生用量费用。</li></ol>
        <p>临时链接有效期间，知道完整链接的人也可读取。客户端删除不成功时，到期仍会拒绝读取；物理文件由下一次定时清理删除。</p>
        <div className="companion-setup-links"><ExternalLink href="https://dash.cloudflare.com/">注册 / 登录 Cloudflare</ExternalLink><ExternalLink href="https://developers.cloudflare.com/r2/api/workers/workers-api-usage/">R2 绑定指引</ExternalLink></div>
        <button type="button" onClick={() => {
          const url = URL.createObjectURL(new Blob([uploadWorkerSource], { type: 'text/javascript' }));
          const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'companion-video-worker.js'; anchor.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}>下载独立上传 Worker</button>
      </details>
    </>}
    <div className="companion-setup-actions"><button type="submit" disabled={!save}>保存视频 API</button></div>
    {!save && <small>模拟页不保存真实 API，请在主应用的同行中配置。</small>}
    {message && <p role="status">{message}</p>}
  </form>;
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <a href={href} target="_blank" rel="noopener noreferrer">{children}<ArrowUpRight size={13} aria-hidden="true"/></a>;
}

function CopyValue({ label, value }: { label: string; value: string }) {
  const [message, setMessage] = useState('');
  return <div className="companion-setup-value"><span>{label}</span><code>{value}</code>
    <button type="button" onClick={async () => {
      try { await navigator.clipboard.writeText(value); setMessage('已复制'); }
      catch { setMessage('复制失败，可选中复制'); }
    }}>复制{label}</button><small role="status">{message}</small>
  </div>;
}

export function CompanionSetupGuide({ char, api, canListen, close, navigate, saveVideoApi, imageMode = 'none', changeImageMode }: {
  char?: CharacterProfile; api: APIConfig; canListen: boolean; close(): void; navigate(target: CompanionSetupTarget): void;
  saveVideoApi?: (config: CompanionVideoApiConfig) => void;
  imageMode?: CompanionImageMode; changeImageMode?: (mode: CompanionImageMode) => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const currentVoice = resolveTtsProvider(api);
  const [provider, setProvider] = useState<TtsProvider>(currentVoice);
  const guide = COMPANION_VOICE_GUIDES[provider];
  const selectedApi = resolveDialogueApi(api, char);
  const dialogueReady = companionDialogueReady(api, char);
  const visionReady = isVisionApiReady(api.visionApi);
  const videoReady = companionVideoReady(api.companionVideoApi);
  const voiceReady = !!char && canSynthesizeSpeech(char, api);
  const hasVoice = !!char && characterHasVoice(char, api);
  useLocalBackHandler(() => { close(); return true; }, 30);
  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => { if (previousFocus.current?.isConnected) previousFocus.current.focus(); };
  }, []);
  return <div ref={dialog} className="companion-setup" role="dialog" aria-modal="true" aria-label="同行 API 接入引导" tabIndex={-1}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); close(); }
      if (event.key === 'Tab') {
        const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], select, input:not(:disabled), summary') ?? [])
          .filter(element => element.getClientRects().length > 0);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first?.focus(); }
      }
    }}>
    <header><button type="button" className="companion-icon" aria-label="返回同行" onClick={close}><ArrowLeft size={22}/></button><div><h2>接入同行</h2><p>注册、拿 Key，再回到这里配置。</p></div></header>
    <div className="companion-setup-content">
      <p className="companion-setup-intro">先配对话就能文字试聊；听角色说话再配音色，开镜头需独立的视频理解 API。补充截图另行选择。</p>
      <p className="companion-setup-note">“已填写”只检查本机配置，不代表连通测试通过。站内跳转会结束当前同行，回来后重新开始；注册和 Key 页面在新标签页打开。</p>
      {!char && <button type="button" className="companion-setup-primary" onClick={() => navigate('character')}>先去神经链接添加角色</button>}

      <section aria-label="对话模型接入"><div className="companion-setup-heading"><h3><span>01</span> 对话模型</h3><small>{dialogueReady ? '已填写' : '待配置'} · 必需</small></div>
        <p>短回复和长回复使用同一模型。当前：{char?.dialogueApi ? '角色独立 API' : '全局 API'}{selectedApi.model ? ` · ${selectedApi.model}` : ' · 未选择模型'}。</p>
        <ol><li>已有能聊天的 API 无需再注册。没有账号，可从下方官方平台创建账号并获取模型标准 API Key。</li><li>填写 Base URL、Key 和模型 ID，保存后测试连接。使用其他服务商时，以对方的兼容接口文档为准。</li></ol>
        <div className="companion-setup-actions"><button type="button" onClick={() => navigate(char?.dialogueApi ? 'character' : 'api')}>{char?.dialogueApi ? '配置当前角色 API' : '配置全局对话 API'}</button>
          {char && <button type="button" onClick={() => navigate(char.dialogueApi ? 'api' : 'character')}>{char.dialogueApi ? '查看全局 API' : '配置角色独立 API'}</button>}</div>
        <details open={!dialogueReady}><summary>没有账号？智谱接入示例</summary>
          <div className="companion-setup-links"><ExternalLink href={links.glm.signup}>注册 / 登录智谱</ExternalLink><ExternalLink href={links.glm.keys}>获取 API Key</ExternalLink><ExternalLink href={links.glm.docs}>官方接入文档</ExternalLink></div>
          <CopyValue label="Base URL" value={links.glm.baseUrl}/>
          <p>模型 ID 选择账号已开通的对话模型。这里使用模型标准 API；套餐 Key 与标准 API Key 分开管理，请勿混填。已有角色独立 API 时，修改全局配置不会覆盖该角色。</p>
        </details>
      </section>

      <section aria-label="视频理解接入"><div className="companion-setup-heading"><h3><span>02</span> 理解一段视频</h3><small>{videoReady ? '已填写' : '待配置'} · 开镜头时需要</small></div>
        <p>摄像头录制约 8 秒的完整无声视频，由独立视频模型理解动作、镜头变化和先后关系，再把文字摘要交给对话模型。下一段录制与分析并行；慢请求只保留最新待分析片段。</p>
        <p>豆包、MiniMax 直接接收完整 MP4；智谱通过你配置的临时上传服务取得视频链接。视频只在开启镜头后发送，按平台用量计费；本机不保存录像。</p>
        <VideoApiFields config={api.companionVideoApi} save={saveVideoApi}/>
        <details open><summary>给主模型的补充截图 · 可选</summary>
          <p>视频理解完成后，才从同一段视频中提取 1–3 张相关截图。默认只发送摘要文字；对话模型是否支持图片由你确认，不根据模型名称猜测。</p>
          <label className="companion-image-choice"><input type="checkbox" checked={imageMode === 'direct'} disabled={!changeImageMode} onChange={event => changeImageMode?.(event.target.checked ? 'direct' : 'none')}/>主对话模型支持图片，向长回复附带截图</label>
          <label className="companion-image-choice"><input type="checkbox" checked={imageMode === 'helper'} disabled={!changeImageMode || !visionReady} onChange={event => changeImageMode?.(event.target.checked ? 'helper' : 'none')}/>使用独立识图 API 补充截图细节，再转成文字</label>
          <p>{imageMode === 'direct' ? '长回复接收视频摘要与截图；短接话继续只读已有摘要。' : imageMode === 'helper' ? '图片仅发给辅助识图 API，主模型收到的仍然全部是文字。' : '当前主模型只收到文字，不发截图，也不调用辅助识图。'} 两项互斥，仅对本次同行生效；切换角色后需重新确认。修改会停止本轮和镜头。</p>
          <div className="companion-setup-actions"><button type="button" onClick={() => navigate('vision')}>去配置识图 API</button></div>
          <small className="companion-setup-note">独立识图只是可选补充，不能代替上面的视频 API。辅助识图尚未配置时，直接使用视频摘要也能正常同行。</small>
        </details>
      </section>

      <section aria-label="角色语音接入"><div className="companion-setup-heading"><h3><span>03</span> 听角色说话</h3><small>{voiceReady ? 'Key 与音色已配置' : !char ? '先选择角色' : hasVoice ? '缺少语音 Key' : '待配置音色'} · 可选</small></div>
        <p>当前引擎：{COMPANION_VOICE_GUIDES[currentVoice].name}。账号 Key 在「其他 API」，音色在「神经链接 → 当前角色 → 设定」。</p>
        <label className="companion-setup-provider">查看平台指引<select aria-label="查看语音平台指引" value={provider} onChange={event => setProvider(event.target.value as TtsProvider)}>
          {Object.entries(COMPANION_VOICE_GUIDES).map(([id, item]) => <option key={id} value={id}>{item.name}</option>)}
        </select></label><small className="companion-setup-note">这里只切换指引；实际引擎在设置中选择。</small>
        <ol>{guide.steps.map(step => <li key={step}>{step}</li>)}</ol>
        <div className="companion-setup-links"><ExternalLink href={guide.signup}>注册 {guide.name}</ExternalLink><ExternalLink href={guide.keys}>获取语音 Key</ExternalLink><ExternalLink href={guide.docs}>官方文档</ExternalLink>
          {provider === 'minimax' && <ExternalLink href="https://platform.minimax.io/">MiniMax 海外平台</ExternalLink>}</div>
        <p>角色需要填写：{guide.voiceField}。平台网页会员与 API 可用额度以平台说明为准；注册完成后先试听，再回同行测试。</p>
        <div className="companion-setup-actions"><button type="button" onClick={() => navigate('voice')}>配置语音 Key / 引擎</button><button type="button" disabled={!char} onClick={() => navigate('character')}>配置当前角色音色</button></div>
      </section>

      <section aria-label="语音输入接入"><div className="companion-setup-heading"><h3><span>04</span> 听你说话</h3><small>{canListen ? '浏览器支持识别' : '此浏览器不支持'} · 无需 API Key</small></div>
        <p>当前连续听使用浏览器语音识别。允许麦克风后即可试用，建议戴耳机；不支持时仍可输入文字。系统里配置的文件转写 API 不会用于这里的连续听。</p>
        <details><summary>豆包连续识别 · 尚未接入</summary><p>这是后续接入方向，当前没有豆包 Key 填写入口，注册后也不能立即用于同行。可先了解开通流程，暂时无需为此 demo 充值。</p>
          <div className="companion-setup-links"><ExternalLink href={links.doubao.console}>火山引擎注册 / 控制台</ExternalLink><ExternalLink href={links.doubao.docs}>豆包语音开通文档</ExternalLink></div>
        </details>
      </section>
      <p className="companion-setup-note">长回复继续沿用当前角色的上下文条数、自动记忆与记忆宫殿配置，无需为同行重复创建一套记忆 API。</p>
      <button type="button" className="companion-setup-primary" onClick={close}>返回同行，开始测试</button>
    </div>
  </div>;
}
