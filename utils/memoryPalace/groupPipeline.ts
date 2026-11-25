/**
 * Group Memory Palace — 群聊后台总结管线
 *
 * 与私聊管线（pipeline.ts/processNewMessages）的关系：**完全平行、互不调用**。
 * 所有共享的只是底层 IndexedDB 表（memory_nodes / memory_vectors 等通用 CRUD）和
 * embedding/向量存储工具。私聊代码一行不动。
 *
 * 核心数据流：
 * 1. 群聊导演响应后，GroupChat fire-and-forget 调用 processGroupNewMessages
 * 2. 检查群聊高水位线（per-groupId localStorage key），缓冲区超 BUFFER_THRESHOLD_GROUP 才触发
 * 3. LLM 用第三人称提取群记忆草稿（groupExtraction.extractGroupMemoriesFromBuffer）
 * 4. 每个成员各持久化一份（同样的草稿，charId=member.id，附 groupId/groupName 字段）
 *    → 私聊里 retrieveMemories(member.id) 自然能召回这条群记忆，**无需额外注入路径**
 * 5. 更新群聊高水位线
 *
 * 删除群时，调用 deleteGroupMemoriesByGroupId 清理所有相关记忆。
 */
import type { Message, CharacterProfile, GroupProfile } from '../../types';
import type { EmbeddingConfig, MemoryNode, RemoteVectorConfig, MemoryVector } from './types';
import type { LightLLMConfig } from './pipeline';
import { readStoredMainApi, resolveAuxiliaryApi } from '../apiSlots';
import { DB } from '../db';
import { MemoryNodeDB, MemoryVectorDB, ensureFloat32 } from './db';
import { getEmbeddings, cosineSimilarity } from './embedding';
import { extractGroupMemoriesFromBuffer } from './groupExtraction';
import { isMessageSemanticallyRelevant } from '../messageFormat';

// ─── 群聊水位线：私聊用 200/100，群聊更宽松 300/200 ─────────────────
const HOT_ZONE_SIZE_GROUP = 300;
// export：群设置的成员记忆状态面板文案里引用「满 N 条自动触发」，不硬编码
export const BUFFER_THRESHOLD_GROUP = 200;
const PROCESS_RATIO = 0.85;
const DEDUP_THRESHOLD = 0.9;

const LAST_MSG_KEY_GROUP = (groupId: string) => `mp_lastMsgId_group_${groupId}`;

function getLastProcessedGroupId(groupId: string): number {
    try {
        const val = parseInt(localStorage.getItem(LAST_MSG_KEY_GROUP(groupId)) || '0', 10);
        return isNaN(val) || val < 0 ? 0 : val;
    } catch { return 0; }
}

function setLastProcessedGroupId(groupId: string, msgId: number): void {
    try { localStorage.setItem(LAST_MSG_KEY_GROUP(groupId), String(msgId)); } catch {}
}

/** 对外只读包装：群记忆宫殿处理到的最后一条消息 id（成员记忆状态面板展示进度用） */
export function getGroupMemoryPalaceHighWaterMark(groupId: string): number {
    return getLastProcessedGroupId(groupId);
}

/** 全局记忆宫殿配置：lightLLM 为空时自动回退到全局主对话 API（含预设引用实时解析） */
function readGlobalMemoryPalaceConfig(): {
    embedding?: EmbeddingConfig;
    lightLLM?: LightLLMConfig;
} {
    let cfg: any = null;
    try {
        const raw = localStorage.getItem('os_memory_palace_config');
        if (raw) cfg = JSON.parse(raw);
    } catch {
        cfg = null;
    }
    const mainApi = readStoredMainApi() ?? { baseUrl: '', apiKey: '', model: '' };
    const resolvedLlm = resolveAuxiliaryApi(cfg?.lightLLM, mainApi);
    return {
        embedding: cfg?.embedding?.baseUrl && cfg?.embedding?.apiKey ? cfg.embedding as EmbeddingConfig : undefined,
        lightLLM: resolvedLlm.baseUrl?.trim() && resolvedLlm.model?.trim() ? resolvedLlm as LightLLMConfig : undefined,
    };
}

function readRemoteVectorConfig(): RemoteVectorConfig | undefined {
    try {
        const raw = localStorage.getItem('os_remote_vector_config');
        if (!raw) return undefined;
        const config = JSON.parse(raw) as RemoteVectorConfig;
        return (config.enabled && config.initialized) ? config : undefined;
    } catch { return undefined; }
}

/**
 * 优先使用全局记忆宫殿 embedding 配置；仅当全局未配置时才兜底读旧版角色级别配置（与私聊 pipeline.ts 一致）。
 * 任何 member 没配 → 返回 null，调用方跳过该成员。
 */
function getEmbeddingConfigForMember(member: CharacterProfile, globalEmb?: EmbeddingConfig): EmbeddingConfig | null {
    if (globalEmb?.baseUrl && globalEmb?.apiKey) {
        return globalEmb;
    }
    const charEmb = (member as any).embeddingConfig;
    if (charEmb?.baseUrl && charEmb?.apiKey) {
        return charEmb as EmbeddingConfig;
    }
    return null;
}

function generateGroupMemoryId(): string {
    return `mng_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 把消息按 charId 映射成显示名（用户消息 → userName，角色消息 → 角色名） */
function makeSpeakerNameOf(members: CharacterProfile[], userName: string) {
    const charIdToName = new Map<string, string>();
    for (const m of members) charIdToName.set(m.id, m.name);
    return (msg: Message): string => {
        if (msg.role === 'user') return userName || '用户';
        if (msg.charId) return charIdToName.get(msg.charId) || '群友';
        return '群友';
    };
}

// ─── 并发锁：每个群同时只跑一个处理任务 ─────────────────
const processingLocks = new Set<string>();

/**
 * 删除某个群的所有群记忆（成员各自存的副本一并清掉）
 *
 * 群被删除时调用：扫描全表，删除 groupId 匹配的 MemoryNode + 对应 MemoryVector。
 * 全表扫不快但删群是低频操作，可接受。
 */
export async function deleteGroupMemoriesByGroupId(groupId: string): Promise<{ deleted: number }> {
    if (!groupId) return { deleted: 0 };
    try {
        const all = await (async () => {
            // MemoryNodeDB 没有 getAll；走通用 db 表名直查
            const db = await (await import('../db')).openDB();
            return new Promise<MemoryNode[]>((resolve, reject) => {
                const tx = db.transaction('memory_nodes', 'readonly');
                const req = tx.objectStore('memory_nodes').getAll();
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => reject(req.error);
            });
        })();
        const targets = all.filter(n => n.groupId === groupId);
        if (targets.length === 0) return { deleted: 0 };
        for (const node of targets) {
            try {
                await MemoryNodeDB.delete(node.id);
                // 对应向量也删掉
                await MemoryVectorDB.delete(node.id);
            } catch (e: any) {
                console.warn(`🗑️ [GroupPalace] 删除节点 ${node.id} 失败: ${e.message}`);
            }
        }
        console.log(`🗑️ [GroupPalace] 删除群 ${groupId} 的群记忆 ${targets.length} 条`);
        return { deleted: targets.length };
    } catch (e: any) {
        console.warn(`🗑️ [GroupPalace] 清理群记忆失败: ${e.message}`);
        return { deleted: 0 };
    }
}

/**
 * 群聊后台缓冲区处理。
 *
 * - 至少需要 1 个成员开启了记忆宫殿才跑（否则直接 return null）
 * - 全程异常吞掉，console.warn 后返回 null，绝不影响 GroupChat 主流程
 * - 写出来的 MemoryNode 自带 groupId/groupName，私聊代码读到这俩字段不感知（无副作用）
 * - onProgress 回调：每进入一个关键阶段触发一次（"扫描缓冲区" / "LLM 提取中" / "向量化第 X 个成员"），
 *   caller 用它做 toast/状态条等用户可见提示。skip 路径（hot_zone/threshold）**不触发** onProgress，
 *   避免水位线没到时也弹"在整理"造成误导。
 */
export async function processGroupNewMessages(
    group: GroupProfile,
    members: CharacterProfile[],
    userName: string,
    onProgress?: (stage: string) => void,
): Promise<{
    stored: number;
    perMemberStored: Record<string, number>;
    /** drafts 数量（即从 LLM 提取出的群记忆条数；可能 ≥ stored，因为 dedup 会扣掉一些） */
    extracted?: number;
    /** 本轮处理的群消息条数（用于 result toast 显示信息量） */
    processedMessageCount?: number;
    reason?: 'lock' | 'hot_zone' | 'threshold' | 'no_config' | 'no_enabled_member';
} | null> {
    if (!group?.id) return null;
    const lockKey = group.id;
    if (processingLocks.has(lockKey)) {
        return { stored: 0, perMemberStored: {}, reason: 'lock' };
    }
    processingLocks.add(lockKey);

    try {
        // 1. 至少要有一个成员开启了记忆宫殿
        const enabledMembers = members.filter(m => (m as any).memoryPalaceEnabled);
        if (enabledMembers.length === 0) {
            return { stored: 0, perMemberStored: {}, reason: 'no_enabled_member' };
        }

        // 2. 解析全局 LLM/embedding 配置（每个成员可能各自覆盖 embedding）
        const globalCfg = readGlobalMemoryPalaceConfig();
        const lightLLM = globalCfg.lightLLM;
        const globalEmb = globalCfg.embedding;
        if (!lightLLM) {
            console.warn(`🏰 [GroupPalace] 群 ${group.name} 没有可用的 lightLLM 配置，跳过`);
            return { stored: 0, perMemberStored: {}, reason: 'no_config' };
        }

        // 3. 加载群消息 → 计算热区 / 缓冲区
        const allMsgs = await DB.getGroupMessages(group.id);
        const textMsgs = allMsgs
            .filter(isMessageSemanticallyRelevant)
            .sort((a, b) => a.id - b.id);

        const totalCount = textMsgs.length;
        if (totalCount <= HOT_ZONE_SIZE_GROUP) {
            console.log(`🏰 [GroupPalace] 群 ${group.name}：消息总数 ${totalCount} <= 热区 ${HOT_ZONE_SIZE_GROUP}，无需处理`);
            return { stored: 0, perMemberStored: {}, reason: 'hot_zone' };
        }

        const hotZoneStartIdx = totalCount - HOT_ZONE_SIZE_GROUP;
        const hotZoneStartId = textMsgs[hotZoneStartIdx].id;

        const lastProcessedId = getLastProcessedGroupId(group.id);
        const buffer = textMsgs.filter(m => m.id > lastProcessedId && m.id < hotZoneStartId);

        if (buffer.length < BUFFER_THRESHOLD_GROUP) {
            console.log(`🏰 [GroupPalace] 群 ${group.name}：缓冲区 ${buffer.length} < ${BUFFER_THRESHOLD_GROUP}，跳过（hwm=${lastProcessedId}, 热区起点 id=${hotZoneStartId}）`);
            return { stored: 0, perMemberStored: {}, reason: 'threshold' };
        }

        // 4. 取前 85%
        const processCount = Math.ceil(buffer.length * PROCESS_RATIO);
        const toProcess = buffer.slice(0, processCount);
        const keptTail = buffer.length - processCount;
        if (toProcess.length === 0) return { stored: 0, perMemberStored: {}, reason: 'threshold' };

        console.log(`🏰 [GroupPalace] 群 ${group.name}：开始处理 ${toProcess.length} 条群消息（保留尾部 ${keptTail} 条）`);
        onProgress?.(`正在整理 ${toProcess.length} 条群消息...`);

        // 5. LLM 提取（第三人称草稿）
        const memberNames = members.map(m => m.name);
        const speakerNameOf = makeSpeakerNameOf(members, userName);
        onProgress?.(`正在提取【${group.name}】群记忆...`);
        const { drafts } = await extractGroupMemoriesFromBuffer(
            toProcess,
            group.name,
            memberNames,
            userName || '用户',
            speakerNameOf,
            lightLLM,
        );

        if (drafts.length === 0) {
            console.warn(`🏰 [GroupPalace] 群 ${group.name}：提取 0 条群记忆，不更新水位线，下次重试`);
            return { stored: 0, perMemberStored: {}, extracted: 0, processedMessageCount: toProcess.length };
        }

        console.log(`🏰 [GroupPalace] 群 ${group.name}：提取 ${drafts.length} 条群记忆，开始为 ${enabledMembers.length} 个成员各持久化一份`);
        onProgress?.(`提取到 ${drafts.length} 条群记忆，正在向量化并存入 ${enabledMembers.length} 个成员的记忆宫殿...`);

        // 6. 为每个开启记忆宫殿的成员各存一份
        //    每个成员用 ta 自己的 embedding 配置——这样 retrieve 时向量空间一致
        const perMemberStored: Record<string, number> = {};
        const remoteVectorCfg = readRemoteVectorConfig();
        let totalStored = 0;

        for (const member of enabledMembers) {
            const memberEmb = getEmbeddingConfigForMember(member, globalEmb);
            if (!memberEmb) {
                console.warn(`🏰 [GroupPalace] 成员 ${member.name} 没有 embedding 配置，跳过 ta 这一份`);
                perMemberStored[member.id] = 0;
                continue;
            }

            try {
                // 6a. 这个成员现有向量（用于本批去重）
                const existingVectors = await MemoryVectorDB.getAllByCharId(member.id);

                // 6b. 嵌入这个成员的所有 drafts
                const texts = drafts.map(d => d.content);
                const vectors = await getEmbeddings(texts, memberEmb);

                let storedForMember = 0;
                for (let i = 0; i < drafts.length; i++) {
                    const draft = drafts[i];
                    const vector = vectors[i];

                    // 与该成员已有记忆去重（同样的群记忆草稿可能跟以前的群记忆撞）
                    // ev.vector 声明上有 number[] / Float32Array / Uint8Array 三态，
                    // ensureFloat32 统一（DB 层已经转好，这里是恒等返回），别让
                    // cosineSimilarity 把 Uint8Array 的原始字节当成分量读。
                    const isDup = existingVectors.some(ev => cosineSimilarity(vector, ensureFloat32(ev.vector)) > DEDUP_THRESHOLD);
                    if (isDup) {
                        console.log(`♻️ [GroupPalace] ${member.name}：重复群记忆跳过 "${draft.content.slice(0, 30)}..."`);
                        continue;
                    }

                    const node: MemoryNode = {
                        id: generateGroupMemoryId(),
                        charId: member.id,
                        content: draft.content,
                        room: draft.room,
                        tags: draft.tags,
                        importance: draft.importance,
                        mood: draft.mood,
                        valence: draft.valence,
                        arousal: draft.arousal,
                        embedded: true,
                        createdAt: draft.createdAt,
                        lastAccessedAt: draft.createdAt,
                        accessCount: 0,
                        eventBoxId: null,
                        origin: 'extraction',
                        groupId: group.id,
                        groupName: group.name,
                    };
                    await MemoryNodeDB.save(node);

                    const memVec: MemoryVector = {
                        memoryId: node.id,
                        charId: member.id,
                        vector,
                        dimensions: memberEmb.dimensions,
                        model: memberEmb.model,
                    };
                    await MemoryVectorDB.save(memVec);

                    // 远程向量异步同步（fire-and-forget）
                    if (remoteVectorCfg?.enabled && remoteVectorCfg.initialized) {
                        try {
                            const { upsertVector } = await import('./supabaseVector');
                            upsertVector(remoteVectorCfg, node.id, member.id, vector, node, memberEmb.dimensions, memberEmb.model).catch(() => {});
                        } catch { /* 忽略动态导入失败 */ }
                    }

                    existingVectors.push(memVec);
                    storedForMember++;
                }

                perMemberStored[member.id] = storedForMember;
                totalStored += storedForMember;
                console.log(`🏰 [GroupPalace] ${member.name}：存入 ${storedForMember} 条群记忆`);
            } catch (e: any) {
                console.warn(`🏰 [GroupPalace] ${member.name} 持久化群记忆失败: ${e.message}（其他成员继续）`);
                perMemberStored[member.id] = 0;
            }
        }

        // 7. 更新群聊水位线（即使部分成员失败也推进——避免重复提取）
        if (totalStored > 0) {
            const newHighWaterMark = toProcess[toProcess.length - 1].id;
            setLastProcessedGroupId(group.id, newHighWaterMark);
            console.log(`✅ [GroupPalace] 群 ${group.name}：处理完成 ${totalStored} 条总入库, hwm ${lastProcessedId} → ${newHighWaterMark}`);
        } else {
            console.warn(`🏰 [GroupPalace] 群 ${group.name}：所有成员都没存进 0 条，不更新水位线`);
        }

        return {
            stored: totalStored,
            perMemberStored,
            extracted: drafts.length,
            processedMessageCount: toProcess.length,
        };
    } catch (e: any) {
        console.warn(`❌ [GroupPalace] 群 ${group.name} 处理失败: ${e.message}`);
        return null;
    } finally {
        processingLocks.delete(lockKey);
    }
}
