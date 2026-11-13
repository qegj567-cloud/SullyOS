import type { APIConfig, CharacterProfile } from '../types';
import type { AvatarTouchModelAction } from './avatarTouch';
import {
  AVATAR_PERFORMANCE_REHEARSAL_MAX_TOKENS,
  alignAvatarPerformanceCuesToSentences,
  buildAvatarPerformanceRehearsalPrompt,
  isCompleteAvatarPerformanceCuePack,
  parseAvatarPerformanceRehearsal,
  splitAvatarPerformanceSentences,
  type AvatarPerformanceSentence,
} from './avatarPerformanceRehearsal';
import type { AvatarPerformanceCue } from './avatarPerformance';
import { extractContent, safeFetchJson } from './safeApi';

export type CompanionPerformanceSentence = AvatarPerformanceSentence;

/** The spoken text owns the timeline: one deterministic beat per sentence. */
export const splitCompanionPerformanceSentences = splitAvatarPerformanceSentences;

export const alignCompanionPerformanceCuesToSentences = (
  cues: AvatarPerformanceCue[],
  spokenText: string,
): AvatarPerformanceCue[] => alignAvatarPerformanceCuesToSentences(cues, spokenText);

export interface CompanionPerformanceDirectorInput {
  character: CharacterProfile;
  apiConfig: APIConfig;
  line: string;
  translation?: string;
  modelActions?: AvatarTouchModelAction[];
}

const buildLocalPersona = (character: CharacterProfile): string => {
  const source = character.videoCallPerformancePersona || [
    character.personalityStyle,
    character.description,
    character.systemPrompt,
  ].filter(Boolean).join(' ');
  return Array.from(source.replace(/\s+/g, ' ').trim()).slice(0, 200).join('');
};

/**
 * One isolated director request. There is deliberately no retry, repair request,
 * or locally invented cue pack: an unusable response is surfaced to the user.
 */
export const requestCompanionPerformanceCues = async ({
  character,
  apiConfig,
  line,
  translation = '',
  modelActions = [],
}: CompanionPerformanceDirectorInput): Promise<AvatarPerformanceCue[]> => {
  const directorApi = character.emotionConfig?.api?.baseUrl
    ? character.emotionConfig.api
    : apiConfig;
  const baseUrl = directorApi.baseUrl?.replace(/\/+$/, '');
  if (!baseUrl) throw new Error('请先配置聊天 API URL');
  const reply = translation.trim()
    ? `${line.trim()}\n<语音>${translation.trim()}</语音>`
    : line.trim();
  if (!reply) throw new Error('请先填写开机台词');

  const spokenText = translation.trim() || line.trim();
  const sentences = splitCompanionPerformanceSentences(spokenText);
  if (!sentences.length) throw new Error('开机台词没有可编排的句子');

  const basePrompt = buildAvatarPerformanceRehearsalPrompt({
    characterName: character.name,
    personality: buildLocalPersona(character),
    reply,
    modelActions,
  });
  const sentencePlan = sentences
    .map((sentence, index) => `${index + 1}. at=${sentence.at.toFixed(4)}：${sentence.text}`)
    .join('\n');
  const prompt = `${basePrompt}

## 桌面逐句编排补充
- 严格返回 ${sentences.length} 个 cues，每句话一个 cue；每个 cue 必须同时给出 start、hold_ms、end。
- start 是句子开头动作，end 是句末动作，hold_ms 是两者之间的保持时长（120-5000ms）。
- 每句收尾要有语义：落住表情、视线或身体，而不是所有句子统一归零。

## 陪伴桌面开机演出覆盖规则
- 禁止任何随机左右转头。默认头部正中；只有台词语义明确需要时，才可在对应句 cue 中有意指定一次 nod / shake / tilt、左右视线、precision 头部角度或带头部曲线的白名单 model_actions。
- 必须严格按下面的句子表返回 ${sentences.length} 个 cues：每句话一个主动作，不可合并、不可拆分、不可增加过场拍。
- 每句可组合 emotion、一个 gesture、最多四个 face、镜头和白名单 model_actions；优先让表情、手臂、身体前后倾和模型专属动作承担变化，头部动作必须少而明确。
- faces 只是叠加层，不能作为整句的唯一变化；每个 start 和 end 至少有一个可读的 gesture、身体轮廓变化或 [motion] 模型动作。
- 白名单条目带有动作种类和语义标签。存在匹配的 [motion] 时优先采用，不能用 [expression] 冒充身体动作。
- 除非角色在这一句刻意克制，intensity 使用 0.65-0.95；充分调动头部 XYZ、身体 XYZ 和手臂，不要把精细模型压成只换表情的立绘。
- at 必须照抄句子表。不要让相邻两句使用完全相同的 gesture + face + camera 组合。

## 逐句动作表
${sentencePlan}`;
  const data = await safeFetchJson(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${directorApi.apiKey || 'sk-none'}`,
    },
    body: JSON.stringify({
      model: directorApi.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.45,
      max_tokens: AVATAR_PERFORMANCE_REHEARSAL_MAX_TOKENS,
      stream: false,
    }),
  }, 0, 30_000, {
    appName: '触感陪伴',
    charId: character.id,
    charName: character.name,
    purpose: '编排开机台词动作',
  });
  const cues = parseAvatarPerformanceRehearsal(
    extractContent(data),
    modelActions.map(action => action.id),
    sentences.length,
  );
  if (!cues?.length) throw new Error('动作导演这次没有返回可用动作；未保存，也不会重试');
  if (!isCompleteAvatarPerformanceCuePack(cues, sentences.length)) {
    throw new Error('动作导演必须为每句话返回起始动作、中段保持时长和收尾动作；这次结果未保存，也不会重试');
  }
  return alignCompanionPerformanceCuesToSentences(cues, spokenText);
};
