import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('静态陪伴与视频快照 Umami 埋点', () => {
  const appearance = readFileSync(path.resolve(__dirname, '../apps/Appearance.tsx'), 'utf8');
  const companion = readFileSync(path.resolve(__dirname, '../components/os/CompanionHome.tsx'), 'utf8');
  const importer = readFileSync(path.resolve(__dirname, '../components/call/useCallAvatarSetup.tsx'), 'utf8');
  const call = readFileSync(path.resolve(__dirname, '../apps/CallApp.tsx'), 'utf8');

  it('覆盖静态形象和桌面触碰功能', () => {
    for (const eventName of [
      '切换桌面陪伴形象来源',
      '导入桌面静态形象',
      '切换桌面见面立绘衣服',
      '移除桌面静态形象',
    ]) {
      expect(appearance).toContain(`trackEvent('${eventName}'`);
    }
    expect(companion).toContain("trackEvent('生成桌面触碰反馈'");
    expect(companion).toContain("trackEvent('切换桌面见面立绘衣服'");
  });

  it('覆盖快照选择、留存和通话结束', () => {
    for (const eventName of [
      '选择用户摄像头模式',
      '保存视频通话单帧快照',
      '淘汰旧视频通话快照',
      '结束一通通话',
    ]) {
      expect(call).toContain(`trackEvent('${eventName}'`);
    }
  });

  it('导入形象的每条岔路都记，包括被体积和格式挡回去的', () => {
    // 导入是个漏斗，只记成功的话「有多少人卡在这一步」永远看不见——
    // 那几道体积上限和格式检查是直接 return 的，不在这里记就一点痕迹都不留。
    //
    // 逐条钉「来源 + 结果」的配对，不是只钉「这一档存在过」：后者太松，
    // 三处体积上限里删掉任意一处都还能过。
    for (const payload of [
      // 文件选择器：ZIP 与 VRM 共用，来源按扩展名当场定死
      "{ 来源: source, 结果: '成功' }",
      "{ 来源: source, 结果: '失败' }",
      "{ 来源: source, 结果: '体积超限' }",
      "{ 来源: source, 结果: '格式不支持' }",
      "{ 来源: source, 结果: '要先导出VRM' }",
      // VRM 真正落库在确认 beta 提示之后，成败在那一步才有结论
      "{ 来源: 'VRM', 结果: '成功' }",
      "{ 来源: 'VRM', 结果: '失败' }",
      // 文件夹是另一个入口
      "{ 来源: 'Live2D 文件夹', 结果: '成功' }",
      "{ 来源: 'Live2D 文件夹', 结果: '失败' }",
      "{ 来源: 'Live2D 文件夹', 结果: '体积超限' }",
    ]) {
      expect(importer, `导入通话形象少了这一处：${payload}`).toContain(payload);
    }
    // 三道体积上限（ZIP 200MB / VRM 80MB / 文件夹 250MB）各挡各的。
    // 前两道的 payload 文本一模一样，只能靠数个数把它们分开。
    expect(importer.split("结果: '体积超限'").length - 1, '三道体积上限有一处没记').toBe(3);
    // 来源判定没了的话，ZIP 和 VRM 的失败会混成一格，分不出是哪条路劝退的
    expect(importer, 'ZIP 与 VRM 的来源判定没了').toContain("? 'Live2D ZIP' : 'VRM'");
  });

  it('埋点参数不包含文本、角色名、文件名或 Blob 引用', () => {
    const analyticsLines = [appearance, companion, call, importer]
      .flatMap(source => source.split('\n'))
      .filter(line => line.includes('trackEvent(') || line.includes('来源:') || line.includes('形象:') || line.includes('模式:'));
    const payload = analyticsLines.join('\n');
    expect(payload).not.toMatch(/character\.name|selectedChar\.name|file\.name|imageRef|snapshot\.ref|\binput\b|assistantText/);
  });
});
