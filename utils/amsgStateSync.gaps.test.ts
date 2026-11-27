// amsg2 打脏缺口补完后的接线守卫（通话 / 群聊 / 见面 / 日程 / 生活记录 / 听歌加歌单 /
// 改用户资料 / 世界书 / 情绪广播 / 角色自排任务 / 备份导入）。
//
// 和 amsgStateSync.wiring.test.ts 同一套路数：仓库的 vitest 是纯 Node 环境（没装 jsdom，
// vitest.config.ts 也只收 utils / worker / scripts 下的测试），React 组件渲染不起来，
// 只能做**源码级**断言。它验证不了运行时时序，只防「接线被误删」这一种回归。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n?/g, '\n');

/** 取 [start, end) 之间的源码片段；找不到锚点直接让断言失败。 */
const sliceBetween = (src: string, start: string, end: string): string => {
  const i = src.indexOf(start);
  expect(i, `找不到锚点: ${start}`).toBeGreaterThan(-1);
  const j = src.indexOf(end, i + start.length);
  expect(j, `找不到结束锚点: ${end}`).toBeGreaterThan(-1);
  return src.slice(i, j);
};

const OS_CONTEXT = '../context/OSContext.tsx';
const MUSIC_CONTEXT = '../context/MusicContext.tsx';

// ─── 跨模块事件名（改一个字两边就对不上，静默断供）───

describe('utils 层直写 DB 后的内存回灌（事件名契约）', () => {
  it('OSContext 对主动消息处理失败给出有冷却的可见提示', () => {
    const src = read(OS_CONTEXT);
    expect(src).toContain('const inboxFailHandler = (e: Event) =>');
    expect(src).toContain("window.addEventListener('active-msg-process-failed', inboxFailHandler)");
    expect(src).toContain("window.removeEventListener('active-msg-process-failed', inboxFailHandler)");
    expect(src).toContain('inboxFailToastAt[charId]');
  });

  it('OSContext 监听 amsg2-tasks-adopted：重读 DB → 只合并 activeMsg2Config → 打脏', () => {
    const src = read(OS_CONTEXT);
    // 事件名一字不差：派发方（activeMsgRuntime 采纳角色自排任务）按这个名字发。
    expect(src).toContain("window.addEventListener('amsg2-tasks-adopted'");
    expect(src).toContain("window.removeEventListener('amsg2-tasks-adopted'");

    const handler = sliceBetween(src, 'const tasksAdoptedHandler', 'const musicProfileSyncHandler');
    expect(handler).toContain('detail || {}).charId');
    // 顺序钉住：任务清单只落在 DB，必须重读 DB 再合并，不能拿内存里那份旧的。
    expect(handler).toMatch(/DB\.getCharacter\(charId\)[\s\S]*?activeMsg2Config: fresh\.activeMsg2Config/);
    // 只搬 activeMsg2Config 一个字段：整对象覆盖会把内存里更新的字段顶回去。
    expect(handler).not.toMatch(/setCharacters\([\s\S]*?\?\s*fresh\s*:/);
    // 合并进内存 + 打脏是一套动作，缺哪一半都算断供。
    expect(handler).toMatch(/setCharacters\([\s\S]*?markAmsgStateDirty\(/);
  });

  it('MusicContext 加歌落库后广播 char-music-profile-updated（带 charId + musicProfile）', () => {
    const src = read(MUSIC_CONTEXT);
    const fn = sliceBetween(src, 'addSongToCharPlaylist: async', '\n    };\n  }, [current');
    // 先落库再广播——反过来的话监听方拿到的 musicProfile 还没进 DB。
    expect(fn).toMatch(/DB\.saveCharacter\([\s\S]*?dispatchEvent\(new CustomEvent\('char-music-profile-updated'/);
    expect(fn).toContain('detail: { charId: cid, musicProfile: updatedProfile }');
  });

  it('OSContext 监听 char-music-profile-updated：同步进内存 characters + 打脏', () => {
    const src = read(OS_CONTEXT);
    expect(src).toContain("window.addEventListener('char-music-profile-updated'");
    expect(src).toContain("window.removeEventListener('char-music-profile-updated'");

    const handler = sliceBetween(src, 'const musicProfileSyncHandler', "window.addEventListener('amsg2-tasks-adopted'");
    // 内存不回灌的话，之后任一 updateCharacter 会拿旧内存把刚加的歌反向抹掉。
    expect(handler).toMatch(/setCharacters\([\s\S]*?musicProfile[\s\S]*?markAmsgStateDirty\(/);
  });
});

// ─── 备份导入后的云端对账 ───

describe('备份导入后跟 amsg2 云端对账', () => {
  const importTail = () =>
    sliceBetween(read(OS_CONTEXT), '// ─── 主动消息 2.0：导入后跟云端对一次账', 'setSysOperation({ status: \'idle\', message: \'\', progress: 100 })');

  it('没配 worker 一个请求都不发', () => {
    const tail = importTail();
    expect(tail).toContain('ActiveMsgStore.getGlobalConfig()');
    expect(tail).toMatch(/workerUrl\?\.trim\(\)[\s\S]*?if \(amsgWorkerUrl\)/);
  });

  it('无主任务（角色已不在新档里）逐个 cancel', () => {
    const tail = importTail();
    expect(tail).toContain('ActiveMsgClient.listAllTasks()');
    expect(tail).toContain('knownCharIds.has(owner)');
    expect(tail).toContain('ActiveMsgClient.cancelTask(');
  });

  it('任务没投影出主人时也当无主任务取消，不额外设门跳过', () => {
    const tail = importTail();
    expect(tail).not.toContain('hasCharIdProjection');
    // 只有「主人还在新档里」才放过，其余（含没主人的）一律取消
    expect(tail).toMatch(/if \(owner && knownCharIds\.has\(owner\)\) continue;[\s\S]*?cancelTask\(/);
  });

  it('导入进来的角色刷云端快照 + 凭据走同一个入口上传', () => {
    const tail = importTail();
    expect(tail).toContain('syncAmsgToolConfigAndPrompts(');
    expect(tail).toContain('characters: importedChars');
  });

  it('整段 best-effort：云端够不着不让导入失败', () => {
    const tail = importTail();
    expect(tail).toMatch(/try \{[\s\S]*?\} catch \(e\) \{[\s\S]*?console\.warn/);
    expect(tail).not.toContain('throw');
  });
});

// ─── 其余打脏入口（补一行就够的那些，只钉「有没有接上」）───

describe('其余打脏入口接线', () => {
  it('OSContext：改用户资料 / 世界书增删 / 群增删改 / 情绪广播都打脏', () => {
    const src = read(OS_CONTEXT);
    for (const [start, end] of [
      // 用户资料是全角色共享素材（名字烤在模板里），走 ForAll
      ['const updateUserProfile', 'const addCustomTheme'],
      // 世界书同步角色缓存那两处绕开了 updateCharacter 的汇聚点
      ['const mutateWorldbooks', 'const updateWorldbooks'],
      // 情绪 buff 广播：一个点堵住 emotionApply / memoryDive 等几个上游
      ['const buffSyncHandler', '// 本地 fetch 聊天回复的全局回落'],
    ] as const) {
      expect(sliceBetween(src, start, end), `${start} 里少了打脏调用`).toMatch(/markAmsgStateDirty(ForAll)?\(/);
    }
    expect(src).toContain('=> mutateWorldbooks(ids, updates)');
    expect(src).toContain('=> mutateWorldbooks(ids, null)');
    expect(src).toContain('=> updateWorldbooks([id], updates)');
    expect(src).toContain('await deleteWorldbooks([id])');

    // 群名 / 成员变了，成员的 fire_pack 里那份群信息要跟着刷（走 markGroupMembersDirty）
    expect(sliceBetween(src, 'const markGroupMembersDirty', 'const createGroup'))
      .toContain('markAmsgStateDirty(');
    for (const [start, end] of [
      ['const createGroup', 'const updateGroup'],
      ['const updateGroup', 'const deleteGroup'],
      ['const deleteGroup', '// Worldbook Methods'],
    ] as const) {
      expect(sliceBetween(src, start, end), `${start} 里少了对成员打脏`).toContain('markGroupMembersDirty(');
    }
  });

  it('CallApp：用户发言 / 角色回复 / 挂断落库后都打脏', () => {
    const src = read('../apps/CallApp.tsx');
    expect(src).toContain("import { markAmsgStateDirty } from '../utils/amsgStateSync'");
    // 通话三个落库点各跟一次（同一个事件循环里的会在微任务内合并成一次上传）。
    // 接通后不再自动生成开场白，必须等用户明确发送。
    expect(src.match(/markCallTurnDirty\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    const finishCall = sliceBetween(src, 'const finishCall = async', 'const handleHangup');
    expect(finishCall, '挂断这一下最要紧（用户接着就关 App）').toContain('markCallTurnDirty()');
  });

  it('GroupChat：群消息 / 一轮收尾 / 话题盒归档都对成员打脏', () => {
    const src = read('../apps/GroupChat.tsx');
    expect(src).toContain('markAmsgStateDirty(');
    for (const [start, end] of [
      ['const handleSendMessage = async', 'const handleImageFile'],
      ['const createNextGroupTopicBox', 'const runGroupTopicArchive'],
      ['const triggerDirector = async', '// 轮询模式'],
      ['const triggerRoundRobin = async', '// 触发入口'],
    ] as const) {
      expect(sliceBetween(src, start, end), `${start} 里少了对成员打脏`).toContain('markGroupMembersDirty(');
    }
  });

  it('DateApp：轮次落库与删改处理器都打脏（对齐 Chat.tsx）', () => {
    const src = read('../apps/DateApp.tsx');
    for (const [start, end] of [
      ['const handleSendMessage = async', 'const handleReroll'],
      ['const handleReroll = async', '// --- Editing & Deletion ---'],
      ['const handleDeleteMessage = async', 'const handleDeleteMessages'],
      ['const handleDeleteMessages = async', 'const confirmEditMessage'],
      ['const confirmEditMessage = async', '// --- History Long Press ---'],
      ['const handleHistoryDelete = async', 'const handleHistoryEditOpen'],
      ['const handleHistoryEditConfirm = async', 'const onExitSession'],
    ] as const) {
      expect(sliceBetween(src, start, end), `${start} 里少了打脏调用`).toContain('markDateTurnDirty(');
    }
  });

  it('Chat：日程编辑 / 删除 / 跨天重新生成 + 生活记录否决都打脏', () => {
    const src = read('../apps/Chat.tsx');
    for (const [start, end, expected] of [
      ['const handleScheduleEdit', 'const handleScheduleDelete', 'markAmsgStateDirty('],
      ['const handleScheduleDelete', 'const handleScheduleCoverChange', 'markAmsgStateDirty('],
      ['const generateDailySchedule', 'const handleScheduleStyleChange', 'markAmsgStateDirty('],
      // 生活记录注入所有开了开关的角色 → ForAll
      ['const handleResolveLifeRecord', 'const handleManualTrigger', 'markAmsgStateDirtyForAll('],
    ] as const) {
      expect(sliceBetween(src, start, end), `${start} 里少了打脏调用`).toContain(expected);
    }
    // 封面图不进包、小剧场缓存不进 scene —— 这两处不该顺手加
    expect(sliceBetween(src, 'const handleScheduleCoverChange', 'const runTheater'))
      .not.toContain('markAmsgStateDirty');
  });

  it('LifeRecordPanel：写库后打脏，首次进面板（只读）不打', () => {
    const src = read('../components/lifeRecord/LifeRecordPanel.tsx');
    const reload = sliceBetween(src, 'const reload = async', 'useEffect(() => { reload(');
    expect(reload).toContain('if (mutated) markAmsgStateDirtyForAll(');
    expect(src, '首次加载只是读库，不该把所有角色的快照都推一遍').toContain('useEffect(() => { reload(false); }, []);');
  });

  it('ValentineEvent：节日事件消息落库后打脏', () => {
    const src = read('../components/ValentineEvent.tsx');
    const fn = sliceBetween(src, 'const generateValentineMessage = async', '/** 点击屏幕推进对话 */');
    expect(fn).toMatch(/DB\.saveMessage\([\s\S]*?markAmsgStateDirty\(/);
  });
});
