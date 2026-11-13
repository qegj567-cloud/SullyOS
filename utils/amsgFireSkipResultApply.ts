/**
 * 消化一条 `fire-skipped` 结果（定时主动消息到点没发）。
 *
 * 结果的形状与来由见 utils/amsgFireSkipResult.ts。这份文件只管落地：给角色记一条回执，
 * 下一轮聊天时排程现状块（amsg2TaskContext）会把它告诉角色。
 *
 * 单独一份文件是为了让 amsgResults 的分发表能动态 import 它——这条路要碰 IndexedDB。
 */

import { ActiveMsgStore } from './activeMsgStore';
import { recordCompletedCloudApiCall } from './apiCallLog';
import { resolveDialogueApi } from './characterApi';
import { DB } from './db';
import { parseFireSkipResult, shouldReportFireSkip, type AmsgProactiveKind } from './amsgFireSkipResult';
import type { AmsgResultContext } from './amsgResults';
import type { Amsg2ExpiredNoticeRecord, APIConfig, CharacterProfile } from '../types';

const HEADER = '[amsg2:fire-skipped]';

const loadApiConfigSnapshot = (): APIConfig => {
  try {
    const raw = localStorage.getItem('os_api_config');
    if (raw) {
      const parsed = JSON.parse(raw);
      return { baseUrl: parsed.baseUrl || '', apiKey: parsed.apiKey || '', model: parsed.model || '', ...parsed };
    }
  } catch { /* ignore */ }
  return { baseUrl: '', apiKey: '', model: '' };
};

const skippedProactivePurpose = (kind?: AmsgProactiveKind): string => {
  if (kind === 'away') return '离开后消息（未发送）';
  if (kind === 'dateLeave') return '见面离开提醒（未发送）';
  if (kind === 'self') return '角色自排提醒（未发送）';
  return '主动消息（未发送）';
};

export const applyFireSkipResult = async (
  payload: unknown,
  _context?: AmsgResultContext,
): Promise<boolean> => {
  const result = parseFireSkipResult(payload);
  if (!result) {
    console.warn(`${HEADER} 结果形状认不出来，丢弃`, payload);
    return true;
  }

  let char: CharacterProfile | undefined;
  if (result.usage || !result.task) {
    char = (await DB.getAllCharacters()).find((c) => c.id === result.charId);
  }

  // 若本次跳过发生在云端调完模型之后（如角色决定不说、或生成期间用户开口避让），
  // 这一轮实打实消耗了对话模型的 token，照实记进「API 调用记录」（即使该 reason 不留角色回执也照记）。
  if (result.usage) {
    const apiCfg = loadApiConfigSnapshot();
    const effectiveApi = char ? resolveDialogueApi(apiCfg, char) : apiCfg;
    recordCompletedCloudApiCall({
      id: `cloud-proactive-skip-${result.taskUuid}:${result.occurrenceMs}`,
      route: 'cloud-proactive',
      baseUrl: effectiveApi.baseUrl,
      model: effectiveApi.model,
      ok: true,
      timestamp: Math.min(Date.now(), result.occurrenceMs),
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      tokensPartial: result.usage.tokensPartial,
      meta: {
        appId: 'chat',
        appName: '消息',
        charId: result.charId,
        charName: char?.name,
        purpose: skippedProactivePurpose(result.proactiveKind),
      },
    });
  }

  if (!shouldReportFireSkip(result.reason)) return true;

  // 云端带了任务概要就用它；没带（过期跳过那条路拿不到）就查本地清单。
  let task = result.task;
  if (!task) {
    if (!char) {
      // 角色已经被删了：这条永远没有落点，留着只会每次上线重放一遍。
      console.warn(`${HEADER} 找不到角色 ${result.charId}（已删除？），销账丢弃`);
      return true;
    }
    const local = char.activeMsg2Config?.tasks?.find((t) => t.taskUuid === result.taskUuid);
    if (!local) {
      // 本地清单里已经没有这条了（被清理 / 被取消）：角色没法对着一条说不出内容的任务做决定。
      console.warn(`${HEADER} 本地清单里没有这条任务，销账丢弃`, result.taskUuid);
      return true;
    }
    task = { mode: local.mode, promptHint: local.promptHint, recurrenceType: local.recurrenceType };
  }

  const record: Amsg2ExpiredNoticeRecord = {
    // 循环任务每次触发各记各的；一次性任务只有这一次。
    id: task.recurrenceType === 'none' ? result.taskUuid : `${result.taskUuid}:${result.occurrenceMs}`,
    charId: result.charId,
    occurrenceMs: result.occurrenceMs,
    mode: task.mode,
    ...(task.promptHint ? { promptHint: task.promptHint } : {}),
    recurrenceType: task.recurrenceType,
    kind: 'expired',
    reason: result.reason,
    createdAt: Date.now(),
  };
  // 台账按 id 去重：同一条结果推送直达和上线补收各来一次，也只记一条。
  await ActiveMsgStore.upsertExpiredNotices(result.charId, [record]);
  return true;
};
