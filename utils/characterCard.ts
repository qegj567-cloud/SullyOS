import { CharacterProfile } from '../types';

/**
 * 角色卡分享时必须剥离的字段清单。
 *
 * 角色卡是拿来分享「角色」本身的（人设、世界观、立绘、世界书……），
 * 不该把发卡人自己的私密凭据、界面美化、本地偏好和运行时残留一起带出去。
 * 历史上导出走的是「黑名单只剔 6 个字段、其余 ...cardProps 全导出」的写法，
 * 导致下面这些东西全被打包进卡里，别人一导入就整套接管——尤其是 API 密钥，
 * 属于灾难级泄漏。这里改成一份显式清单，**导出时不写出、导入时也不读入**，
 * 双向都过一遍：即便别人给你一张老版本（已经把密钥打进去的）卡，导入这侧也会剥掉。
 *
 * 分四类：
 *  1) 凭据：任何内嵌 API key 的配置对象，整体剔除（emotion buff / 向量 / 主动消息副 API）。
 *  2) 美化：主题、白框 CSS、气泡、背景、提示音、思考链样式——接收方用自己的。
 *  3) 语言：各处语音语言 / 开关偏好——接收方的本地偏好，不该被卡覆盖。
 *  4) 运行时状态：buff、宫殿注入、见面/小屋存档、查手机数据等发卡人当下状态残留。
 */
export const CARD_STRIPPED_FIELDS = [
  // 1) 凭据（含 apiKey，灾难级泄漏）
  'dialogueApi',
  'emotionConfig',
  'embeddingConfig',
  'proactiveConfig',
  'activeMsg2Config',

  // 2) 美化
  'embeddedTheme',           // CharacterExportData 上的内嵌主题（导入侧一并剥离）
  'bubbleStyle',
  'chatFineTune',            // 聊天装扮（细节微调的角色级覆盖）：发卡人的界面偏好，接收方用自己的
  'chromeCustomCss',
  'chatSound',
  'chatSoundBound',
  'chatBackground',
  'dateBackground',
  'thinkingChainStyle',
  'thinkingChainCustomColors',
  'thinkingChainCustomPrompt',
  'thinkingChainCustomCss',
  'chatCollaborationEnabled', // 用户在本机选择的日常聊天注意力模式
  'chatShowRemark',          // 聊天顶栏显示备注还是名字，由接收方自己决定

  // 3) 语言 / 语音 / 组织类本地偏好
  'groupId',                 // 角色分组是发卡人自己的整理方式，指向的分组 id 在接收方本地也不存在
  'chatVoiceLang',
  'dateVoiceLang',
  'callVoiceLang',
  'chatVoiceEnabled',
  'chatVoiceAutoPlay',
  'dateVoiceEnabled',
  'dateExtraPresets',        // 用户私有补充预设随系统备份保存，不随角色卡分享
  'memoryPalaceWaterline', // 发卡人的使用节奏；接收方按自己的聊天习惯选择

  // 4) 运行时状态残留
  'activeBuffs',
  'buffInjection',
  'memoryPalaceInjection',
  'videoCallPerformancePersona',
  'videoCallPerformancePersonaGeneratedAt',
  'companionTouchSettings',
  'companionAvatar',
  'savedDateState',
  'savedRoomState',
  'lastRoomDate',
  'phoneState',
  'dreamLogs',
  'specialMomentRecords',
  'vrState',
  'chibiStudio',
  'home3D',
  'homeDefinition',
  'homeContextBridgeVersion',
] as const;

/**
 * 从一份角色卡数据里剔除所有敏感 / 私密 / 运行时字段，返回浅拷贝。
 * 导出（生成分享文件）和导入（落库前）都调用它，保证两个方向一致。
 */
export function stripSensitiveCardFields<T extends Record<string, any>>(data: T): T {
  const clone: Record<string, any> = { ...data };
  for (const key of CARD_STRIPPED_FIELDS) {
    delete clone[key];
  }
  return clone as T;
}

/** 供类型收窄用：CharacterProfile 上被剥离掉的键。 */
export type StrippedCardField = Extract<keyof CharacterProfile, typeof CARD_STRIPPED_FIELDS[number]>;
