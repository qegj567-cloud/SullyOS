import type { useOS } from '../context/OSContext';
import type { CharacterProfile } from '../types';
import { getThinkingChainSettings } from './thinkingChainPrompt';
import { loadChatInputPreferences } from './chatInputPreferences';
import { clampManualContextLimit, resolveContextRangeMode } from './chatContextRange';
import { dialogueMaxTokens, resolveDialogueApi } from './characterApi';
import { llmApiType } from './llmEndpoint';
import { resolveMemoryPalaceWaterline } from './memoryPalace/waterline';
import { ActiveMsgStore } from './activeMsgStore';
import { isAmsg2GloballyEnabled } from './amsgGlobalGate';
import { domesticMiniMaxVideoKey, isCompanionArkPlan, resolveCompanionVideoApi, selectedCompanionVideoConfig } from './companion/videoProviders';

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
    const videoApi = resolveCompanionVideoApi(apiConfig.companionVideoApi, domesticMiniMaxVideoKey(apiConfig)) ?? selectedCompanionVideoConfig(apiConfig.companionVideoApi);
    const thinking = char && getThinkingChainSettings(char, os.userProfile);
    const mode = char && resolveContextRangeMode(char);
    let translated: boolean | null = null;
    if (char) {
        try { translated = JSON.parse(localStorage.getItem('chat_translate_enabled_' + char.id) ?? 'false') === true; }
        catch { /* 不可读时保持未知 */ }
    }
    return {
        主对话: { ...endpointFields(apiConfig), 接口: llmApiType(apiConfig), 流式: !!apiConfig.stream, 输出上限: dialogueMaxTokens(apiConfig) },
        同行: {
            短接话: apiConfig.companionQuickReply === true,
            语音识别: apiConfig.companionStt?.provider === 'doubao' ? '豆包' : '浏览器',
            语音密钥已填: !!apiConfig.companionStt?.apiKey?.trim(),
            视频配置: videoApi ? endpointFields(videoApi) : '未配置',
            视频计费入口: isCompanionArkPlan(videoApi?.baseUrl || '') ? '已购 Agent Plan' : '普通或自定义 API',
        },
        私聊与群聊输入: { 自动回复: input.autoReply, 发送键代替生成: input.sendButtonGenerates, 回车发送: input.enterToSend, 表情联想: input.emojiSuggestions },
        共用心象提示词模式: os.userProfile?.thinkingChainPrompt?.mode === 'replace' ? '替换默认提示词' : '追加',
        全局记忆服务: {
            副API: endpointFields(memoryPalaceConfig.lightLLM), Embedding: endpointFields(memoryPalaceConfig.embedding),
            重排开关: !!memoryPalaceConfig.rerank?.enabled,
            重排额外名额: memoryPalaceConfig.rerank?.enabled ? Math.max(1, Math.min(20, memoryPalaceConfig.rerank.topN ?? 5)) : undefined,
            远程向量: os.remoteVectorConfig?.enabled ? (os.remoteVectorConfig.initialized ? '已配置' : '待验证') : '关闭',
            手动分步维护: memoryPalaceConfig.manualMaintenance === true,
        },
        实时感知: { 天气开关: !!realtimeConfig.weatherEnabled, 热点开关: !!realtimeConfig.newsEnabled },
        外观: { 深色模式: !!os.theme.darkMode },
        主动消息全局: globalPush ? { 总开关: isAmsg2GloballyEnabled(globalPush), Worker地址已填: !!globalPush.workerUrl?.trim() } : '未能读取',
        指定角色设置: char ? {
            对话来源: char.dialogueApi ? '角色独立 API' : '跟随全局',
            对话配置: { ...endpointFields(chatApi), 接口: llmApiType(chatApi), 流式: !!chatApi.stream, 输出上限: dialogueMaxTokens(chatApi) },
            记忆宫殿: !!char.memoryPalaceEnabled, 全自动记忆开关: !!char.autoArchiveEnabled,
            原文范围: mode === 'adaptive' ? '自适应' : '手动', 手动条数: mode === 'manual' ? clampManualContextLimit(char.contextLimit) : undefined,
            整理节奏: resolveMemoryPalaceWaterline(char.memoryPalaceWaterline), 小眼睛开启月份数: char.activeMemoryMonths?.length ?? 0,
            允许按月查阅: char.monthlyRecallEnabled !== false, 挂载世界书数: char.mountedWorldbooks?.length ?? 0,
            私聊表情看图: !!char.stickerVision, 心象显示: !!char.showThinkingChain, 双语: translated ?? '未能读取', HTML卡片: !!char.htmlModeEnabled,
            心象提示词范围: thinking?.scope === 'character' ? '仅当前角色' : '所有角色（共用）',
            心象提示词模式: thinking?.mode === 'replace' ? '替换默认提示词' : '追加',
            时间感知: char.timeAwarenessEnabled !== false, 主动消息角色开关: char.activeMsg2Config?.enabled === true,
        } : '本轮只提供所有角色共用的设置。需要查看某个角色的设置时，点「询问配置」里的「指定角色」，再选择角色。',
    };
}

export type HelpDeskSettings = Awaited<ReturnType<typeof readHelpDeskSettings>>;
