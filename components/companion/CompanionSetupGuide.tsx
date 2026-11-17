import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight } from '@phosphor-icons/react';
import type { APIConfig, CharacterProfile, TtsProvider } from '../../types';
import { resolveDialogueApi } from '../../utils/characterApi';
import { isVisionApiReady } from '../../utils/visionApi';
import { canSynthesizeSpeech, characterHasVoice } from '../../utils/ttsRouter';
import { resolveTtsProvider } from '../../utils/ttsProvider';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import { COMPANION_SETUP_LINKS as links, COMPANION_VOICE_GUIDES, companionDialogueReady, type CompanionSetupTarget } from '../../utils/companion/setup';

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

export function CompanionSetupGuide({ char, api, canListen, close, navigate }: {
  char?: CharacterProfile; api: APIConfig; canListen: boolean; close(): void; navigate(target: CompanionSetupTarget): void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const currentVoice = resolveTtsProvider(api);
  const [provider, setProvider] = useState<TtsProvider>(currentVoice);
  const guide = COMPANION_VOICE_GUIDES[provider];
  const selectedApi = resolveDialogueApi(api, char);
  const dialogueReady = companionDialogueReady(api, char);
  const visionReady = isVisionApiReady(api.visionApi);
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
        const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], select, summary') ?? [])
          .filter(element => element.getClientRects().length > 0);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first?.focus(); }
      }
    }}>
    <header><button type="button" className="companion-icon" aria-label="返回同行" onClick={close}><ArrowLeft size={22}/></button><div><h2>接入同行</h2><p>注册、拿 Key，再回到这里配置。</p></div></header>
    <div className="companion-setup-content">
      <p className="companion-setup-intro">先配对话就能文字试聊；听角色说话再配音色，开镜头再配识图。已有配置可直接沿用。</p>
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

      <section aria-label="识图接入"><div className="companion-setup-heading"><h3><span>02</span> 看见画面</h3><small>{visionReady ? '已填写并开启' : api.visionApi?.enabled ? '字段待补齐' : '未开启'} · 开镜头时需要</small></div>
        <p>设置 → 识图 API。选支持多张图片输入的视觉模型；每次发送最近 1–3 张截图，按平台用量计费。</p>
        <ol><li>注册视觉模型平台、获取 Key；已有可用视觉 API 可沿用。</li><li>填写 URL、Key、模型 ID，开启独立识图，保存并运行设置页的识图测试。</li></ol>
        <div className="companion-setup-actions"><button type="button" onClick={() => navigate('vision')}>去配置识图 API</button></div>
        <details open={!visionReady}><summary>智谱 GLM-4.6V 配置示例</summary>
          <div className="companion-setup-links"><ExternalLink href={links.glm.signup}>注册 / 登录智谱</ExternalLink><ExternalLink href={links.glm.keys}>获取 API Key</ExternalLink><ExternalLink href={links.glm.visionDocs}>视觉模型文档</ExternalLink></div>
          <CopyValue label="Base URL" value={links.glm.baseUrl}/><CopyValue label="模型 ID" value={links.glm.visionModel}/>
          <p>填写模型 ID 前确认账号有调用权限；不用购买视频生成服务。选择其他平台时，需使用支持 image_url 的兼容接口。</p>
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
