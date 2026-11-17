import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight } from '@phosphor-icons/react';
import type { APIConfig, CharacterProfile, CompanionVideoApiConfig, CompanionSttConfig, TtsProvider } from '../../types';
import { resolveDialogueApi } from '../../utils/characterApi';
import { isVisionApiReady } from '../../utils/visionApi';
import { canSynthesizeSpeech, characterHasVoice } from '../../utils/ttsRouter';
import { resolveTtsProvider } from '../../utils/ttsProvider';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import { COMPANION_SETUP_LINKS as links, COMPANION_VOICE_GUIDES, companionDialogueReady, type CompanionSetupTarget } from '../../utils/companion/setup';
import { companionVideoReady, type CompanionImageMode } from '../../utils/companion/vision';
import { normalizeApiBaseUrl, normalizeApiCredential, normalizeApiModel } from '../../utils/apiConfigNormalize';
import { COMPANION_VIDEO_PROVIDERS, COMPANION_ARK_PLAN, isCompanionArkPlan, type CompanionVideoProvider } from '../../utils/companion/videoProviders';
import { CompanionApiTest, type BeginCompanionTest } from './CompanionApiTest';
import { testCompanionDialogue, testCompanionImage, testCompanionStt, testCompanionVideo, testCompanionVoice } from '../../utils/companion/apiTests';

function VideoApiFields({ config, save, begin }: { config?: CompanionVideoApiConfig; save?: (config: CompanionVideoApiConfig) => void; begin: BeginCompanionTest }) {
  const [provider, setProvider] = useState<CompanionVideoProvider>(config ? config.provider ?? 'custom' : 'doubao');
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? COMPANION_VIDEO_PROVIDERS.doubao.baseUrl);
  const [model, setModel] = useState(config?.model ?? COMPANION_VIDEO_PROVIDERS.doubao.model);
  const [key, setKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [message, setMessage] = useState('');
  const guide = COMPANION_VIDEO_PROVIDERS[provider];
  const arkPlan = provider === 'doubao' && isCompanionArkPlan(baseUrl);
  const sameEndpoint = normalizeApiBaseUrl(baseUrl) === config?.baseUrl && provider === (config?.provider ?? 'custom');
  const draft: CompanionVideoApiConfig = { provider, baseUrl: normalizeApiBaseUrl(baseUrl), model: normalizeApiModel(model),
    apiKey: normalizeApiCredential(key) || (!clearKey && sameEndpoint ? config?.apiKey ?? '' : '') };
  return <form className="companion-video-fields" onSubmit={event => {
    event.preventDefault();
    if (!save) return;
    const url = normalizeApiBaseUrl(baseUrl);
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('请填写有效的 HTTP(S) Base URL');
      const normalizedModel = normalizeApiModel(model);
      if (!normalizedModel) throw new Error('请填写支持视频输入的模型 ID');
      save({ provider, baseUrl: url, model: normalizedModel, apiKey: normalizeApiCredential(key) || (!clearKey && sameEndpoint ? config?.apiKey ?? '' : '') });
      setKey(''); setClearKey(false); setMessage('已保存。返回同行开启镜头后，才会录制并发送视频。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败'); }
  }}>
    <label className="companion-setup-provider">视频服务商<select aria-label="视频服务商" value={provider} onChange={event => {
      const next = event.target.value as CompanionVideoProvider;
      setProvider(next); setBaseUrl(COMPANION_VIDEO_PROVIDERS[next].baseUrl); setModel(COMPANION_VIDEO_PROVIDERS[next].model);
      setKey(''); setClearKey(true); setMessage('已切换草稿，请填写对应凭据并保存。');
    }}>{Object.entries(COMPANION_VIDEO_PROVIDERS).map(([id, item]) => <option key={id} value={id}>{item.name}</option>)}</select></label>
    {provider === 'doubao' && <label>豆包接入方式<select aria-label="豆包接入方式" value={arkPlan ? 'plan' : 'standard'} onChange={event => {
      const next = event.target.value === 'plan' ? COMPANION_ARK_PLAN : COMPANION_VIDEO_PROVIDERS.doubao;
      setBaseUrl(next.baseUrl); setModel(next.model); setKey(''); setClearKey(true);
      setMessage('已切换地址和模型，请填写所选服务的 Key；测试通过后再保存。');
    }}><option value="standard">普通模型 API · 单独计费</option><option value="plan">已购 Agent Plan 套餐</option></select></label>}
    <p>{arkPlan ? '使用已购套餐的专属 Key、专属地址和模型名；在套餐控制台「使用配置」获取。完整视频输入已用 Small 套餐实测通过，无需购买视频生成模型。套餐适用范围与额度以官方规则为准。' : guide.note}</p>
    {provider === 'doubao' && !arkPlan && <small>这里是普通 API，Agent Plan 会员不抵扣这个入口的费用。已买套餐请选择上方「已购 Agent Plan 套餐」。</small>}
    {arkPlan && <small>本地预览通过本机内存转发连接火山官方套餐接口，解决浏览器跨域；不存录像、不创建文件 ID，也不自动切到普通计费接口。线上网页尚未接入这条转发。</small>}
    <div className="companion-setup-links"><ExternalLink href={arkPlan ? COMPANION_ARK_PLAN.keys : guide.signup}>{arkPlan ? '打开已购套餐' : `注册 / 登录${guide.name}`}</ExternalLink><ExternalLink href={arkPlan ? COMPANION_ARK_PLAN.keys : guide.keys}>{arkPlan ? '获取套餐专属 Key' : '获取视频模型 Key'}</ExternalLink><ExternalLink href={guide.docs}>视频输入文档</ExternalLink></div>
    <label>视频 API Base URL<input aria-label="视频 API Base URL" type="url" required value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="填写平台的 OpenAI 兼容地址"/></label>
    <label>视频模型 ID<input aria-label="视频模型 ID" required value={model} onChange={event => setModel(event.target.value)} placeholder="账号已开通的视频理解模型"/></label>
    <label>视频 API Key<input aria-label="视频 API Key" type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} placeholder={config?.apiKey && sameEndpoint && !clearKey ? '已保存，留空保留原 Key' : '粘贴 Key；无 Key 代理可留空'}/></label>
    {config?.apiKey && <label className="companion-image-choice"><input type="checkbox" checked={clearKey} onChange={event => setClearKey(event.target.checked)}/>保存时移除旧 Key</label>}
    <small>只用于同行视频理解。切换服务商或修改地址时不会复用旧 Key；请同时填写对应凭据。模型 ID 可修改，需选支持视频输入的型号。配置保存在本机，随系统配置备份。</small>
    <div className="companion-setup-actions"><button type="submit" disabled={!save}>保存视频 API</button></div>
    <CompanionApiTest label="测试视频 API" description="测试当前填写内容，不自动保存。发送 2 秒图形样片（红色圆形 → 蓝色方形），不开摄像头。" config={draft}
      disabled={!save || !draft.baseUrl || !draft.model} begin={begin} run={(signal, progress) => testCompanionVideo(draft, signal, progress)}/>
    {!save && <small>模拟页不保存真实 API，请在主应用的同行中配置。</small>}
    {message && <p role="status">{message}</p>}
  </form>;
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <a href={href} target="_blank" rel="noopener noreferrer">{children}<ArrowUpRight size={13} aria-hidden="true"/></a>;
}

function SttApiFields({ config, save, begin }: { config?: CompanionSttConfig; save?: (config: CompanionSttConfig) => void; begin: BeginCompanionTest }) {
  const [provider, setProvider] = useState<CompanionSttConfig['provider']>(config?.provider ?? 'browser');
  const [resourceId, setResourceId] = useState<CompanionSttConfig['resourceId']>(config?.resourceId ?? 'volc.seedasr.sauc.duration');
  const [key, setKey] = useState(''), [clearKey, setClearKey] = useState(false), [message, setMessage] = useState('');
  const draft: CompanionSttConfig = { provider, resourceId, apiKey: normalizeApiCredential(key) || (!clearKey ? config?.apiKey ?? '' : '') };
  return <form className="companion-video-fields" onSubmit={event => {
    event.preventDefault(); if (!save) return;
    const apiKey = normalizeApiCredential(key) || (!clearKey ? config?.apiKey ?? '' : '');
    if (provider === 'doubao' && !apiKey) { setMessage('请填写豆包语音控制台的 API Key'); return; }
    save({ provider, resourceId, apiKey }); setKey(''); setClearKey(false); setMessage('已保存语音识别设置，返回同行后重新开启连续听。');
  }}>
    <label className="companion-setup-provider">语音识别引擎<select aria-label="语音识别引擎" value={provider} onChange={event => { setProvider(event.target.value as CompanionSttConfig['provider']); setMessage(''); }}>
      <option value="browser">浏览器识别</option><option value="doubao">豆包流式语音识别 2.0</option>
    </select></label>
    {provider === 'browser' ? <p>无需 API Key，使用浏览器提供的语音识别。可用性因浏览器而异；不支持时可切换豆包或输入文字。</p> : <>
      <p>边说边识别，临时文字触发打断；一句话确认后才交给角色。豆包只听写，不更换你的对话模型或角色音色。</p>
      <ol><li>进入豆包语音控制台，开通「豆包流式语音识别模型 2.0」，选择小时版或已购买的并发版。</li>
        <li>在新版控制台「API Key 管理」创建语音 Key，填到下方。它和方舟聊天 / 视频 Key 不同。</li>
        <li>保存后返回同行，点击「连续听」并允许麦克风。建议戴耳机，避免把角色外放的声音识别成你的话。</li></ol>
      <div className="companion-setup-links"><ExternalLink href="https://console.volcengine.com/speech/new/overview">注册 / 登录豆包语音</ExternalLink><ExternalLink href="https://console.volcengine.com/speech/new/setting/apikeys?projectName=default">获取豆包语音 Key</ExternalLink><ExternalLink href="https://docs.volcengine.com/docs/doubao-voice/quick-start-new-console?lang=zh">开通指引</ExternalLink><ExternalLink href="https://docs.volcengine.com/docs/doubao-voice/bidirectional-streaming-automatic-speech-recognition-websocket?lang=zh">流式识别文档</ExternalLink></div>
      <label>豆包语音 API Key<input aria-label="豆包语音 API Key" type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} placeholder={config?.apiKey && !clearKey ? '已保存，留空保留原 Key' : '新版语音控制台的 API Key'}/></label>
      {config?.apiKey && <label className="companion-image-choice"><input type="checkbox" checked={clearKey} onChange={event => setClearKey(event.target.checked)}/>保存时移除旧语音 Key</label>}
      <label className="companion-setup-provider">服务规格<select aria-label="豆包识别服务规格" value={resourceId} onChange={event => setResourceId(event.target.value as CompanionSttConfig['resourceId'])}>
        <option value="volc.seedasr.sauc.duration">小时版 · 按识别时长计费</option><option value="volc.seedasr.sauc.concurrent">并发版 · 需已购买并发资源</option>
      </select></label>
      <small>开启连续听后，音频及语音 Key 经应用的语音转发入口发送给豆包；本地预览经本机，线上沿用应用主代理，无需另填服务地址。转发不保存录音或 Key，不创建录音链接；豆包的数据处理以其服务条款为准。关闭、离开或切到后台即停止收音。</small>
      <small>Key 保存在本机设置，并随系统配置备份。当前连接最多 30 分钟，到时提示重新开启；识别失败会停止，不自动切换服务商。</small>
    </>}
    <div className="companion-setup-actions"><button type="submit" disabled={!save}>保存语音识别设置</button></div>
    <CompanionApiTest label="测试语音识别" description="测试当前填写内容，不自动保存。开启麦克风，请说一句话并停顿；显示最终识别结果后停止，最长 30 秒，不交给角色生成回复。" config={draft}
      disabled={!save || (provider === 'doubao' && !draft.apiKey)} begin={begin} run={(signal, progress) => testCompanionStt(draft, signal, progress)}/>
    {!save && <small>模拟页不保存凭据，请在主应用配置。</small>}
    {message && <p role="status">{message}</p>}
  </form>;
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

export function CompanionSetupGuide({ char, api, canListen, close, navigate, saveVideoApi, saveStt, imageMode = 'none', changeImageMode, beforeTest }: {
  char?: CharacterProfile; api: APIConfig; canListen: boolean; close(): void; navigate(target: CompanionSetupTarget): void;
  saveVideoApi?: (config: CompanionVideoApiConfig) => void;
  saveStt?: (config: CompanionSttConfig) => void;
  beforeTest?: () => void;
  imageMode?: CompanionImageMode; changeImageMode?: (mode: CompanionImageMode) => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const runningTest = useRef<() => void>();
  const begin: BeginCompanionTest = cancel => { runningTest.current?.(); runningTest.current = cancel; beforeTest?.(); };
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
      <p className="companion-setup-note">“已填写”不代表可用，请点击各项测试查看真实返回与耗时。测试会暂停当前同行，并产生少量服务商用量；只在点击后发送。修改配置会清除旧测试结果。站内跳转会结束当前同行，注册链接在新标签页打开。</p>
      {!char && <button type="button" className="companion-setup-primary" onClick={() => navigate('character')}>先去神经链接添加角色</button>}

      <section aria-label="对话模型接入"><div className="companion-setup-heading"><h3><span>01</span> 对话模型</h3><small>{dialogueReady ? '已填写' : '待配置'} · 必需</small></div>
        <p>短回复和长回复使用同一模型。当前：{char?.dialogueApi ? '角色独立 API' : '全局 API'}{selectedApi.model ? ` · ${selectedApi.model}` : ' · 未选择模型'}。</p>
        <ol><li>已有能聊天的 API 无需再注册。没有账号，可从下方官方平台创建账号并获取模型标准 API Key。</li><li>填写 Base URL、Key 和模型 ID，保存后测试连接。使用其他服务商时，以对方的兼容接口文档为准。</li></ol>
        <div className="companion-setup-actions"><button type="button" onClick={() => navigate(char?.dialogueApi ? 'character' : 'api')}>{char?.dialogueApi ? '配置当前角色 API' : '配置全局对话 API'}</button>
          {char && <button type="button" onClick={() => navigate(char.dialogueApi ? 'api' : 'character')}>{char.dialogueApi ? '查看全局 API' : '配置角色独立 API'}</button>}</div>
        <CompanionApiTest label="测试对话 API" description="使用当前已保存的实际对话模型发送固定问候，不读取人设、聊天或记忆。" config={{ api: selectedApi, charId: char?.id }}
          disabled={!dialogueReady} begin={begin} run={signal => testCompanionDialogue(api, char, signal)}/>
        <details open={!dialogueReady}><summary>没有账号？智谱接入示例</summary>
          <div className="companion-setup-links"><ExternalLink href={links.glm.signup}>注册 / 登录智谱</ExternalLink><ExternalLink href={links.glm.keys}>获取 API Key</ExternalLink><ExternalLink href={links.glm.docs}>官方接入文档</ExternalLink></div>
          <CopyValue label="Base URL" value={links.glm.baseUrl}/>
          <p>模型 ID 选择账号已开通的对话模型。这里使用模型标准 API；套餐 Key 与标准 API Key 分开管理，请勿混填。已有角色独立 API 时，修改全局配置不会覆盖该角色。</p>
        </details>
      </section>

      <section aria-label="视频理解接入"><div className="companion-setup-heading"><h3><span>02</span> 理解一段视频</h3><small>{videoReady ? '已填写' : '待配置'} · 开镜头时需要</small></div>
        <p>摄像头录制约 8 秒的完整无声视频，由独立视频模型理解动作、镜头变化和先后关系，再把文字摘要交给对话模型。下一段录制与分析并行；慢请求只保留最新待分析片段。</p>
        <p>完整视频从本机内存随 API 请求直接发给所选服务商，只在开启镜头后发送，按平台用量计费。同行不另存录像、不创建可公开访问的视频链接，无需部署上传服务。服务商的数据保留规则以其条款为准。</p>
        <VideoApiFields config={api.companionVideoApi} save={saveVideoApi} begin={begin}/>
        <details open><summary>给主模型的补充截图 · 可选</summary>
          <p>视频理解完成后，才从同一段视频中提取 1–3 张相关截图。默认只发送摘要文字；对话模型是否支持图片由你确认，不根据模型名称猜测。</p>
          <label className="companion-image-choice"><input type="checkbox" checked={imageMode === 'direct'} disabled={!changeImageMode} onChange={event => changeImageMode?.(event.target.checked ? 'direct' : 'none')}/>主对话模型支持图片，向长回复附带截图</label>
          <label className="companion-image-choice"><input type="checkbox" checked={imageMode === 'helper'} disabled={!changeImageMode || !visionReady} onChange={event => changeImageMode?.(event.target.checked ? 'helper' : 'none')}/>使用独立识图 API 补充截图细节，再转成文字</label>
          <p>{imageMode === 'direct' ? '长回复接收视频摘要与截图；短接话继续只读已有摘要。' : imageMode === 'helper' ? '图片仅发给辅助识图 API，主模型收到的仍然全部是文字。' : '当前主模型只收到文字，不发截图，也不调用辅助识图。'} 两项互斥，仅对本次同行生效；切换角色后需重新确认。修改会停止本轮和镜头。</p>
        <div className="companion-setup-actions"><button type="button" onClick={() => navigate('vision')}>去配置识图 API</button></div>
        {imageMode === 'direct' && <CompanionApiTest label="测试主模型识图" description="向当前主模型发送一张白底红圆测试图，确认它是否能返回图片描述。" config={{ api: selectedApi, charId: char?.id }}
          disabled={!dialogueReady} begin={begin} run={signal => testCompanionImage(selectedApi, signal, char, true)}/>}
        <CompanionApiTest label="测试独立识图 API" description="使用已保存的独立识图配置发送白底红圆测试图；不改变截图发送开关。" config={api.visionApi}
          disabled={!api.visionApi?.baseUrl?.trim() || !api.visionApi?.model?.trim()} begin={begin} run={signal => testCompanionImage(api.visionApi!, signal)}/>
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
        <CompanionApiTest label="测试并试听角色音色" description={`使用当前实际引擎 ${COMPANION_VOICE_GUIDES[currentVoice].name} 和角色音色合成固定短句；切换上方平台指引不会更换测试引擎。`} config={{ api, voiceProfile: char?.voiceProfile, charId: char?.id }}
          disabled={!voiceReady} begin={begin} run={(signal, progress) => testCompanionVoice(api, char!, signal, progress)}/>
      </section>

      <section aria-label="语音输入接入"><div className="companion-setup-heading"><h3><span>04</span> 听你说话</h3><small>{api.companionStt?.provider === 'doubao' ? api.companionStt.apiKey ? '豆包 Key 已填写' : '豆包待配置' : canListen ? '浏览器支持识别' : '此浏览器不支持'}</small></div>
        <SttApiFields config={api.companionStt} save={saveStt} begin={begin}/>
      </section>
      <p className="companion-setup-note">长回复继续沿用当前角色的上下文条数、自动记忆与记忆宫殿配置，无需为同行重复创建一套记忆 API。</p>
      <button type="button" className="companion-setup-primary" onClick={close}>返回同行，开始测试</button>
    </div>
  </div>;
}
