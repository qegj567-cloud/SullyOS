// 角色级开关「面板显示的」和「实际生效的」必须是同一个答案的接线守卫。
//
// 仓库的 vitest 是纯 Node 环境（没装 jsdom），设置面板是 React 组件跑不起来测行为，
// 所以沿用 amsg2ChatLoop.wiring.test.ts 的做法做**源码级**断言。它验证不了运行时时序，
// 只防「两处各写各的三元」这一种回归。
//
// 为什么值得钉：这两处一旦分家，症状是纯界面的、不报错也不崩——面板显示「关」、
// 任务列表和新建表单整块藏起来，角色却在聊天里照样拿得到 schedule_active_message
// 并真的排出任务来。用户看到的是「我没开过它怎么给我发消息」，翻代码前根本对不上。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const modal = read('../components/chat/ActiveMsg2SettingsModal.tsx');
const chatAI = read('../hooks/useChatAI.ts');
const tasks = read('./amsg2Tasks.ts');

describe('角色级开关只有一处判定', () => {
  it('判定本身是「面板里开过才算开」', () => {
    // 默认值的方向写在这里：config 缺失 = 用户没表过态 = 关。
    expect(tasks).toMatch(/isAmsg2EnabledForChar[\s\S]{0,120}activeMsg2Config\?\.enabled === true/);
  });

  it('面板的开关初值走这个判定', () => {
    expect(modal).toMatch(/useState\(\(\) => isAmsg2EnabledForChar\(char\)\)/);
  });

  it('面板打开时的表单重置也走这个判定，不自己写三元', () => {
    // 这一条是真出过问题的那处：useState 的初值是对的，重置 effect 却用
    // `config?.enabled ?? false` 把它盖掉，于是初值永远活不过一帧。
    expect(modal).toMatch(/setEnabled\(isAmsg2EnabledForChar\(char\)\)/);
    expect(modal).not.toMatch(/setEnabled\((?!isAmsg2EnabledForChar|!enabled)/);
  });

  it('面板里没有绕开判定的裸比较', () => {
    expect(modal).not.toMatch(/enabled\s*(!==|===)\s*false/);
    expect(modal).not.toMatch(/enabled\s*\?\?\s*(true|false)/);
  });

  it('工具注入门走同一个判定', () => {
    expect(chatAI).toMatch(/amsg2ScheduleEnabled = isAmsg2EnabledForChar\(char\)/);
  });
});
