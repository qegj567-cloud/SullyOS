/**
 * 人格模拟的代跑落地。
 *
 * 校验与本机直连共用 validatePersonaScriptResponse：截断、被安全策略拦下、解析不了、结尾不是 end
 * 都按失败收尾，报的错与本机一字不差。通过的照本机的样子归档进 phoneState.simLogs。
 *
 * 落地常在 React 之外（重开页面后补收）。直接写 DB 会被 OSContext 内存里那份整角色下次写回时盖掉，
 * 所以写完库再发 PERSONA_SIM_LOG_LANDED，由 OSContext 只把这条 simLog 并回内存。
 */

import { DB } from '../../db';
import {
    createPersonaSimLog,
    mergePersonaSimLogs,
    PERSONA_SIM_CLOUD_FAILED,
    PERSONA_SIM_LOG_LANDED,
    validatePersonaScriptResponse,
    type PersonaSimLogLandedDetail,
} from '../../personaSimLog';
import { personaSimStore } from '../../personaSimStore';
import { dismissCloudGenJob, updateCloudGenJob } from '../registry';
import type { CloudGenLander } from '../types';

/** 入口交任务时存进登记表的上下文；logId 在落地后补上，重开页面时指示条靠它显示「就绪」。 */
export interface PersonaSimCloudContext {
    mode: 'daily' | 'event';
    theme: string;
    logId?: string;
}

export const lander: CloudGenLander = {
    async land(response, record) {
        if (!record) return 'discarded';
        const ctx = (record.context || {}) as Partial<PersonaSimCloudContext>;
        const mode = ctx.mode === 'event' ? 'event' : 'daily';
        const theme = typeof ctx.theme === 'string' ? ctx.theme : '';

        let script;
        try {
            script = validatePersonaScriptResponse(response);
        } catch (error) {
            // 内容本身不合格，重来多少次都一样：按失败收尾（results.ts 标失败并调 onFailed 走失败提示）。
            return { failed: { code: 'invalid-output', message: error instanceof Error ? error.message : '演出生成失败' } };
        }

        const char = await DB.getCharacter(record.charId);
        if (!char) return 'discarded';
        // id 跟着 job 走：落地中途断掉、结果再来一次也只留一条。
        const log = { ...createPersonaSimLog(script, mode, theme), id: `sim-${record.jobId}` };
        await DB.saveCharacter({ ...char, phoneState: mergePersonaSimLogs(char.phoneState, [log]) });
        personaSimStore.rememberCloudScript(record.jobId, script);
        updateCloudGenJob(record.jobId, { context: { mode, theme, logId: log.id } satisfies PersonaSimCloudContext });
        window.dispatchEvent(new CustomEvent<PersonaSimLogLandedDetail>(PERSONA_SIM_LOG_LANDED, { detail: { charId: record.charId, log } }));
        return 'landed';
    },

    async onFailed(record) {
        // 失败提示走全局指示条（与本机失败同一句），这条记录留着没用，收走让小条消失。
        dismissCloudGenJob(record.jobId);
        window.dispatchEvent(new CustomEvent(PERSONA_SIM_CLOUD_FAILED, { detail: { charId: record.charId } }));
    },

    open(record) {
        personaSimStore.requestOpen(record.charId);
    },
};
