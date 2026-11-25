import { AppID, type APIConfig, type CharacterProfile, type TtsProvider } from '../../types';
import { resolveDialogueApi } from '../characterApi';
import { characterLaunch } from '../characterLaunch';
import { requestSettingsFocus } from '../settingsNavigation';

export type CompanionSetupTarget = 'api' | 'vision' | 'voice' | 'video' | 'stt' | 'character';

export function openCompanionSetupTarget(target: CompanionSetupTarget, charId: string | undefined, openApp: (app: AppID) => void) {
  if (target === 'character') {
    if (charId) characterLaunch.request({ charId, detailTab: 'identity' });
    openApp(AppID.Character);
  } else {
    requestSettingsFocus(target);
    openApp(AppID.Settings);
  }
}

/** Field readiness only. Opening the guide must never send test/billable requests. */
export function companionDialogueReady(api: APIConfig, char?: CharacterProfile) {
  const selected = resolveDialogueApi(api, char);
  return !!selected.baseUrl?.trim() && !!selected.model?.trim();
}

// Official destinations checked 2026-11-17. No referral links, credentials or user data in URLs.
export const COMPANION_SETUP_LINKS = {
  qwen: {
    signup: 'https://bailian.console.aliyun.com/',
    keys: 'https://help.aliyun.com/zh/model-studio/get-api-key',
    docs: 'https://help.aliyun.com/zh/model-studio/vision',
    baseUrls: 'https://help.aliyun.com/zh/model-studio/base-url',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  glm: {
    signup: 'https://open.bigmodel.cn/', keys: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    docs: 'https://docs.bigmodel.cn/cn/guide/start/quick-start',
    visionDocs: 'https://docs.bigmodel.cn/cn/guide/models/vlm/glm-4.6v',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4', visionModel: 'glm-4.6v',
  },
  doubao: {
    console: 'https://console.volcengine.com/speech/service',
    docs: 'https://docs.volcengine.com/docs/doubao-voice/console-guidance?lang=zh',
  },
} as const;

export const COMPANION_VOICE_GUIDES: Record<TtsProvider, {
  name: string; signup: string; keys: string; docs: string; voiceField: string; steps: string[];
}> = {
  elevenlabs: {
    name: 'ElevenLabs', signup: 'https://elevenlabs.io/app/sign-up', keys: 'https://elevenlabs.io/app/developers/api-keys',
    docs: 'https://elevenlabs.io/docs/api-reference/authentication', voiceField: 'ElevenLabs Voice ID',
    steps: ['注册后在 Developers → API Keys 创建可用于语音合成的 Key。',
      '到「其他 API」填写 ElevenLabs API Key，选择 ElevenLabs 为当前语音引擎并保存。',
      '在平台选一个可调用的音色，将 Voice ID 填到当前角色的 ElevenLabs 音色设置。'],
  },
  minimax: {
    name: 'MiniMax', signup: 'https://platform.minimax.cn/', keys: 'https://platform.minimax.cn/console/keys',
    docs: 'https://platform.minimaxi.com/document/T2A%20V2?key=66719005a427f0c8a5701643', voiceField: 'MiniMax Voice ID / 混音音色',
    steps: ['注册开放平台账号，创建语音 API Key；国内与海外账号需选对应服务器。',
      '到「其他 API」填写 MiniMax Key；账号需要 Group ID 时一并填写，选择 MiniMax 引擎并保存。',
      '在当前角色的语音设置中选择音色或填写 Voice ID。建议使用独立语音 Key，避免误用对话模型的 Key。'],
  },
  fishaudio: {
    name: 'Fish Audio', signup: 'https://fish.audio/auth/signup/?redirect=/app/', keys: 'https://fish.audio/app/api-keys/',
    docs: 'https://docs.fish.audio/api-reference/introduction', voiceField: 'Fish Reference ID',
    steps: ['注册 Fish Audio，在 API Keys 页面创建 Key。',
      '到「其他 API」填写 Fish Audio API Key，选择鱼声为当前语音引擎并保存。',
      '在平台选择音色，把其 Reference ID 填到当前角色的鱼声音色设置。'],
  },
};
