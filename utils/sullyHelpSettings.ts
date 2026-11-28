import { resolveTimeContractTheme } from './timeContract';
import type { useOS } from '../context/OSContext';
import type { CharacterProfile } from '../types';
import { getThinkingChainSettings } from './thinkingChainPrompt';
import { loadChatInputPreferences } from './chatInputPreferences';
import { clampManualContextLimit, resolveContextRangeMode } from './chatContextRange';
import { dialogueMaxTokens, resolveDialogueApi } from './characterApi';
import { isBlankApiSlot, readStoredPresets, inspectSlotPresetBinding, resolveAuxiliaryApi, resolveGlobalMainApi } from './apiSlots';
import { llmApiType } from './llmEndpoint';
import { resolveMemoryPalaceWaterline } from './memoryPalace/waterline';
import { ActiveMsgStore, isInstantChatSwitchedOn } from './activeMsgStore';
import { isAmsg2GloballyEnabled } from './amsgGlobalGate';
import { resolveCloudGenFeatureSwitches } from './cloudGen/settings';
import { CLOUD_GEN_PURPOSES, CLOUD_GEN_PURPOSE_META } from './cloudGen/types';
import { isCloudGenHintOff } from './cloudGen/hint';
import { reducedBlurSetting } from './blurPolicy';
import { resolveDateLeaveDelayMinutes } from './dateLeaveReminder';

const dateOption = (value: string | undefined, allowed: readonly string[], fallback: string) =>
    value ? (allowed.includes(value) ? value : '未识别，按默认处理') : fallback;

type SettingsSource = Pick<ReturnType<typeof useOS>, 'apiConfig' | 'memoryPalaceConfig' | 'realtimeConfig' | 'theme' | 'isDataLoaded'> & Partial<Pick<ReturnType<typeof useOS>, 'remoteVectorConfig' | 'userProfile'>>;
type Endpoint = { baseUrl: string; apiKey: string; model: string };
function endpointFields(config: Endpoint) {
    const name = config.model?.trim() || '';
    // 模型下拉框也允许手填；误粘的 URL、Key 或多行备注不当成模型名称外发。
    const showName = /^[\p{L}\p{N}][\p{L}\p{N}._:/+-]{0,99}$/u.test(name)
        && !name.includes('://') && !/^(?:sk-|AIza|eyJ|ghp_|Bearer)/i.test(name)
        && !(config.apiKey && name.includes(config.apiKey.trim()));
    return { 地址已填: !!config.baseUrl?.trim(), 密钥已填: !!config.apiKey?.trim(), 模型: showName ? name : name ? '已填写' : '未选择' };
}

/** 每次发送时从当前空间投影答疑字段。配置原件、用户档案和凭据不进入答疑正文。 */
export async function readHelpDeskSettings(os: SettingsSource, char?: CharacterProfile) {
    if (!os.isDataLoaded) return { 状态: '本机设置还在载入，本轮不可判断' };
    const { apiConfig, memoryPalaceConfig, realtimeConfig } = os;
    const input = loadChatInputPreferences();
    const globalPush = await ActiveMsgStore.getGlobalConfig().catch(() => null);
    const chatApi = resolveDialogueApi(apiConfig, char);
    const thinking = char && getThinkingChainSettings(char, os.userProfile);
    const mode = char && resolveContextRangeMode(char);
    let translated: boolean | null = null;
    if (char) {
        try { translated = JSON.parse(localStorage.getItem('chat_translate_enabled_' + char.id) ?? 'false') === true; }
        catch { /* 不可读时保持未知 */ }
    }
    const effectiveMain = resolveGlobalMainApi(apiConfig);
    const effectiveMemoryLight = resolveAuxiliaryApi(memoryPalaceConfig.lightLLM, effectiveMain);
    return {
        API预设: { 数量: readStoredPresets().length, 主对话使用预设: inspectSlotPresetBinding(apiConfig).status === 'bound', 首次配置入口: '设置 → API → 新建预设 → 创建并选用' },
        主对话: { ...endpointFields(effectiveMain), 接口: llmApiType(effectiveMain), 流式: !!effectiveMain.stream, 输出上限: dialogueMaxTokens(effectiveMain) },
        私聊与群聊输入: { 自动回复: input.autoReply, 发送键代替生成: input.sendButtonGenerates, 回车发送: input.enterToSend, 表情联想: input.emojiSuggestions },
        共用心象提示词模式: os.userProfile?.thinkingChainPrompt?.mode === 'replace' ? '替换默认提示词' : '追加',
        全局记忆服务: {
            副API: { ...endpointFields(effectiveMemoryLight), 来源: isBlankApiSlot(memoryPalaceConfig.lightLLM) ? '回退主对话' : '独立配置' }, Embedding: endpointFields(memoryPalaceConfig.embedding),
            重排开关: !!memoryPalaceConfig.rerank?.enabled,
            重排额外名额: memoryPalaceConfig.rerank?.enabled ? Math.max(1, Math.min(20, memoryPalaceConfig.rerank.topN ?? 5)) : undefined,
            远程向量: os.remoteVectorConfig?.enabled ? (os.remoteVectorConfig.initialized ? '已配置' : '待验证') : '关闭',
            手动分步维护: memoryPalaceConfig.manualMaintenance === true,
        },
        实时感知: { 天气开关: !!realtimeConfig.weatherEnabled, 热点开关: !!realtimeConfig.newsEnabled },
        // 减弱模糊：「自动」= 开关没开，但浏览器（Firefox）或系统「减弱透明度」已经关掉了毛玻璃。
        外观: { 深色模式: !!os.theme.darkMode, 减弱模糊: reducedBlurSetting(), 时光契约与桌面日历: resolveTimeContractTheme(os.theme.scheduleAppTheme) },
        主动消息全局: globalPush ? {
            总开关: isAmsg2GloballyEnabled(globalPush), Worker地址已填: !!globalPush.workerUrl?.trim(),
            // 「功能总览 → 云端生成」里的开关；私聊那一行就是全局即时对话开关。
            云端生成: {
                私聊: isInstantChatSwitchedOn(globalPush),
                ...Object.fromEntries(CLOUD_GEN_PURPOSES.map((purpose) => {
                    const switches = resolveCloudGenFeatureSwitches(globalPush, purpose);
                    return [CLOUD_GEN_PURPOSE_META[purpose].label, { 云端生成: switches.enabled, 完成时通知: switches.notify, 不再提醒: isCloudGenHintOff(purpose) }];
                })),
            },
        } : '未能读取',
        指定角色设置: char ? {
            对话来源: char.dialogueApi ? '角色独立 API' : '跟随全局',
            对话配置: { ...endpointFields(chatApi), 接口: llmApiType(chatApi), 流式: !!chatApi.stream, 输出上限: dialogueMaxTokens(chatApi) },
            记忆宫殿: !!char.memoryPalaceEnabled, 全自动记忆开关: !!char.autoArchiveEnabled,
            原文范围: mode === 'adaptive' ? '自适应' : '手动', 手动条数: mode === 'manual' ? clampManualContextLimit(char.contextLimit) : undefined,
            整理节奏: resolveMemoryPalaceWaterline(char.memoryPalaceWaterline), 小眼睛开启月份数: char.activeMemoryMonths?.length ?? 0,
            允许按月查阅: char.monthlyRecallEnabled !== false, 挂载世界书数: char.mountedWorldbooks?.length ?? 0,
            停用的挂载世界书数: char.mountedWorldbooks?.filter(book => book.disable || book.bookDisabled).length ?? 0,
            // 条目只在设定的场景里生效；「某个 App 里世界书没起作用」先看这里。
            限定了启用场景的世界书数: char.mountedWorldbooks?.filter(book => book.scenes != null).length ?? 0,
            私聊表情看图: !!char.stickerVision, 心象显示: !!char.showThinkingChain, 双语: translated ?? '未能读取', HTML卡片: !!char.htmlModeEnabled,
            心象提示词范围: thinking?.scope === 'character' ? '仅当前角色' : '所有角色（共用）',
            心象提示词模式: thinking?.mode === 'replace' ? '替换默认提示词' : '追加',
            时间感知: char.timeAwarenessEnabled !== false, 主动消息角色开关: char.activeMsg2Config?.enabled === true,
            陪伴默认体验: {
                行动选择: char.dateActionChoicesEnabled === true,
                文风: dateOption(char.dateStyleConfig?.style, ['cinematic', 'plain', 'lyrical', 'playful', 'intense', 'syrup', 'dark_comedy', 'suspense', 'drama', 'slice_of_life'], 'cinematic'),
                基调: dateOption(char.dateStyleConfig?.tone, ['character', 'daily_warm', 'push_pull', 'direct_affection'], 'character'),
                人称: dateOption(char.dateStyleConfig?.pov, ['third-name', 'third-you', 'first-you'], '随角色'), 深挖: char.dateStyleConfig?.digDeeper !== false,
                场景已设: !!char.dateStyleConfig?.sceneSeed?.trim(), 补充已设: !!char.dateStyleConfig?.extra?.trim(),
                完整体验预设数: char.dateExtraPresets?.filter(p => p.experience).length || 0,
                旧补充预设数: char.dateExtraPresets?.filter(p => !p.experience).length || 0,
                作用范围: '角色默认；入口可为本场临时覆盖，不包含本场临时内容',
            },
            见面设置: {
                观测协议: {
                    开启: char.dateObserve?.enabled === true,
                    样式: dateOption(char.dateObserve?.style, ['hologram', 'ink', 'neon', 'crystal', 'terminal'], 'hologram'),
                    启用的基础维度数: (['time', 'place', 'state', 'detail'] as const).filter(key => char.dateObserve?.fields?.[key]?.enabled !== false).length,
                    启用的自定义维度数: char.dateObserve?.custom?.filter(field => field.enabled !== false && field.label?.trim()).length || 0,
                },
                离开提醒: { 开启: char.dateLeaveReminder?.enabled === true, 等待分钟: resolveDateLeaveDelayMinutes(char) },
                背景已设: !!char.dateBackground,
                套装数: (char.dateSkinSets?.length || 0) + 1,
                当前套装: char.dateSkinSets?.some(skin => skin.id === char.activeSkinSetId) ? '自定义套装' : '默认立绘',
                自定义情绪数: char.customDateSprites?.length || 0,
                阅读样式: dateOption(char.dateAppearance?.preset, ['none', 'novel', 'paper', 'night'], 'none'),
                浅色阅读: char.dateLightReading === true, 阅读头像: char.dateReadingShowAvatars === true,
                语音播放: char.dateVoiceEnabled === true, 见面时间感知: char.dateTimeAwarenessEnabled !== false,
            },
        } : '本轮只提供所有角色共用的设置。需要查看某个角色的设置时，点「询问配置」里的「指定角色」，再选择角色。',
    };
}

export type HelpDeskSettings = Awaited<ReturnType<typeof readHelpDeskSettings>>;
