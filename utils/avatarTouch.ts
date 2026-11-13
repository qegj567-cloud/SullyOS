import { loadCharacterContextMessages } from './chatContextRange';
import type {
  APIConfig,
  AvatarTouchRegion,
  CharacterProfile,
  CompanionTouchReaction,
  UserProfile,
} from '../types';
import { ContextBuilder } from './context';
import { DB } from './db';
import { ChatPrompts } from './chatPrompts';
import { extractContent, extractJson, safeFetchJson } from './safeApi';
import { injectMemoryPalace } from './memoryPalace/pipeline';
import { parseCallAssistantMessage, stripCallTextFormatting } from './callReplyFormat';
import {
  DEFAULT_AVATAR_PERFORMANCE,
  inferAvatarPerformanceFromText,
  type AvatarPerformanceDirection,
} from './avatarPerformance';
import { voiceLanguagePromptLabel } from './voiceLanguage';

export const AVATAR_TOUCH_ZONES = ['head', 'face', 'hand', 'body', 'other'] as const;
export type AvatarTouchZone = typeof AVATAR_TOUCH_ZONES[number];
export const AVATAR_TOUCH_PARTS = ['hair', 'head', 'face', 'shoulder', 'arm', 'hand', 'chest', 'waist', 'body', 'other'] as const;
export type AvatarTouchPart = typeof AVATAR_TOUCH_PARTS[number];
export const DEFAULT_COMPANION_TOUCH_ZONES: AvatarTouchZone[] = ['head', 'face', 'hand', 'body'];
export type AvatarTouchReactionPack = Partial<Record<AvatarTouchZone, CompanionTouchReaction[]>>;

export interface AvatarTouchRequest {
  nonce: number;
  /** CSS-pixel coordinates in the avatar canvas. */
  x: number;
  y: number;
  /** Normalized stage coordinates, 0..1. */
  normalizedX: number;
  normalizedY: number;
  /** Peak hardware pressure when available (0..1). */
  pressure?: number;
  /** Press duration; used as a force fallback on devices without pressure sensors. */
  durationMs?: number;
  pointerType?: 'mouse' | 'touch' | 'pen' | 'unknown';
}

export interface AvatarTouchHit extends AvatarTouchRequest {
  zone: AvatarTouchZone;
  /** Precise visual target; zone remains the backward-compatible reaction bucket. */
  part?: AvatarTouchPart;
  source: 'live2d-custom-region' | 'live2d-hit-area' | 'live2d-bounds' | 'vrm-raycast' | 'portrait-bounds';
  rawAreas: string[];
}

export interface AvatarTouchRecord {
  id: string;
  zone: AvatarTouchZone;
  part?: AvatarTouchPart;
  rawAreas: string[];
  timestamp: number;
}

export interface AvatarTouchReply {
  text: string;
  performance: AvatarPerformanceDirection;
}

export interface AvatarTouchModelAction {
  id: string;
  name: string;
  kind?: 'motion' | 'expression' | 'params';
  tags?: string[];
}

export type AvatarTouchPackOutputMode = 'full' | 'expression' | 'text';

const formatAvatarTouchModelAction = (action: AvatarTouchModelAction): string => {
  const capabilities = [action.kind, ...(action.tags || []).slice(0, 4)].filter(Boolean).join(' / ');
  return `- ${action.id}: ${action.name}${capabilities ? ` [${capabilities}]` : ''}`;
};

const ZONE_LABELS: Record<AvatarTouchZone, string> = {
  head: '头顶或头发',
  face: '脸颊或脸部',
  hand: '手或手臂',
  body: '肩膀或身体',
  other: '角色身边',
};

export const avatarTouchZoneLabel = (zone: AvatarTouchZone): string => ZONE_LABELS[zone];

const TOAST_ZONE_LABELS: Record<AvatarTouchZone, string> = {
  head: '头发',
  face: '脸颊',
  hand: '手',
  body: '肩膀',
  other: '身边',
};

export const avatarTouchZoneToastLabel = (zone: AvatarTouchZone): string => TOAST_ZONE_LABELS[zone];

const TOUCH_PART_LABELS: Record<AvatarTouchPart, string> = {
  hair: '头发',
  head: '头顶',
  face: '脸',
  shoulder: '肩膀',
  arm: '手臂',
  hand: '手',
  chest: '胸口',
  waist: '腰部',
  body: '身体',
  other: '身边',
};

export const avatarTouchPartLabel = (part: AvatarTouchPart): string => TOUCH_PART_LABELS[part];

export const avatarTouchTargetLabel = (
  hit: Pick<AvatarTouchHit, 'zone' | 'part'>,
): string => hit.part ? avatarTouchPartLabel(hit.part) : avatarTouchZoneToastLabel(hit.zone);

export const normalizeCompanionDialogue = (raw: string, characterName = ''): string => {
  const escapedName = characterName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return stripCallTextFormatting(raw)
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(new RegExp(`^(?:${escapedName ? `${escapedName}|` : ''}角色|assistant)\\s*[：:]\\s*`, 'i'), '')
    .replace(/[”」』]\s*[“「『]/g, '\n')
    .replace(/\.{3,}/g, '……')
    .replace(/…{3,}/g, '……')
    .split('\n')
    .map(line => line.trim().replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, '').trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

export const createAvatarTouchRecord = (
  hit: Pick<AvatarTouchHit, 'zone' | 'part' | 'rawAreas'>,
  timestamp = Date.now(),
): AvatarTouchRecord => ({
  id: `${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
  zone: hit.zone,
  ...(hit.part ? { part: hit.part } : {}),
  rawAreas: hit.rawAreas.slice(0, 8),
  timestamp,
});

export const appendPendingAvatarTouch = (
  records: AvatarTouchRecord[],
  record: AvatarTouchRecord,
  maxRecords = 20,
): AvatarTouchRecord[] => [...records, record].slice(-Math.max(1, maxRecords));

export const consumePendingAvatarTouches = (
  records: AvatarTouchRecord[],
  consumed: AvatarTouchRecord[],
): AvatarTouchRecord[] => {
  if (!consumed.length) return records;
  const consumedIds = new Set(consumed.map(record => record.id));
  return records.filter(record => !consumedIds.has(record.id));
};

export const buildPendingAvatarTouchContext = (
  records: AvatarTouchRecord[],
  characterName: string,
  userName: string,
): string => {
  if (!records.length) return '';
  const counts = new Map<string, number>();
  records.forEach(record => {
    const label = avatarTouchTargetLabel(record);
    counts.set(label, (counts.get(label) || 0) + 1);
  });
  const details = [...counts]
    .map(([label, count]) => `${label}${count}次`)
    .join('、');
  const action = records.length === 1
    ? `${userName}在开口前戳了戳${characterName}的${avatarTouchTargetLabel(records[0])}`
    : `${userName}在开口前连续戳了${characterName}${records.length}次（${details}）`;
  return `[本轮尚未回应的触碰互动]\n${action}。这些动作已经在本地发生过，但你还没有用语言回应。请在回答用户本轮话语时自然地顺带接住它们，不要逐条播报、不要解释系统，也不要把触碰当成一条单独的新消息。`;
};

export const isAvatarTouchGesture = (
  maxDistance: number,
  durationMs: number,
  wasSinglePointer: boolean,
): boolean => (
  wasSinglePointer
  && Number.isFinite(maxDistance)
  && maxDistance <= 10
  && durationMs >= 0
  && durationMs <= 650
);

export const resolveAvatarTouchForce = (
  touch: Pick<AvatarTouchRequest, 'pressure' | 'durationMs' | 'pointerType'>,
): number => {
  const duration = Math.max(0, Math.min(650, Number(touch.durationMs) || 0));
  const durationForce = 0.3 + (duration / 650) * 0.62;
  const hardwarePressure = touch.pointerType === 'mouse'
    ? 0
    : Math.max(0, Math.min(1, Number(touch.pressure) || 0));
  return Math.max(0.3, Math.min(1, Math.max(durationForce, hardwarePressure)));
};

export const applyAvatarTouchForce = (
  direction: AvatarPerformanceDirection,
  touch: Pick<AvatarTouchRequest, 'pressure' | 'durationMs' | 'pointerType'>,
): AvatarPerformanceDirection => {
  const force = resolveAvatarTouchForce(touch);
  // A touch is a discrete physical event, so even an old cached AI reaction
  // with an overly timid intensity must remain readable on the desktop stage.
  // Pressure/hold time still decides how far above that visible floor it goes.
  const visibleTouchFloor = 0.52 + force * 0.28;
  return {
    ...direction,
    intensity: Math.max(visibleTouchFloor, Math.min(1, direction.intensity * (0.72 + force * 0.46))),
  };
};

const zoneForTouchPart = (part: AvatarTouchPart): AvatarTouchZone => {
  if (part === 'hair' || part === 'head') return 'head';
  if (part === 'face') return 'face';
  if (part === 'hand' || part === 'arm') return 'hand';
  if (part === 'shoulder' || part === 'chest' || part === 'waist' || part === 'body') return 'body';
  return 'other';
};

const partForTouchZone = (zone: AvatarTouchZone): AvatarTouchPart => {
  if (zone === 'head') return 'head';
  if (zone === 'face') return 'face';
  if (zone === 'hand') return 'hand';
  if (zone === 'body') return 'body';
  return 'other';
};

/**
 * Resolve user-authored model-local ellipses. Smaller overlapping regions win,
 * so a face ellipse can safely sit inside a larger head ellipse.
 */
export const resolveAvatarTouchRegion = (
  regions: AvatarTouchRegion[] | undefined,
  normalizedX: number,
  normalizedY: number,
): { zone: AvatarTouchZone; part: AvatarTouchPart; regionId: string } | null => {
  if (!Array.isArray(regions) || !Number.isFinite(normalizedX) || !Number.isFinite(normalizedY)) return null;
  const hit = regions
    .filter(region => (
      AVATAR_TOUCH_ZONES.includes(region.zone as AvatarTouchZone)
      && Number.isFinite(region.x)
      && Number.isFinite(region.y)
      && Number.isFinite(region.width)
      && Number.isFinite(region.height)
      && region.width > 0
      && region.height > 0
    ))
    .filter(region => {
      const radiusX = region.width / 2;
      const radiusY = region.height / 2;
      const dx = (normalizedX - region.x) / radiusX;
      const dy = (normalizedY - region.y) / radiusY;
      return dx * dx + dy * dy <= 1;
    })
    .sort((a, b) => a.width * a.height - b.width * b.height)[0];
  if (!hit) return null;
  return { zone: hit.zone, part: partForTouchZone(hit.zone), regionId: hit.id };
};

const geometricTouchPart = (fallbackY: number, fallbackX: number): AvatarTouchPart => {
  const x = Math.max(0, Math.min(1, fallbackX));
  const y = Math.max(0, Math.min(1, fallbackY));
  if (y < 0.14) return 'hair';
  if (y < 0.34) return x > 0.22 && x < 0.78 ? 'face' : 'hair';
  if (y < 0.5) {
    if (x < 0.18 || x > 0.82) return 'arm';
    if (x < 0.4 || x > 0.6) return 'shoulder';
    return 'chest';
  }
  if (y < 0.72) return x < 0.25 || x > 0.75 ? 'arm' : 'chest';
  if (y < 0.9) return 'waist';
  return 'other';
};

export const resolveAvatarTouchTarget = (
  rawAreas: string[],
  fallbackY?: number,
  fallbackX?: number,
): { zone: AvatarTouchZone; part: AvatarTouchPart } => {
  const value = rawAreas.join(' ').toLowerCase();
  const precisePart = /(face|cheek|mouth|eye|nose|lip|脸|面|頬|顏|眼|嘴|鼻)/i.test(value) ? 'face'
    : /(hair|bang|fringe|ahoge|髪|发|髮|刘海|瀏海)/i.test(value) ? 'hair'
      : /(hand|finger|palm|wrist|手|指|掌|腕)/i.test(value) ? 'hand'
        : /(forearm|upperarm|lowerarm|arm|sleeve|elbow|手臂|胳膊|臂|袖|肘)/i.test(value) ? 'arm'
          : /(shoulder|clavicle|肩|锁骨|鎖骨)/i.test(value) ? 'shoulder'
            : /(chest|bust|breast|胸)/i.test(value) ? 'chest'
              : /(waist|hip|pelvis|腰|胯|臀)/i.test(value) ? 'waist'
                : null;
  if (precisePart) return { zone: zoneForTouchPart(precisePart), part: precisePart };

  const hasGeometry = Number.isFinite(fallbackY) && Number.isFinite(fallbackX);
  const genericHead = /(head|hat|ear|头|頭|帽|耳)/i.test(value);
  const genericBody = /(body|torso|身体|身體|躯干|軀幹)/i.test(value);
  if (hasGeometry) {
    const part = geometricTouchPart(fallbackY!, fallbackX!);
    return { zone: zoneForTouchPart(part), part };
  }
  if (genericHead) return { zone: 'head', part: 'head' };
  if (genericBody) return { zone: 'body', part: 'body' };
  return { zone: 'other', part: 'other' };
};

export const normalizeAvatarTouchZone = (
  rawAreas: string[],
  fallbackY?: number,
  fallbackX?: number,
): AvatarTouchZone => resolveAvatarTouchTarget(rawAreas, fallbackY, fallbackX).zone;

export const buildImmediateTouchPerformance = (zone: AvatarTouchZone): AvatarPerformanceDirection => {
  if (zone === 'head') {
    return {
      emotion: 'happy',
      gesture: 'tilt',
      camera: 'medium',
      gaze: 'viewer',
      intensity: 0.62,
      faces: ['smile-eyes'],
    };
  }
  if (zone === 'face') {
    return {
      emotion: 'surprised',
      gesture: 'shy',
      camera: 'close',
      gaze: 'down',
      intensity: 0.76,
      faces: ['blush'],
    };
  }
  if (zone === 'hand') {
    return {
      emotion: 'happy',
      gesture: 'wave',
      camera: 'medium',
      gaze: 'viewer',
      intensity: 0.68,
    };
  }
  if (zone === 'body') {
    return {
      emotion: 'surprised',
      gesture: 'lean-back',
      camera: 'medium',
      gaze: 'viewer',
      intensity: 0.7,
      faces: ['brow-up'],
    };
  }
  return { ...DEFAULT_AVATAR_PERFORMANCE, gesture: 'tilt', intensity: 0.5 };
};

export const buildAvatarTouchSystemPrompt = (
  coreContext: string,
  characterName: string,
  userName: string,
  hit: Pick<AvatarTouchHit, 'zone' | 'part' | 'rawAreas'>,
  modelActions: AvatarTouchModelAction[] = [],
): string => {
  const actionList = modelActions.length
    ? modelActions.slice(0, 60).map(formatAvatarTouchModelAction).join('\n')
    : '（当前没有模型专属动作）';
  return `${coreContext}

### 桌面 Live2D 动作优先级
- 表情只是叠加层，不是完整演出；必须同时给出肉眼可见的手势或身体反应。
- 白名单中存在语义匹配的 [motion] 时优先选用；不能拿一个表情动作代替匹配的身体动作。
- 物理触碰反馈的 intensity 通常应在 0.68-1.0；只有角色刻意压住反应时才使用更低数值。
- 让头部 XYZ 与身体 XYZ 都参与：触碰值得回应时，应从 nod/shake/tilt/explain/wave/shy/lean-in/lean-back 中选，不要只给 idle/talk。

### 当前面对面的触碰互动
${userName}刚刚轻轻触碰了${characterName}的「${avatarTouchTargetLabel(hit)}」。
模型命中区原名：${hit.rawAreas.length ? hit.rawAreas.join('、') : '自动识别区域'}。

这是一次真实、低频的面对面互动。请直接以${characterName}本人回应：
- 必须结合完整人设、你们的关系、近期对话与记忆，不要写成通用触摸玩偶台词。
- 可以喜欢、害羞、意外、躲开、拒绝或生气；边界与亲密程度必须符合角色本人。
- 只说自然的一至三句短台词，不要解释系统、模型、命中区或提示词。
- 台词前先输出一条隐藏演出指令，格式：
  [[AVATAR: emotion=happy; gesture=tilt; gaze=viewer; intensity=0.7]]
- emotion 可用 neutral/happy/sad/angry/fearful/disgusted/surprised/calm/relaxed。
- gesture 可用 idle/talk/nod/shake/tilt/explain/wave/shy/lean-in/lean-back。
- 可按需附加 face=wink,blush 或 model_action=下列白名单ID；不合适就省略，禁止编造。

模型专属动作白名单：
${actionList}`;
};

const sanitizePerformanceActions = (
  performance: AvatarPerformanceDirection,
  allowedActionIds: Set<string>,
): AvatarPerformanceDirection => {
  const modelAction = performance.modelAction && allowedActionIds.has(performance.modelAction)
    ? performance.modelAction
    : undefined;
  const modelActions = performance.modelActions?.filter(id => allowedActionIds.has(id)).slice(0, 2);
  return {
    ...performance,
    ...(modelAction ? { modelAction } : {}),
    ...(modelActions?.length ? { modelActions } : {}),
    ...(!modelAction ? { modelAction: undefined } : {}),
  };
};

export const parseAvatarTouchReply = (
  message: unknown,
  allowedModelActions: AvatarTouchModelAction[] = [],
): AvatarTouchReply | null => {
  const parsed = parseCallAssistantMessage(message);
  const text = parsed.text.trim();
  if (!text) return null;
  const performance = parsed.performance || inferAvatarPerformanceFromText(text);
  return {
    text,
    performance: sanitizePerformanceActions(
      performance,
      new Set(allowedModelActions.map(action => action.id)),
    ),
  };
};

export const requestAvatarTouchReply = async (options: {
  character: CharacterProfile;
  user: UserProfile;
  apiConfig: APIConfig;
  hit: AvatarTouchHit;
  modelActions?: AvatarTouchModelAction[];
}): Promise<AvatarTouchReply> => {

  const {
    character,
    user,
    apiConfig,
    hit,
    modelActions = [],
  } = options;
  const baseUrl = apiConfig.baseUrl?.replace(/\/+$/, '');
  if (!baseUrl) throw new Error('请先在设置中配置主聊天 API');

  const [allMessages, emojis] = await Promise.all([
    loadCharacterContextMessages(character),
    DB.getEmojis().catch(() => []),
  ]);
  const recentMessages = allMessages
    .filter(message => message.role === 'user' || message.role === 'assistant');
  const eventText = `[面对面触碰互动] ${user.name || '用户'}轻轻触碰了你的${avatarTouchTargetLabel(hit)}。`;

  await injectMemoryPalace(
    character,
    allMessages,
    eventText,
    user.name,
  );
  const lastInteractionTs = recentMessages[recentMessages.length - 1]?.timestamp;
  const characterContextInput = { char: character, user, includeDetailedMemories: true, timeOptions: {
      lastInteractionTs,
      worldbookMessages: [
        ...recentMessages.map(message => ({ role: message.role, content: message.content })),
        { role: 'user', content: eventText },
      ],
    } };

  const { apiMessages } = ChatPrompts.buildMessageHistory(
    recentMessages,
    recentMessages.length,
    character,
    user,
    emojis,
  );
  const systemPrompt = buildAvatarTouchSystemPrompt(
    '',
    character.name,
    user.name || '用户',
    hit,
    modelActions,
  );
  const data = await safeFetchJson(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiConfig.apiKey || 'sk-none'}`,
    },
    body: JSON.stringify({
      model: apiConfig.model,
      messages: (await ContextBuilder.buildCharacterRequest(characterContextInput, [
        { role: 'system', content: systemPrompt },
        ...apiMessages,
        { role: 'user', content: eventText },
      ])),
      temperature: 0.9,
      max_tokens: 1200,
      stream: false,
    }),
  }, 1, 45_000, {
    appName: '触感陪伴',
    charId: character.id,
    charName: character.name,
    purpose: '角色触碰回应',
  });
  const reply = parseAvatarTouchReply(data?.choices?.[0]?.message, modelActions)
    || parseAvatarTouchReply({ content: extractContent(data) }, modelActions);
  if (!reply) throw new Error('主模型没有返回可显示的触碰回应');
  return reply;
};

export const buildAvatarTouchReactionPackPrompt = (
  coreContext: string,
  characterName: string,
  userName: string,
  zones: AvatarTouchZone[],
  modelActions: AvatarTouchModelAction[] = [],
  reactionsPerZone = 4,
  voiceLanguage = '',
  outputMode: AvatarTouchPackOutputMode = 'full',
): string => {
  const actionList = modelActions.length
    ? modelActions.slice(0, 60).map(formatAvatarTouchModelAction).join('\n')
    : '（当前没有模型专属动作）';
  const zoneList = zones.map(zone => `- ${zone}: ${avatarTouchZoneLabel(zone)}`).join('\n');
  const spokenLanguage = voiceLanguage ? voiceLanguagePromptLabel(voiceLanguage) : '简体中文（与原文一致）';
  const schema = Object.fromEntries(zones.map(zone => [
    zone,
    Array.from({ length: reactionsPerZone }, (_, index) => {
      const base = {
        text: `第${index + 1}句角色台词`,
        translation: voiceLanguage ? `第${index + 1}句${spokenLanguage}口语译文` : `第${index + 1}句角色台词`,
      };
      if (outputMode === 'text') return base;
      if (outputMode === 'expression') return {
        ...base,
        performance: { emotion: 'happy' },
      };
      return {
        ...base,
        performance: {
          emotion: 'happy', gesture: 'tilt', camera: 'medium', gaze: 'viewer', intensity: 0.7,
          faces: ['smile-eyes'],
        },
      };
    }),
  ]));
  const performanceRules = outputMode === 'text'
    ? `### 静态单图输出规则
- 当前形象只有一张 PNG / GIF，不存在可调用的动作或表情资源。
- 你只需要写角色台词。不要输出 performance、动作指令、表情标签、镜头、视线或模型动作。`
    : outputMode === 'expression'
      ? `### 见面立绘表情规则
- 当前使用见面模式立绘，只需要为每句选择 emotion，不需要生成手势、身体动作、镜头、视线或模型动作。
- emotion 只使用 normal / happy / angry / sad / shy；它会直接切换当前衣服对应的表情立绘。`
      : `### 桌面 Live2D 动作优先级
- 每条缓存反馈都必须包含肉眼可见的手势或身体拍点；只有 faces 变化视为不完整。
- 白名单动作带有 [motion] / [expression] / [params] 能力标记；语义匹配时优先使用 [motion]，表情与参数只能作为叠加层。
- 大多数反馈的 intensity 使用 0.68-1.0，让精细的头部/身体 XYZ 绑定真正动起来；只有刻意克制的角色时刻才保持轻微。
- 同一部位的多条反馈要改变身体轮廓（转、歪、靠近、后缩、解释或挥手），不要生成四条仅表情不同的变体。`;
  const itemRule = outputMode === 'text'
    ? '- 每一项必须只有 {"text":"中文原文","translation":"语音译文"}。'
    : outputMode === 'expression'
      ? '- 每一项必须是 {"text":"中文原文","translation":"语音译文","performance":{"emotion":"五类表情之一"}}。'
      : '- 每一项必须是 {"text":"中文原文","translation":"语音译文","performance":{...}}；演出数据不要混进台词字段。\n- performance 必须给出 emotion、gesture、camera、gaze、intensity；可按需附加 faces 或 modelAction 白名单 ID，禁止编造模型动作。';
  return `${coreContext}

${performanceRules}

### 触感陪伴桌面 · 一次性反馈包
${userName}正在为${characterName}设置可触摸部位。请一次生成完整反馈包；保存后，桌面只会在本地轮播这些结果，不会每次触摸都再次请求你。

需要生成的部位：
${zoneList}

  要求：
  - 每个部位恰好生成 ${reactionsPerZone} 条彼此有区别、可独立成立的一至三句短台词。
  - text 是界面显示的原文，必须使用简体中文；translation 是真正送入语音合成的${spokenLanguage}版本。两者必须语义一致，但字段不可合并或省略。
- 必须结合完整人设、你们的关系、近期对话与记忆；允许喜欢、害羞、意外、躲开、拒绝或生气，边界必须符合角色本人。
- 台词只能包含角色真正说出口的话。不要写动作旁白、引号、角色名前缀、Markdown、命中区、系统解释或半截续句。
${itemRule}
- 只输出一个合法 JSON 对象，不要代码围栏，不要 JSON 以外的文字。顶层键必须逐字使用上面的英文部位 ID，不要翻译或合并部位。

${outputMode === 'full' ? `模型专属动作白名单：\n${actionList}` : ''}

严格按照这个结构输出：
${JSON.stringify(schema, null, 2)}`;
};

const TOUCH_ZONE_ALIASES: Record<AvatarTouchZone, string[]> = {
  head: ['head', 'heads', 'hair', 'top', '头', '头部', '头顶', '头发', '头顶或头发'],
  face: ['face', 'faces', 'cheek', 'mouth', '脸', '脸颊', '面部', '脸颊或脸部'],
  hand: ['hand', 'hands', 'arm', 'arms', 'wrist', '手', '手臂', '胳膊', '手或手臂'],
  body: ['body', 'bodies', 'chest', 'torso', 'shoulder', 'shoulders', 'waist', '身体', '肩膀', '胸口', '腰', '肩膀或身体'],
  other: ['other', 'around', 'nearby', 'surroundings', 'else', '其他', '身边', '角色身边'],
};

const normalizePackKey = (value: string): string => value
  .toLowerCase()
  .replace(/[\s_\-.:：·/\\]+/g, '');

const asReactionPackRoot = (value: unknown): Record<string, unknown> | null => {
  if (typeof value === 'string') {
    try { return asReactionPackRoot(JSON.parse(value)); } catch { return null; }
  }
  if (Array.isArray(value)) {
    const grouped: Record<string, unknown[]> = {};
    value.forEach(item => {
      if (!item || typeof item !== 'object') return;
      const record = item as Record<string, unknown>;
      const zone = record.zone || record.part || record.area || record.target;
      if (typeof zone !== 'string') return;
      const collection = ['items', 'reactions', 'feedbacks', 'responses', 'lines', 'variants']
        .map(key => record[key])
        .find(Array.isArray);
      if (Array.isArray(collection)) (grouped[zone] ||= []).push(...collection);
      else (grouped[zone] ||= []).push(record);
    });
    return Object.keys(grouped).length ? grouped : null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of ['reactions', 'feedbacks', 'responses', 'pack', 'result', 'data']) {
    const nested = record[key];
    if (nested && typeof nested === 'object') return asReactionPackRoot(nested);
  }
  return record;
};

const extractBalancedJson = (content: string): string[] => {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === '{' || char === '[') {
      if (depth === 0) start = index;
      depth += 1;
    } else if ((char === '}' || char === ']') && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(content.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return candidates;
};

const readReactionPackSource = (
  raw: unknown,
  zones: AvatarTouchZone[],
): Record<string, unknown> | null => {
  const direct = asReactionPackRoot(raw);
  const messageContent = (raw as any)?.choices?.[0]?.message?.content ?? (raw as any)?.content;
  const blockContent = Array.isArray(messageContent)
    ? messageContent.map(block => (
      typeof block === 'string'
        ? block
        : typeof block?.text === 'string' ? block.text : typeof block?.content === 'string' ? block.content : ''
    )).join('')
    : '';
  const content = typeof raw === 'string' ? raw
    : typeof messageContent === 'string' ? messageContent
      : blockContent || extractContent(raw as any);
  const fenced = [...content.matchAll(/```(?:json|javascript|js)?\s*([\s\S]*?)```/gi)].map(match => match[1]);
  const cleaned = content.replace(/^\uFEFF/, '').trim();
  const candidates = [cleaned, ...fenced, ...extractBalancedJson(cleaned)]
    .filter(Boolean)
    .flatMap(candidate => [
      candidate,
      candidate.replace(/,\s*([}\]])/g, '$1'),
    ]);
  for (const candidate of candidates) {
    try {
      const root = asReactionPackRoot(JSON.parse(candidate));
      if (root) return root;
    } catch { /* try the next conservative repair */ }
  }
  const tolerant = cleaned.includes('{') ? extractJson(cleaned) : null;
  const tolerantRoot = asReactionPackRoot(tolerant);
  if (tolerantRoot) return tolerantRoot;

  if (direct && zones.some(zone => {
    const aliases = TOUCH_ZONE_ALIASES[zone].map(normalizePackKey);
    return Object.keys(direct).some(key => {
      const normalized = normalizePackKey(key);
      return aliases.some(alias => normalized === alias || normalized.endsWith(alias));
    });
  })) return direct;

  // Last resort for otherwise useful markdown such as "head:\n- line".
  const sections: Record<string, unknown> = {};
  const heading = new RegExp(`(?:^|\\n)\\s*(?:#{1,6}\\s*)?(?:["'【[])?(${zones.flatMap(zone => TOUCH_ZONE_ALIASES[zone]).join('|')})(?:["'】\\]])?\\s*[:：]\\s*`, 'gi');
  const matches = [...cleaned.matchAll(heading)];
  matches.forEach((match, index) => {
    const key = match[1];
    const bodyStart = (match.index || 0) + match[0].length;
    const bodyEnd = index + 1 < matches.length ? (matches[index + 1].index || cleaned.length) : cleaned.length;
    const lines = cleaned.slice(bodyStart, bodyEnd)
      .split('\n')
      .map(line => line.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, '').trim())
      .filter(Boolean);
    if (lines.length) sections[key] = lines;
  });
  return Object.keys(sections).length ? sections : null;
};

const readZoneValue = (source: Record<string, unknown>, zone: AvatarTouchZone): unknown => {
  const aliases = TOUCH_ZONE_ALIASES[zone].map(normalizePackKey);
  const entry = Object.entries(source).find(([key]) => {
    const normalized = normalizePackKey(key);
    return aliases.some(alias => normalized === alias || normalized.endsWith(alias));
  });
  return entry?.[1];
};

const asReactionItems = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  for (const key of ['items', 'reactions', 'feedbacks', 'responses', 'lines', 'variants']) {
    const nested = record[key];
    if (Array.isArray(nested)) return nested;
    if (typeof nested === 'string') return [nested];
  }
  if (['text', 'line', 'dialogue', 'reply', 'content', 'response'].some(key => typeof record[key] === 'string')) {
    return [record];
  }
  return Object.values(record).filter(item => typeof item === 'string' || Boolean(item && typeof item === 'object'));
};

const structuredPerformanceDirective = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  const fields = ['emotion', 'gesture', 'camera', 'gaze', 'intensity', 'face', 'faces', 'model_action', 'modelAction']
    .flatMap(key => {
      const field = record[key];
      if (field === undefined || field === null || field === '') return [];
      const normalizedKey = key === 'modelAction' ? 'model_action' : key === 'faces' ? 'face' : key;
      const normalizedField = normalizedKey === 'emotion' && field === 'normal'
        ? 'neutral'
        : normalizedKey === 'emotion' && field === 'shy' ? 'surprised' : field;
      return [`${normalizedKey}=${Array.isArray(normalizedField) ? normalizedField.join(',') : String(normalizedField)}`];
    });
  return fields.length ? `[[AVATAR: ${fields.join('; ')}]]` : '';
};

const reactionItemContent = (item: unknown): string => {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return '';
  const record = item as Record<string, unknown>;
  const text = ['text', 'line', 'dialogue', 'reply', 'content', 'response']
    .map(key => record[key])
    .find(value => typeof value === 'string');
  const performance = record.avatar || record.performance || record.direction || record.action || record;
  return `${structuredPerformanceDirective(performance)}\n${typeof text === 'string' ? text : ''}`.trim();
};

const reactionItemTranslation = (item: unknown): string => {
  if (!item || typeof item !== 'object') return '';
  const record = item as Record<string, unknown>;
  const translation = ['translation', 'translatedText', 'speechText', 'voiceText']
    .map(key => record[key])
    .find(value => typeof value === 'string');
  return typeof translation === 'string' ? translation : '';
};

export const parseAvatarTouchReactionPackPartial = (
  raw: unknown,
  zones: AvatarTouchZone[],
  allowedModelActions: AvatarTouchModelAction[] = [],
  voiceLanguage = '',
): AvatarTouchReactionPack => {
  const source = readReactionPackSource(raw, zones);
  if (!source) return {};
  const pack: AvatarTouchReactionPack = {};
  zones.forEach(zone => {
    const reactions = asReactionItems(readZoneValue(source, zone)).flatMap((item, index): CompanionTouchReaction[] => {
      const reply = parseAvatarTouchReply({ content: reactionItemContent(item) }, allowedModelActions);
      if (!reply) return [];
      const text = normalizeCompanionDialogue(reply.text);
      if (!text) return [];
      const translated = normalizeCompanionDialogue(reactionItemTranslation(item));
      if (voiceLanguage && !translated) return [];
      return [{
        id: `${zone}-${index + 1}`,
        text,
        translation: translated || text,
        performance: reply.performance,
      }];
    }).slice(0, 6);
    if (reactions.length) pack[zone] = reactions;
  });
  return pack;
};

export const parseAvatarTouchReactionPack = (
  raw: unknown,
  zones: AvatarTouchZone[],
  allowedModelActions: AvatarTouchModelAction[] = [],
  voiceLanguage = '',
): AvatarTouchReactionPack | null => {
  const pack = parseAvatarTouchReactionPackPartial(raw, zones, allowedModelActions, voiceLanguage);
  return zones.every(zone => pack[zone]?.length) ? pack : null;
};

export const requestAvatarTouchReactionPack = async (options: {
  character: CharacterProfile;
  user: UserProfile;
  apiConfig: APIConfig;
  zones: AvatarTouchZone[];
  modelActions?: AvatarTouchModelAction[];
  reactionsPerZone?: number;
  voiceLanguage?: string;
  outputMode?: AvatarTouchPackOutputMode;
}): Promise<AvatarTouchReactionPack> => {

  const {
    character,
    user,
    apiConfig,
    zones,
    modelActions = [],
    reactionsPerZone = 4,
    voiceLanguage = '',
    outputMode = 'full',
  } = options;
  const selectedZones = [...new Set(zones)].filter(zone => AVATAR_TOUCH_ZONES.includes(zone));
  if (!selectedZones.length) throw new Error('请至少选择一个可触摸部位');
  const baseUrl = apiConfig.baseUrl?.replace(/\/+$/, '');
  if (!baseUrl) throw new Error('请先在设置中配置主聊天 API');

  const [allMessages, emojis] = await Promise.all([
    loadCharacterContextMessages(character),
    DB.getEmojis().catch(() => []),
  ]);
  const recentMessages = allMessages
    .filter(message => message.role === 'user' || message.role === 'assistant');
  const eventText = `[桌面触摸设置] ${user.name || '用户'}选择了一次性生成${selectedZones.map(avatarTouchZoneLabel).join('、')}的反馈包。`;
  const lastInteractionTs = recentMessages[recentMessages.length - 1]?.timestamp;
  const characterContextInput = { char: character, user, includeDetailedMemories: true, timeOptions: {
      lastInteractionTs,
      worldbookMessages: [
        ...recentMessages.map(message => ({ role: message.role, content: message.content })),
        { role: 'user', content: eventText },
      ],
    } };

  const { apiMessages } = ChatPrompts.buildMessageHistory(
    recentMessages,
    recentMessages.length,
    character,
    user,
    emojis,
  );
  const boundedReactionCount = Math.max(3, Math.min(6, reactionsPerZone));
  const systemPrompt = buildAvatarTouchReactionPackPrompt(
    '',
    character.name,
    user.name || '用户',
    selectedZones,
    modelActions,
    boundedReactionCount,
    voiceLanguage,
    outputMode,
  );
  const data = await safeFetchJson(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiConfig.apiKey || 'sk-none'}`,
    },
    body: JSON.stringify({
      model: apiConfig.model,
      messages: (await ContextBuilder.buildCharacterRequest(characterContextInput, [
        { role: 'system', content: systemPrompt },
        ...apiMessages,
        { role: 'user', content: eventText },
      ])),
      temperature: 0.92,
      max_tokens: 4800,
      stream: false,
    }),
  // A complete pack can contain dozens of lines plus translations and
  // performance data.  The previous 60s wall-clock timeout also kept ticking
  // while a healthy streamed response was arriving, so slower providers were
  // locally aborted at almost exactly 60s. Keep this a single model attempt,
  // but align its timeout policy with normal chat instead of killing valid
  // long generations before the optional TTS phase has even started.
  }, 0, 0, {
    appId: 'companion',
    appName: '触感陪伴',
    charId: character.id,
    charName: character.name,
    purpose: '一次性生成桌面触摸反馈包（不重试）',
  });
  const pack = parseAvatarTouchReactionPackPartial(data, selectedZones, modelActions, voiceLanguage);
  const incompleteZones = selectedZones.filter(zone => (pack[zone]?.length || 0) < boundedReactionCount);
  if (incompleteZones.length) {
    const details = incompleteZones
      .map(zone => `${avatarTouchZoneLabel(zone)} ${(pack[zone]?.length || 0)}/${boundedReactionCount}`)
      .join('、');
    throw new Error(`模型回复不完整：${details}。本次未保存，只请求了这一次`);
  }
  selectedZones.forEach(zone => { pack[zone] = pack[zone]!.slice(0, boundedReactionCount); });
  return pack;
};
