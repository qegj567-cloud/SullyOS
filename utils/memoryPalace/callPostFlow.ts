/**
 * 通话（CallApp）的记忆宫殿后置流程。
 *
 * 聊天（useChatAI）与见面（DateApp.runMemoryPalacePostHook）在每轮回复后都会
 * 触发缓冲区处理——通话消息与它们同存一条消息流、同受一条水位线统计，却一直
 * 没有自己的触发器：长通话攒下的缓冲区只能等用户下次去别的 App 才被整理。
 * 这里把 DateApp 的钩子提炼成可注入依赖的独立函数，行为保持一致：
 *   缓冲区处理（水位线推进）→ 自动归档合并 + hide 追平 → 50 轮认知消化。
 *
 * 全局「xx正在整理记忆」提示不在这里做——pipeline 真正开始处理时会广播
 * `memory-palace-processing` 事件，由 OSContext 统一弹 toast（三个入口共享）。
 */
import type { CharacterProfile } from '../../types';
import { DB } from '../db';
import {
    getMemoryPalaceHighWaterMark,
    hasRunnableMemoryPalaceLlm,
    mergePalaceFragmentsIntoMemories,
    processNewMessages,
    resolveMemoryPalaceLlm,
} from './pipeline';
import { incrementDigestRound, runCognitiveDigestion } from './digestion';

export interface CallPalacePostFlowInput {
    char: CharacterProfile;
    /** 读取角色的最新状态（流程是异步的，用户中途可能关掉宫殿/改设置）。 */
    getLiveChar: () => CharacterProfile | null | undefined;
    memoryPalaceConfig?: { embedding?: any; lightLLM?: any } | null;
    apiConfig: { baseUrl?: string; apiKey?: string; model?: string };
    userName?: string;
    updateCharacter: (id: string, patch: Partial<CharacterProfile>) => void;
    onStatus?: (text: string) => void;
}

export async function runCallMemoryPalacePostFlow(input: CallPalacePostFlowInput): Promise<void> {
    const liveBefore = input.getLiveChar();
    if (!liveBefore?.memoryPalaceEnabled) return;

    const mpEmb = input.memoryPalaceConfig?.embedding;
    const mpLLM = resolveMemoryPalaceLlm(input.memoryPalaceConfig?.lightLLM, input.apiConfig);
    if (!mpEmb?.baseUrl || !mpEmb?.apiKey || !hasRunnableMemoryPalaceLlm(mpLLM)) return;

    const recentMsgs = await DB.getRecentMessagesByCharId(input.char.id, 50);
    const pipelineResult = await processNewMessages(
        recentMsgs,
        input.char.id,
        input.char.name,
        mpEmb,
        mpLLM,
        input.userName || '',
        false,
        stage => input.onStatus?.(stage),
    );

    // pipeline 跑的过程中用户可能关掉了宫殿，后续动作前都要再核对一次。
    const liveAfter = input.getLiveChar();
    if (!liveAfter?.memoryPalaceEnabled) return;

    if ((liveAfter as any).autoArchiveEnabled) {
        try {
            const patch: Partial<CharacterProfile> = {};
            if (pipelineResult?.autoArchive) {
                patch.memories = mergePalaceFragmentsIntoMemories(
                    liveAfter.memories || [],
                    pipelineResult.autoArchive.fragments,
                );
            }
            // 隐藏线追平到向量高水位，与聊天/见面侧同一逻辑。
            const hwm = getMemoryPalaceHighWaterMark(input.char.id);
            const curHide = ((liveAfter as any).hideBeforeMessageId as number) || 0;
            if (hwm > curHide) (patch as any).hideBeforeMessageId = hwm;
            if (Object.keys(patch).length > 0) input.updateCharacter(input.char.id, patch);
        } catch (e: any) {
            console.warn(`📚 [CallApp AutoArchive] 失败（不影响 palace）: ${e?.message || e}`);
        }
    }

    // 50 轮自动认知消化（与聊天/见面共享同一个按 charId 持久化的计数器）
    const shouldAutoDigest = incrementDigestRound(input.char.id);
    if (shouldAutoDigest) {
        input.onStatus?.(`${input.char.name}闭上眼睛，开始整理内心…`);
        const persona = [liveAfter.systemPrompt || '', liveAfter.worldview || ''].filter(Boolean).join('\n');
        await runCognitiveDigestion(input.char.id, input.char.name, persona, mpLLM, false, input.userName, mpEmb);
    }
}
