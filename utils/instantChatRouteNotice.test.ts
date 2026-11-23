// 输入框上方「这一轮在本地生成」提示条的名单守卫：名单外的原因码一律不出声，
// 所以该报的档漏登记，用户就看不到这一轮为什么没上云。
import { describe, expect, it } from 'vitest';
import { NOTICES } from '../components/chat/InstantChatRouteNotice';

describe('本地生成提示条的名单', () => {
  it('MCP / 小红书服务器云端连不到这两档会弹提示条，且不说「会自动恢复」', () => {
    for (const reason of ['mcp-worker-unreachable', 'xhs-worker-unreachable']) {
      const notice = NOTICES[reason];
      expect(notice?.title).toBe('这一轮在本地生成');
      expect(notice?.hint).not.toMatch(/自动恢复/);
    }
    expect(NOTICES['mcp-worker-unreachable'].hint).toContain('MCP');
    expect(NOTICES['xhs-worker-unreachable'].hint).toContain('小红书');
  });

  it('用户自己关掉的、点单流程这类本该留在本地的不出声', () => {
    for (const reason of ['disabled', 'char-disabled', 'luckin-chat', 'mcd', 'luckin']) {
      expect(NOTICES[reason]).toBeUndefined();
    }
  });
});
