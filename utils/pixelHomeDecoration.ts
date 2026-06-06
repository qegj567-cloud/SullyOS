/**
 * Pixel Home — LLM 装修逻辑
 *
 * 消化后触发，角色基于消化结果决定是否调整房间。
 * 输出 JSON diff，不删除用户放的家具。
 */

import type { DecorationDiff, DecorationAction, PixelRoomLayout } from '../apps/pixelHome/types';
import type { MemoryRoom } from './memoryPalace/types';
import type { DigestResult } from './memoryPalace/digestion';
import { PixelLayoutDB } from '../apps/pixelHome/pixelHomeDb';
import { ROOM_META, ALL_ROOMS } from '../apps/pixelHome/roomTemplates';
import { safeFetchJson } from './safeApi';

interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * 角色自主装修：基于消化结果生成装修 diff 并应用。
 */
export async function generateDecoration(
  charId: string,
  charName: string,
  persona: string,
  llmConfig: LLMConfig,
  digestResult?: DigestResult | null,
  userName?: string,
): Promise<DecorationDiff | null> {
  try {
    // 获取当前所有房间布局
    const layouts = await PixelLayoutDB.getAllForChar(charId);
    if (layouts.length === 0) return null;

    const layoutSummary = layouts.map(l => ({
      room: l.roomId,
      name: ROOM_META[l.roomId].name,
      wall: l.wallColor,
      floor: l.floorColor,
      furniture: l.furniture.map(f => ({
        slot: f.slotId,
        x: Math.round(f.x),
        y: Math.round(f.y),
        hasCustomAsset: !!f.assetId,
        placedBy: f.placedBy,
      })),
    }));

    // 消化摘要
    let digestSummary = '';
    if (digestResult) {
      const parts: string[] = [];
      if (digestResult.resolved.length > 0) parts.push(`化解了${digestResult.resolved.length}个困惑`);
      if (digestResult.deepened.length > 0) parts.push(`${digestResult.deepened.length}个创伤加深了`);
      if (digestResult.fulfilled.length > 0) parts.push(`${digestResult.fulfilled.length}个期盼实现了`);
      if (digestResult.disappointed.length > 0) parts.push(`${digestResult.disappointed.length}个期盼落空了`);
      if (digestResult.selfInsights.length > 0) parts.push(`产生了${digestResult.selfInsights.length}个自我领悟`);
      digestSummary = parts.length > 0 ? `最近的心理变化：${parts.join('，')}。` : '';
    }

    const systemPrompt = `你是${charName}，正在整理自己的像素小屋。
${persona ? `你的人设：${persona.slice(0, 500)}` : ''}

你有7个房间，每个房间有5个固定家具槽位。你可以：
1. 移动家具位置 (move)：调整 x,y 坐标（0-100 的百分比）
2. 换色 (recolor)：给家具换个颜色覆盖
3. 调大小 (rescale)：调整家具的缩放比例（0.3-3.0）
4. 换墙色 (set_wall)：换房间墙壁颜色
5. 换地板色 (set_floor)：换房间地板颜色
6. 设氛围 (set_ambiance)：给房间写一句氛围描述

规则：
- 你不能删除${userName || '用户'}放的家具（placedBy: "user"），但可以微调位置
- 不要大幅改动，只做1-5个小变化
- 变化要反映你当前的心境
- 如果没什么变化的心境，返回空数组

${digestSummary}

当前房间布局：
${JSON.stringify(layoutSummary, null, 2)}

请返回JSON格式（仅返回JSON，不要其他文字）：
{
  "actions": [
    { "type": "move", "roomId": "bedroom", "slotId": "lamp", "x": 80, "y": 40 },
    { "type": "set_wall", "roomId": "bedroom", "color": "#ede9fe" },
    { "type": "set_ambiance", "roomId": "bedroom", "ambiance": "今晚的月光特别温柔" }
  ],
  "summary": "你的一句装修感言"
}`;

    const data = await safeFetchJson(
      `${llmConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${llmConfig.apiKey}`,
        },
        body: JSON.stringify({
          model: llmConfig.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: '请根据你现在的心境，决定要不要整理一下房间。' },
          ],
          temperature: 0.7,
          max_tokens: 800,
        }),
      },
      2, 0, { appName: '小小窝', purpose: '房间布置' },
    );

    const reply = data.choices?.[0]?.message?.content || '';
    const jsonMatch = reply.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log('🏠 [HomeDecoration] 角色决定不装修');
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const actions: DecorationAction[] = (parsed.actions || []).filter((a: any) =>
      a.type && a.roomId && ALL_ROOMS.includes(a.roomId)
    );

    if (actions.length === 0) {
      console.log('🏠 [HomeDecoration] 无装修动作');
      return null;
    }

    const diff: DecorationDiff = {
      charId,
      actions,
      summary: parsed.summary || '',
      timestamp: Date.now(),
    };

    // 应用装修
    await applyDecoration(charId, diff, layouts);

    console.log(`🏠 [HomeDecoration] ${charName}整理了房间：${diff.summary}（${actions.length}个变化）`);
    return diff;
  } catch (err: any) {
    console.warn(`🏠 [HomeDecoration] 装修失败: ${err.message}`);
    return null;
  }
}

/** 将装修 diff 应用到 DB */
async function applyDecoration(
  charId: string,
  diff: DecorationDiff,
  layouts: PixelRoomLayout[],
): Promise<void> {
  const layoutMap = new Map(layouts.map(l => [l.roomId, { ...l }]));

  for (const action of diff.actions) {
    const layout = layoutMap.get(action.roomId);
    if (!layout) continue;

    switch (action.type) {
      case 'move': {
        if (!action.slotId) break;
        const f = layout.furniture.find(f => f.slotId === action.slotId);
        if (f && f.placedBy !== 'user') {
          if (action.x != null) f.x = Math.max(5, Math.min(95, action.x));
          if (action.y != null) f.y = Math.max(10, Math.min(90, action.y));
        }
        // 用户放的家具只做微调（±5）
        if (f && f.placedBy === 'user') {
          if (action.x != null) f.x = Math.max(5, Math.min(95, f.x + Math.max(-5, Math.min(5, action.x - f.x))));
          if (action.y != null) f.y = Math.max(10, Math.min(90, f.y + Math.max(-5, Math.min(5, action.y - f.y))));
        }
        break;
      }
      case 'recolor': {
        if (!action.slotId || !action.color) break;
        const f = layout.furniture.find(f => f.slotId === action.slotId);
        if (f) f.colorOverride = action.color;
        break;
      }
      case 'rescale': {
        if (!action.slotId || action.scale == null) break;
        const f = layout.furniture.find(f => f.slotId === action.slotId);
        if (f && f.placedBy !== 'user') {
          f.scale = Math.max(0.3, Math.min(3, action.scale));
        }
        break;
      }
      case 'set_wall':
        if (action.color) layout.wallColor = action.color;
        break;
      case 'set_floor':
        if (action.color) layout.floorColor = action.color;
        break;
      case 'set_ambiance':
        if (action.ambiance) layout.ambiance = action.ambiance;
        break;
    }

    layout.lastUpdatedAt = Date.now();
    layout.lastDecoratedBy = 'character';
  }

  // 保存修改的房间
  const modifiedRooms = diff.actions
    .map(a => a.roomId)
    .filter((v, i, arr) => arr.indexOf(v) === i);

  for (const roomId of modifiedRooms) {
    const layout = layoutMap.get(roomId);
    if (layout) await PixelLayoutDB.save(layout);
  }
}
