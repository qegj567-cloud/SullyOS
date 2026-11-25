import React, { useRef, useState } from 'react';
import { ArrowUpRight } from '@phosphor-icons/react';
import type { APIConfig, CompanionVideoApiConfig } from '../../types';
import { normalizeApiBaseUrl, normalizeApiCredential, normalizeApiModel } from '../../utils/apiConfigNormalize';
import { COMPANION_VIDEO_PROVIDERS, COMPANION_ARK_PLAN, DEFAULT_COMPANION_VIDEO, domesticMiniMaxVideoKey, isCompanionArkPlan, isOfficialCompanionMiniMax, resolveCompanionVideoApi, selectedCompanionVideoConfig, type CompanionVideoProvider } from '../../utils/companion/videoProviders';
import { CompanionApiTest, type BeginCompanionTest } from './CompanionApiTest';
import { companionVideoRouteLabel, testCompanionVideoDirect } from '../../utils/companion/videoConnection';
import { testCompanionVideo, testMiniMaxReferenceVideo } from '../../utils/companion/apiTests';
import './CompanionVideoSettings.css';

function VideoApiFields({ config, domesticMiniMaxKey, save, begin }: { config?: CompanionVideoApiConfig; domesticMiniMaxKey: string; save: (config: CompanionVideoApiConfig) => void; begin: BeginCompanionTest }) {
  const initial = config ?? DEFAULT_COMPANION_VIDEO;
  const [provider, setProvider] = useState<CompanionVideoProvider>(initial.provider ?? 'custom');
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [model, setModel] = useState(initial.model);
  const [key, setKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [message, setMessage] = useState('');
  const guide = COMPANION_VIDEO_PROVIDERS[provider];
  const arkPlan = provider === 'doubao' && isCompanionArkPlan(baseUrl);
  const sameEndpoint = normalizeApiBaseUrl(baseUrl) === config?.baseUrl && provider === (config?.provider ?? 'custom');
  const draft: CompanionVideoApiConfig = { provider, baseUrl: normalizeApiBaseUrl(baseUrl), model: normalizeApiModel(model),
    apiKey: normalizeApiCredential(key) || (!clearKey && sameEndpoint ? config?.apiKey ?? '' : '') };
  const officialMiniMax = isOfficialCompanionMiniMax(draft);
  const testConfig = resolveCompanionVideoApi(draft, domesticMiniMaxKey);
  const useSharedKey = officialMiniMax && !draft.apiKey && !!domesticMiniMaxKey;
  const savedMiniMaxTest = officialMiniMax && domesticMiniMaxKey ? { ...draft, apiKey: domesticMiniMaxKey } : undefined;
  return <form className="companion-video-fields" onSubmit={event => {
    event.preventDefault();
    const url = normalizeApiBaseUrl(baseUrl);
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('请填写有效的 HTTP(S) Base URL');
      if (!draft.model) throw new Error('请填写支持视频输入的模型 ID');
      save(draft);
      setKey(''); setClearKey(false); setMessage('已保存。返回同行开启镜头后，才会录制并发送视频。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败'); }
  }}>
    <label className="companion-setup-provider">视频服务商<select aria-label="视频服务商" value={provider} onChange={event => {
      const next = event.target.value as CompanionVideoProvider;
      setProvider(next); setBaseUrl(COMPANION_VIDEO_PROVIDERS[next].baseUrl); setModel(COMPANION_VIDEO_PROVIDERS[next].model);
      setKey(''); setClearKey(true); setMessage('已切换草稿，保存后用于镜头。');
    }}>{Object.entries(COMPANION_VIDEO_PROVIDERS).map(([id, item]) => <option key={id} value={id}>{item.name}</option>)}</select></label>
    {provider === 'doubao' && <label>豆包接入方式<select aria-label="豆包接入方式" value={arkPlan ? 'plan' : 'standard'} onChange={event => {
      const next = event.target.value === 'plan' ? COMPANION_ARK_PLAN : COMPANION_VIDEO_PROVIDERS.doubao;
      setBaseUrl(next.baseUrl); setModel(next.model); setKey(''); setClearKey(true);
      setMessage('已切换地址和模型，请填写所选服务的 Key；测试通过后再保存。');
    }}><option value="standard">普通模型 API · 单独计费</option><option value="plan">已购 Agent Plan 套餐</option></select></label>}
    <p>{arkPlan ? '使用已购套餐的专属 Key、专属地址和模型名；在套餐控制台「使用配置」获取。完整视频输入已用 Small 套餐实测通过，无需购买视频生成模型。套餐适用范围与额度以官方规则为准。' : guide.note}</p>
    {provider === 'doubao' && !arkPlan && <small>这里是普通 API，Agent Plan 会员不抵扣这个入口的费用。已买套餐请选择上方「已购 Agent Plan 套餐」。</small>}
    {arkPlan && <small>视频及套餐 Key 经转发连接火山官方套餐接口：本地预览经本机，线上沿用设置中的应用主代理。转发不保存录像或 Key、不创建文件 ID，也不自动切到普通计费接口；火山的数据处理以其服务条款为准。</small>}
    <div className="companion-setup-links"><ExternalLink href={arkPlan ? COMPANION_ARK_PLAN.keys : guide.signup}>{arkPlan ? '打开已购套餐' : `注册 / 登录${guide.name}`}</ExternalLink><ExternalLink href={arkPlan ? COMPANION_ARK_PLAN.keys : guide.keys}>{arkPlan ? '获取套餐专属 Key' : '获取视频模型 Key'}</ExternalLink><ExternalLink href={guide.docs}>视频输入文档</ExternalLink></div>
    <label>视频 API Base URL<input aria-label="视频 API Base URL" type="url" required value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="填写平台的 OpenAI 兼容地址"/></label>
    <label>视频模型 ID<input aria-label="视频模型 ID" required value={model} onChange={event => setModel(event.target.value)} placeholder="账号已开通的视频理解模型"/></label>
    <label>视频 API Key<input aria-label="视频 API Key" type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} placeholder={useSharedKey ? '已沿用「其他 API」的国内 MiniMax Key' : config?.apiKey && sameEndpoint && !clearKey ? '已保存，留空保留原 Key' : '填写此地址的 Key'}/></label>
    {config?.apiKey && sameEndpoint && <label className="companion-image-choice"><input type="checkbox" checked={clearKey} onChange={event => setClearKey(event.target.checked)}/>保存时移除视频专用 Key</label>}
    <small>{officialMiniMax ? (useSharedKey ? '开镜头和测试都使用「其他 API」里已保存的国内 MiniMax Key。在那里换 Key 后，镜头会跟随更新。' : '可填写视频专用 Key，或在「其他 API」保存国内 MiniMax Key 后沿用。') : '仅使用为当前视频地址填写的凭据。无 Key 的自定义代理可留空。'}</small>
    <p role="note"><strong>视频发送路径：</strong>{companionVideoRouteLabel(draft)}</p>
    <small>{arkPlan ? '套餐接口目前不放行浏览器携带鉴权头直连，因此实际视频仍需上方转发。下面的直连检查不会改变这条路径。普通 API 是另一套凭据与计费，请勿混用。' : '请求直接发到你填写的地址；该地址若本身是第三方中转，视频也会经过对方。跨域失败不会自动改走应用 Worker。'}</small>
    <div className="companion-setup-actions"><button type="submit">保存视频 API</button></div>
    <CompanionApiTest label="检查浏览器直连" successLabel="检查完成" description="向所填地址发送空请求，检查此浏览器能否读取响应。" config={testConfig ?? draft}
      disabled={!draft.baseUrl} begin={begin} run={signal => testCompanionVideoDirect(testConfig ?? draft, signal)}/>
    <CompanionApiTest label="测试视频 API" successLabel="已收到回复" description="测试当前填写内容，不自动保存。发送 2 秒图形样片（红色圆形 → 蓝色方形），不开摄像头。" config={testConfig ?? draft}
      disabled={!testConfig || !draft.baseUrl || !draft.model} begin={begin} run={(signal, progress) => testCompanionVideo(testConfig ?? draft, signal, progress)}/>
    {savedMiniMaxTest && <CompanionApiTest label="用已存 MiniMax Key 测样片" successLabel="已收到回复"
      description="用「其他 API」已保存的国内 MiniMax Key，向 api.minimax.cn 发送 8 秒标准样片。前 4 秒是左侧红圆，后 4 秒是右侧蓝方块。"
      config={savedMiniMaxTest} disabled={!draft.model} begin={begin} run={(signal, progress) => testMiniMaxReferenceVideo(savedMiniMaxTest, signal, progress)}/>}
    {message && <p role="status">{message}</p>}
  </form>;
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <a href={href} target="_blank" rel="noopener noreferrer">{children}<ArrowUpRight size={13} aria-hidden="true"/></a>;
}

export function CompanionVideoSettings({ api, saveVideoApi }: {
  api: APIConfig; saveVideoApi: (config: CompanionVideoApiConfig) => void;
}) {
  const storedVideo = api.companionVideoApi;
  const domesticKey = domesticMiniMaxVideoKey(api);
  const active = useRef<() => void>();
  const begin: BeginCompanionTest = cancel => { active.current?.(); active.current = cancel; };
  return <div className="companion-video-settings">
    {storedVideo && !storedVideo.preferSharedMiniMax && !isOfficialCompanionMiniMax(storedVideo) && domesticKey &&
      <button type="button" className="video-restore" onClick={() => saveVideoApi({ ...storedVideo, preferSharedMiniMax: true })}>切换到 MiniMax 直连</button>}
    {storedVideo?.preferSharedMiniMax && <div className="companion-setup-actions">
      <button type="button" onClick={() => {
        const { preferSharedMiniMax, ...previous } = storedVideo;
        saveVideoApi(previous);
      }}>恢复之前的视频配置</button>
    </div>}
    <VideoApiFields key={storedVideo?.preferSharedMiniMax ? 'shared' : 'saved'} config={selectedCompanionVideoConfig(storedVideo)} domesticMiniMaxKey={domesticKey}
      save={draft => {
        const keepPrevious = storedVideo?.preferSharedMiniMax && isOfficialCompanionMiniMax(draft) &&
          !draft.apiKey && draft.model === DEFAULT_COMPANION_VIDEO.model;
        saveVideoApi(keepPrevious ? storedVideo : draft);
      }} begin={begin}/>
  </div>;
}
