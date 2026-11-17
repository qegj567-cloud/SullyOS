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

function VideoApiFields({ config, save }: { config?: CompanionVideoApiConfig; save?: (config: CompanionVideoApiConfig) => void }) {
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? '');
  const [model, setModel] = useState(config?.model ?? '');
  const [key, setKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [message, setMessage] = useState('');
  const sameEndpoint = normalizeApiBaseUrl(baseUrl) === config?.baseUrl;
  return <form className="companion-video-fields" onSubmit={event => {
    event.preventDefault();
    if (!save) return;
    const url = normalizeApiBaseUrl(baseUrl);
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('请填写有效的 HTTP(S) Base URL');
      const normalizedModel = normalizeApiModel(model);
      if (!normalizedModel) throw new Error('请填写支持视频输入的模型 ID');
      save({ baseUrl: url, model: normalizedModel, apiKey: normalizeApiCredential(key) || (!clearKey && sameEndpoint ? config?.apiKey ?? '' : '') });
      setKey(''); setClearKey(false); setMessage('已保存。返回同行开启镜头后，才会录制并发送视频。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败'); }
  }}>
    <label>视频 API Base URL<input aria-label="视频 API Base URL" type="url" required value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="填写平台的 OpenAI 兼容地址"/></label>
    <label>视频模型 ID<input aria-label="视频模型 ID" required value={model} onChange={event => setModel(event.target.value)} placeholder="账号已开通的视频理解模型"/></label>
    <label>视频 API Key<input aria-label="视频 API Key" type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} placeholder={config?.apiKey && sameEndpoint && !clearKey ? '已保存，留空保留原 Key' : '粘贴 Key；无 Key 代理可留空'}/></label>
    {config?.apiKey && <label className="companion-image-choice"><input type="checkbox" checked={clearKey} onChange={event => setClearKey(event.target.checked)}/>保存时移除旧 Key</label>}
    <small>只用于同行视频理解。修改地址时不会复用旧 Key；请同时填写对应凭据。与其他 API 设置一起保存在本机，随系统配置备份。</small>
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
        <p>需要接收 MP4 Base64 视频的 video_url 兼容接口。只有图片理解或视频生成功能的 API 不适用。视频在开启镜头后发送给这里填写的服务商，按平台用量计费；不保存录像。</p>
        <VideoApiFields config={api.companionVideoApi} save={saveVideoApi}/>
        <details open={!videoReady}><summary>注册与配置：阿里云百炼视频理解</summary>
          <div className="companion-setup-links"><ExternalLink href={links.qwen.signup}>注册 / 登录百炼</ExternalLink><ExternalLink href={links.qwen.keys}>获取 API Key</ExternalLink><ExternalLink href={links.qwen.docs}>视频理解与模型文档</ExternalLink><ExternalLink href={links.qwen.baseUrls}>各地域 Base URL</ExternalLink></div>
          <CopyValue label="Base URL" value={links.qwen.baseUrl}/>
          <p>上方为北京通用地址示例。按控制台复制所在地域和业务空间的实际地址、Key，并填写已开通且支持视频文件输入的模型 ID；不自动替你选择或更换模型。官方文档的「视频文件 → Base64 编码传入」对应当前接法。</p>
          <p>智谱也有视频理解模型，但其官方示例使用视频链接。当前 demo 没有公共视频上传服务，不能把仅接收公网视频链接的接口直接填进来。</p>
          <div className="companion-setup-links"><ExternalLink href={links.glm.visionDocs}>智谱视频理解说明</ExternalLink></div>
        </details>
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
