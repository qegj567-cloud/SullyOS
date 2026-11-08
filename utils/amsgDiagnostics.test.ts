// utils/amsgDiagnostics.test.ts
// 回归守卫：
//   1. fetch 失败不能再把 "Failed to fetch" 原样丢给用户——必须说出连的是哪个域名、
//      可能的三个原因，以及「到点推送不走这条路」。社区里排查这一句花掉过好几天。
//   2. 各家浏览器报「连不上」的说法不一样（Chrome 的 Failed to fetch、Safari 的
//      Load failed、旧 Firefox 的 NetworkError），漏认一种就有一批人只剩英文原文。
//   3. 体检面板的红绿判定：缺 D1 绑定、表结构是旧的、VAPID 没配、云端没登记收件设备，
//      这四种都是「界面上一切正常、就是一条都不发」，必须各自单独报出来。
//   4. 连不上 / 回执形状不对时，其余各项一律 unknown，不许假装绿——那比不体检更糟，
//      用户会照着绿灯去别处瞎找。
//   5. 「定时任务」那一行按实际情况说话：在失败重试、被掐掉、用户自己暂停了、每分钟
//      那一跳在报错，各有各的说法，报错原文要能看到。
import { describe, it, expect } from 'vitest';
import {
  AmsgDebugReport,
  AmsgDiagnosticsInput,
  buildAmsgDiagnosticRows,
  describeAmsgFetchFailure,
  INSTANT_CHAT_BLOCKER_HINTS,
  InstantChatBlocker,
  InstantChatGateInput,
  parseAmsgDebugReport,
  readWorkerHost,
  resolveInstantChatBlocker,
  summarizeAmsgDiagnostics,
} from './amsgDiagnostics';
import { AmsgTickReport, AmsgTickReportTask, parseAmsgTickReport } from './amsgTickReport';

const WORKER_URL = 'https://amsg.example.workers.dev';

const rowOf = (rows: ReturnType<typeof buildAmsgDiagnosticRows>, key: string) => {
  const row = rows.find((item) => item.key === key);
  if (!row) throw new Error(`体检结果里没有 ${key} 这一行`);
  return row;
};

/** 一份全绿的回执，各用例只改自己要考的那一处。 */
const healthyReport = (patch: Partial<AmsgDebugReport> = {}): AmsgDebugReport => ({
  config: { ok: true, missing: [], message: 'Worker 配置齐全。', warnings: [] },
  storage: {
    reachable: true,
    schemaReady: true,
    missingTables: [],
    missingColumns: [],
    pushSubscriptionRegistered: true,
    pushDelivery: { probed: true, gone: null, registeredAtMs: Date.parse('2026-08-10T04:00:00.000Z') },
    pendingTasks: 2,
    overdueTasks: 0,
    oldestOverdueMinutes: null,
  },
  tick: 'healthy',
  server: { version: '2.6.0-next.15', featureCount: 27 },
  vapidPublicKey: 'BNPtv_1egsDlvOIk',
  ...patch,
});

describe('describeAmsgFetchFailure — 把 fetch 异常翻成人话', () => {
  it('连不上时说清域名、三个可能原因，以及推送不受影响', () => {
    const { message, kind } = describeAmsgFetchFailure(
      Object.assign(new TypeError('Failed to fetch'), { name: 'TypeError' }),
      '初始化数据库',
      WORKER_URL,
    );

    expect(kind).toBe('网络失败');
    // 域名：不说打的是哪儿，用户没法判断是自己网络的问题还是地址填错了。
    expect(message).toContain('amsg.example.workers.dev');
    expect(message).toContain('连不上');
    // 三条自查线索都要在，缺一条就会有人往错的方向翻。
    expect(message).toContain('直连教程');
    expect(message).toContain('地址填错');
    // 最要紧的一句：别让用户以为主动消息整个废了。
    expect(message).toContain('推送');
    expect(message).toMatch(/不走这条路|不受影响/);
    // 光秃秃的英文原文不该是用户看到的全部。
    expect(message).not.toBe('Failed to fetch');
  });

  it('Safari 的 Load failed 和旧 Firefox 的 NetworkError 同样认得出来', () => {
    const safari = describeAmsgFetchFailure(new TypeError('Load failed'), '读取任务列表', WORKER_URL);
    const firefox = describeAmsgFetchFailure(
      Object.assign(new Error('NetworkError when attempting to fetch resource.'), { name: 'NetworkError' }),
      '读取任务列表',
      WORKER_URL,
    );

    for (const result of [safari, firefox]) {
      expect(result.kind).toBe('网络失败');
      expect(result.message).toContain('连不上');
    }
  });

  it('超时单独成一句：这是「慢」不是「不通」，处理办法不一样', () => {
    const { message, kind } = describeAmsgFetchFailure(
      Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }),
      '即时对话',
      WORKER_URL,
    );

    expect(kind).toBe('网络失败');
    expect(message).toContain('超时');
    expect(message).toContain('amsg.example.workers.dev');
  });

  it('打到网页上（拿回 HTML）仍然单独归类，指去检查地址', () => {
    const { message, kind } = describeAmsgFetchFailure(
      new Error(`Unexpected token '<', "<!doctype ..." is not valid JSON`),
      '配置自检',
      WORKER_URL,
    );

    expect(kind).toBe('打到网页了');
    expect(message).toContain('网页');
  });

  it('没填地址时不硬凑域名，也不把 undefined 印出来', () => {
    const { message } = describeAmsgFetchFailure(new TypeError('Failed to fetch'), '初始化数据库', '');
    expect(message).not.toContain('undefined');
    expect(message).not.toContain('（）');
  });

  it('认不出来的异常保留原文，不吞成一句「网络错误」', () => {
    const { message, kind } = describeAmsgFetchFailure(new Error('AES-GCM decrypt failed'), '读取云端状态', WORKER_URL);
    expect(kind).toBe('其他');
    expect(message).toContain('AES-GCM decrypt failed');
  });
});

describe('readWorkerHost', () => {
  it('取域名，取不到就返回空串', () => {
    expect(readWorkerHost('https://amsg.example.workers.dev/')).toBe('amsg.example.workers.dev');
    expect(readWorkerHost('  ')).toBe('');
    expect(readWorkerHost('不是个地址')).toBe('');
    expect(readWorkerHost(undefined)).toBe('');
  });
});

describe('parseAmsgDebugReport — 只认形状对得上的回执', () => {
  it('认得出正常回执', () => {
    const parsed = parseAmsgDebugReport({ success: true, data: healthyReport() });
    expect(parsed?.config.ok).toBe(true);
    expect(parsed?.tick).toBe('healthy');
    expect(parsed?.server?.version).toBe('2.6.0-next.15');
  });

  it('旧 worker 回的 404 / 代理塞回来的 HTML 一律判成「没有这个端点」，不当成体检结果', () => {
    expect(parseAmsgDebugReport({ success: false, error: { code: 'NOT_FOUND' } })).toBeNull();
    expect(parseAmsgDebugReport('<!doctype html><html></html>')).toBeNull();
    expect(parseAmsgDebugReport(null)).toBeNull();
    // 有 data 但缺关键字段的，同样不采信。
    expect(parseAmsgDebugReport({ success: true, data: { config: {} } })).toBeNull();
  });

  // 老 bundle 的回执里压根没有 pushDelivery 这一段。收敛成显式的「没查」而不是让
  // undefined 一路漏到界面上——判定那侧只要漏写一个 ?. 就又是一个假绿灯。
  it('缺 pushDelivery 段（老 Worker）收敛成 probed:false / unsupported', () => {
    const { pushDelivery: _drop, ...storage } = healthyReport().storage;
    const parsed = parseAmsgDebugReport({ success: true, data: { ...healthyReport(), storage } });
    expect(parsed?.storage.pushDelivery).toEqual({ probed: false, reason: 'unsupported' });
  });

  it('worker 显式回 null（自己查不成）收敛成 probed:false / failed', () => {
    const parsed = parseAmsgDebugReport({
      success: true,
      data: healthyReport({ storage: { ...healthyReport().storage, pushDelivery: null as any } }),
    });
    expect(parsed?.storage.pushDelivery).toEqual({ probed: false, reason: 'failed' });
  });

  it('形状不全的 gone（缺状态码或时刻）当没查到，不硬凑成一次失败', () => {
    const parsed = parseAmsgDebugReport({
      success: true,
      data: healthyReport({
        storage: {
          ...healthyReport().storage,
          pushDelivery: { gone: { status: 410 }, registeredAtMs: 1700 } as any,
        },
      }),
    });
    expect(parsed?.storage.pushDelivery).toEqual({ probed: true, gone: null, registeredAtMs: 1700 });
  });

  it('tick 是没见过的值时退回 unknown，不原样透出去', () => {
    const parsed = parseAmsgDebugReport({ success: true, data: healthyReport({ tick: 'wat' as any }) });
    expect(parsed?.tick).toBe('unknown');
  });

  // 回归守卫：failing（在失败重试，但没卡住）是后加的一档。认不出来就被压成 unknown，
  // 那一行会变成「暂时看不出定时器在不在跑」，正在重试的任务就这么从体检里消失了。
  it('认得 failing 这一档，不压成 unknown', () => {
    const parsed = parseAmsgDebugReport({ success: true, data: healthyReport({ tick: 'failing' }) });
    expect(parsed?.tick).toBe('failing');
  });
});

describe('buildAmsgDiagnosticRows — 红绿判定', () => {
  it('全绿时每一行都是 ok', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: { reachable: true, report: healthyReport() },
      localPushSubscribed: true,
    });
    expect(rows.every((row) => row.level === 'ok')).toBe(true);
    expect(summarizeAmsgDiagnostics(rows)).toBe('ok');
  });

  it('连不上时其余各项是 unknown，不假装绿', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: { reachable: false, reason: '连不上你的 Worker（amsg.example.workers.dev）。' },
      localPushSubscribed: true,
    });

    expect(rowOf(rows, 'reachable').level).toBe('bad');
    expect(rowOf(rows, 'reachable').detail).toContain('连不上');
    expect(rows.filter((row) => row.key !== 'reachable').every((row) => row.level === 'unknown')).toBe(true);
    expect(rows.some((row) => row.level === 'ok')).toBe(false);
  });

  it('D1 没绑：点名是部署第一步漏点了 Add，且不再拿数据表报第二次红', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: {
        reachable: true,
        report: healthyReport({
          config: { ok: false, missing: ['DB'], message: 'Worker 配置不完整', warnings: [] },
          storage: { reachable: false },
        }),
      },
      localPushSubscribed: true,
    });

    const database = rowOf(rows, 'database');
    expect(database.level).toBe('bad');
    expect(database.detail).toContain('Add');
    expect(database.detail).toContain('Bindings');
    expect(database.detail).toContain('DB');
    // 库没绑的时候表当然是空的，这一行跟着报红只会把人往错的方向引。
    expect(rowOf(rows, 'schema').level).toBe('unknown');
  });

  it('主密钥缺失时提醒类型要选 Secret（选成 Text 下次部署就没了）', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: {
        reachable: true,
        report: healthyReport({
          config: { ok: false, missing: ['AMSG_MASTER_KEY'], message: '', warnings: [] },
        }),
      },
      localPushSubscribed: true,
    });

    const masterKey = rowOf(rows, 'masterKey');
    expect(masterKey.level).toBe('bad');
    expect(masterKey.detail).toContain('Secret');
  });

  /**
   * 回归守卫：查不了 ≠ 齐了。
   *
   * 这一项存在的全部意义就是查出「升级完 Worker 没重新连接」造成的表结构漂移——漂移时
   * cron 每分钟静默失败、主动消息整个停摆，而配置自检、任务列表、界面全都正常。查询本身
   * 挂了却报一句「表和列都齐了」，等于在唯一能发现这件事的地方给了假绿灯，比没有这项检查
   * 更糟。2026-08-09 本地实机跑到过：库里真缺 last_error 列和 message_outbox 表，
   * 面板照报「数据表 正常」。
   */
  it('worker 查不了表结构（schemaReady=null）→ 报未知，绝不报正常', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: {
        reachable: true,
        report: healthyReport({
          storage: {
            reachable: true,
            schemaReady: null,
            missingTables: [],
            missingColumns: [],
            pushSubscriptionRegistered: true,
            pendingTasks: 0,
            overdueTasks: 0,
            oldestOverdueMinutes: null,
          },
        }),
      },
      localPushSubscribed: true,
    });

    const schema = rowOf(rows, 'schema');
    expect(schema.level).toBe('unknown');
    expect(schema.level).not.toBe('ok');
    // 过去这一档说的就是这句——它正是那个假绿灯。
    expect(schema.detail).not.toContain('表和列都齐了');
    // 整块体检的基调也不能是「一切正常」。
    expect(summarizeAmsgDiagnostics(rows)).not.toBe('ok');
  });

  /**
   * 回归守卫：查不成的时候要说清楚是**哪一种**查不成。
   *
   * 三档要用户做的事完全不同，混成一句「查不了，不知道」等于什么都没说——真实故障里
   * 原因躺在 Cloudflare 日志里，用户看不到，只能一路猜。2026-08-09 从零部署稳定复现的
   * 就是 denied 那档：新建的 D1 库自带一张 Cloudflare 内部表，上游逐表问列时被它拒掉。
   */
  it('查不成的原因分档说话，不再一句「不知道」打发', () => {
    const rowFor = (schemaError: 'denied' | 'unsupported' | 'timeout' | 'other' | undefined) =>
      rowOf(buildAmsgDiagnosticRows({
        probe: {
          reachable: true,
          report: healthyReport({
            storage: {
              reachable: true,
              schemaReady: null,
              schemaError,
              missingTables: [],
              missingColumns: [],
              pushSubscriptionRegistered: true,
              pendingTasks: 0,
              overdueTasks: 0,
              oldestOverdueMinutes: null,
            },
          }),
        },
        localPushSubscribed: true,
      }), 'schema');

    // 后端自己的毛病：得说明不影响收发，别让用户白点一通按钮。
    expect(rowFor('denied').detail).toContain('内部表');
    expect(rowFor('denied').detail).toContain('不受影响');
    // 后端太旧：指向「更新 Worker」，不是「重新连接」。
    expect(rowFor('unsupported').detail).toContain('更新 Worker');
    // 库刚醒：再体检一次就好，不用改任何东西。
    expect(rowFor('timeout').detail).toContain('过一会儿');
    // 老 worker 不报这一项 → 退回原来那句笼统的，不能变成空字符串。
    expect(rowFor(undefined).detail).toContain('重新连接并验证');
    expect(rowFor(undefined).detail.length).toBeGreaterThan(10);
    // 哪一档都不许把这行说成绿的。
    (['denied', 'unsupported', 'timeout', 'other', undefined] as const).forEach((kind) => {
      expect(rowFor(kind).level).toBe('unknown');
    });
  });

  /**
   * 回归守卫：一张表都没建的空库不许显示成全绿。
   *
   * 一键部署完还没点「连接并验证」时正好是这个组合：表一张没建（主表不在 → schemaReady
   * 为 false），而自查被库里的内部表拒掉 → 「缺哪些表」是个空数组。界面只数这个数组的话，
   * 空库和齐活的库长得一模一样。
   */
  it('库是空的但自查也没跑成 → 报红说「一张表都没有」，不报绿', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: {
        reachable: true,
        report: healthyReport({
          storage: {
            reachable: true,
            schemaReady: false,
            schemaError: 'denied',
            missingTables: [],
            missingColumns: [],
            pushSubscriptionRegistered: false,
            pendingTasks: 0,
            overdueTasks: 0,
            oldestOverdueMinutes: null,
          },
        }),
      },
      localPushSubscribed: true,
    });

    const schema = rowOf(rows, 'schema');
    expect(schema.level).toBe('bad');
    expect(schema.detail).not.toContain('表和列都齐了');
    expect(schema.detail).toContain('重新连接并验证');
  });

  it('表结构是旧的（缺列）要单独报红并指向「重新连接并验证」', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: {
        reachable: true,
        report: healthyReport({
          storage: {
            reachable: true,
            schemaReady: false,
            missingTables: [],
            missingColumns: ['lease_until', 'retry_after'],
            pushSubscriptionRegistered: true,
            pendingTasks: 0,
            overdueTasks: 0,
            oldestOverdueMinutes: null,
          },
        }),
      },
      localPushSubscribed: true,
    });

    const schema = rowOf(rows, 'schema');
    expect(schema.level).toBe('bad');
    expect(schema.detail).toContain('lease_until');
    expect(schema.detail).toContain('重新连接并验证');
  });

  it('缺表时说清点哪个按钮能自动建好', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: {
        reachable: true,
        report: healthyReport({
          storage: {
            reachable: true,
            schemaReady: false,
            missingTables: ['scheduled_messages'],
            missingColumns: [],
            pushSubscriptionRegistered: false,
            pendingTasks: 0,
            overdueTasks: 0,
            oldestOverdueMinutes: null,
          },
        }),
      },
      localPushSubscribed: true,
    });

    expect(rowOf(rows, 'schema').detail).toContain('scheduled_messages');
    expect(rowOf(rows, 'schema').detail).toContain('重新连接并验证');
  });

  it('VAPID 没配齐要报红：任务建得成，到点一条都推不出去', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: {
        reachable: true,
        report: healthyReport({
          config: {
            ok: true,
            missing: [],
            message: '',
            warnings: [{ code: 'VAPID_MISSING', message: 'VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY 没配齐，到点消息不会推送出去。' }],
          },
        }),
      },
      localPushSubscribed: true,
    });

    const credential = rowOf(rows, 'pushCredential');
    expect(credential.level).toBe('bad');
    expect(credential.detail).toContain('推送');
    expect(summarizeAmsgDiagnostics(rows)).toBe('bad');
  });

  it('浏览器订阅了但云端没登记 → 报红并指向「开启通知与推送」', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: {
        reachable: true,
        report: healthyReport({
          storage: { ...healthyReport().storage, pushSubscriptionRegistered: false },
        }),
      },
      localPushSubscribed: true,
    });

    const device = rowOf(rows, 'pushDevice');
    expect(device.level).toBe('bad');
    expect(device.detail).toContain('开启通知与推送');
  });

  it('这台设备根本没订阅时也报红，而不是看云端脸色', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: { reachable: true, report: healthyReport() },
      localPushSubscribed: false,
    });
    expect(rowOf(rows, 'pushDevice').level).toBe('bad');
  });

  // ─── 假绿灯回归守卫 ───
  // 真实事故：登记状态两边一致（浏览器有订阅、Worker 上也有同一条 endpoint），
  // 但那条订阅在推送服务那侧早就作废，每次投递换回一个 410。体检当时七项里六项
  // 绿灯，用户看着一排绿灯完全无从下手。事实一直都在（上游把推送服务回的状态码
  // 记进了任务的失败记录），只是没人往界面上传。
  const REGISTERED_AT = Date.parse('2026-08-10T04:00:00.000Z');
  const stamp = (atMs: number) => new Date(atMs).toISOString();
  const withDelivery = (pushDelivery: AmsgDebugReport['storage']['pushDelivery']) => healthyReport({
    storage: { ...healthyReport().storage, pushDelivery },
  });
  const goneAt = (at: string, status = 410) => ({
    probed: true as const,
    gone: { status, atMs: Date.parse(at) },
    registeredAtMs: REGISTERED_AT,
  });

  it('登记状态全对，但上一次推送被判订阅失效 → 这台设备报红并指向「重置订阅」', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: { reachable: true, report: withDelivery(goneAt('2026-08-10T05:06:00.000Z')) },
      localPushSubscribed: true,
      formatTime: stamp,
    });

    const device = rowOf(rows, 'pushDevice');
    expect(device.level).toBe('bad');
    expect(device.detail).toContain('410');
    expect(device.detail).toContain('重置订阅');
    expect(summarizeAmsgDiagnostics(rows)).toBe('bad');
  });

  it('404（端点根本不存在）同样报红', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: { reachable: true, report: withDelivery(goneAt('2026-08-10T05:06:00.000Z', 404)) },
      localPushSubscribed: true,
      formatTime: stamp,
    });
    expect(rowOf(rows, 'pushDevice').level).toBe('bad');
  });

  it('失败记录早于订阅登记时刻 = 重置之前的旧账，不报红', () => {
    // 服务端只在失败时写失败记录、之后成功也不清。不比时刻的话，重置完那条红灯
    // 会一直挂着——假红灯和假绿灯一样会把人带偏。
    const rows = buildAmsgDiagnosticRows({
      probe: { reachable: true, report: withDelivery(goneAt('2026-08-10T03:00:00.000Z')) },
      localPushSubscribed: true,
      formatTime: stamp,
    });
    expect(rowOf(rows, 'pushDevice').level).toBe('ok');
  });

  it('问不到订阅登记时刻时报 warn：分不清新旧账，但也不给绿灯', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: {
        reachable: true,
        report: withDelivery({ ...goneAt('2026-08-10T05:06:00.000Z'), registeredAtMs: null }),
      },
      localPushSubscribed: true,
      formatTime: stamp,
    });
    expect(rowOf(rows, 'pushDevice').level).toBe('warn');
    expect(rowOf(rows, 'pushDevice').detail).toContain('重置订阅');
  });

  it('Worker 太旧、根本不查这一项 → warn + 指去「更新 Worker」，不给绿灯', () => {
    // 这一档是升级路上的常态：前端已经会读了，用户那台 Worker 还是老 bundle。
    // 给绿灯的话，假绿灯就原封不动地回来了。
    const rows = buildAmsgDiagnosticRows({
      probe: { reachable: true, report: withDelivery({ probed: false, reason: 'unsupported' }) },
      localPushSubscribed: true,
    });
    const device = rowOf(rows, 'pushDevice');
    expect(device.level).toBe('warn');
    expect(device.detail).toContain('更新 Worker');
    expect(summarizeAmsgDiagnostics(rows)).toBe('warn');
  });

  it('查了但没查成 → 同样 warn，并说清到点收不到该点哪儿', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: { reachable: true, report: withDelivery({ probed: false, reason: 'failed' }) },
      localPushSubscribed: true,
    });
    expect(rowOf(rows, 'pushDevice').level).toBe('warn');
    expect(rowOf(rows, 'pushDevice').detail).toContain('重置订阅');
  });

  it('云端压根没登记收件设备时不提投递——该修的是上一层', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: {
        reachable: true,
        report: healthyReport({
          storage: {
            ...healthyReport().storage,
            pushSubscriptionRegistered: false,
            pushDelivery: goneAt('2026-08-10T05:06:00.000Z'),
          },
        }),
      },
      localPushSubscribed: true,
    });
    const device = rowOf(rows, 'pushDevice');
    expect(device.level).toBe('bad');
    expect(device.detail).toContain('开启通知与推送');
    expect(device.detail).not.toContain('410');
  });

  // 没有细账（没拉 / 老面板）时只剩 /debug 的两个数，只能给笼统的那句。
  it('定时任务停摆、手上没有细账时说出积压条数和该去哪儿看日志', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: {
        reachable: true,
        report: healthyReport({
          tick: 'stalled',
          storage: {
            ...healthyReport().storage,
            pendingTasks: 3,
            overdueTasks: 3,
            oldestOverdueMinutes: 42,
          },
        }),
      },
      localPushSubscribed: true,
    });

    const tick = rowOf(rows, 'tick');
    expect(tick.level).toBe('bad');
    expect(tick.detail).toContain('3');
    expect(tick.detail).toContain('42');
    expect(tick.detail).toContain('Observability');
    expect(tick.items).toBeUndefined();
  });

  it('手上没有待发任务时定时器一栏是 unknown，不冒充健康', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: { reachable: true, report: healthyReport({ tick: 'unknown' }) },
      localPushSubscribed: true,
    });
    expect(rowOf(rows, 'tick').level).toBe('unknown');
  });

  it('旧 worker 没有体检端点时算 warn 不算坏（它只是查不了）', () => {
    const rows = buildAmsgDiagnosticRows({
      probe: { reachable: false, reason: '这台 Worker 上还没有体检端点。', unsupported: true },
    });
    expect(rowOf(rows, 'reachable').level).toBe('warn');
    expect(summarizeAmsgDiagnostics(rows)).toBe('warn');
  });
});

// ─── 「定时任务」那一行：逐条细账 ───
//
// 光有 /debug 的两个数时，这一行只能笼统地说「定时触发器可能没在跑……去看日志」。
// 真实情况里最常见的是任务在失败重试（原因明明白白记在任务上），其次是用户自己暂停了
// 后台任务——照那句话去 Cloudflare 翻触发器，什么都翻不出来。
describe('buildAmsgDiagnosticRows — 定时任务的逐条细账', () => {
  const NOW = Date.parse('2026-09-18T06:00:00.000Z');
  const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
  /** 只留时分，断言里好认。 */
  const hhmm = (atMs: number) => new Date(atMs).toISOString().slice(11, 16);
  const TRIGGER_BROKEN_TEXT = '定时触发器可能没在跑';

  const LLM_REASON = 'AI API error: 404 Not Found. Request URL: https://api.example.com/v1/chat/completions\n'
    + '  — The model `gpt-4o-typo` does not exist. (provider code: model_not_found)';

  const reportTask = (patch: Partial<AmsgTickReportTask> = {}): AmsgTickReportTask => ({
    uuid: 'task-1',
    charId: 'char-1',
    contactName: '小明',
    kind: null,
    messageType: 'auto',
    nextSendAt: at(42),
    state: 'ready',
    stuck: false,
    retryCount: 0,
    retryAfter: null,
    lastStartedAt: null,
    unfinishedAttempt: false,
    lateStart: false,
    queuedBehind: false,
    lastError: null,
    ...patch,
  });

  const tickReport = (patch: Partial<AmsgTickReport> = {}): AmsgTickReport => ({
    now: new Date(NOW).toISOString(),
    tasks: [],
    recentFailures: [],
    tickFailure: null,
    truncated: false,
    ...patch,
  });

  const tickRow = (
    tick: AmsgDebugReport['tick'],
    extra: Partial<AmsgDiagnosticsInput> = {},
    storagePatch: Partial<AmsgDebugReport['storage']> = {},
  ) => rowOf(buildAmsgDiagnosticRows({
    probe: {
      reachable: true,
      report: healthyReport({
        tick,
        storage: { ...healthyReport().storage, pendingTasks: 1, overdueTasks: 1, oldestOverdueMinutes: 42, ...storagePatch },
      }),
    },
    localPushSubscribed: true,
    formatTime: hhmm,
    nowMs: NOW,
    ...extra,
  }), 'tick');

  it('在失败重试的任务 → warn，逐条说清失败几次、几点再试、为什么，原文整段可看', () => {
    const task = reportTask({
      state: 'retry-wait',
      retryCount: 2,
      retryAfter: new Date(NOW + 5 * 60_000).toISOString(),
      lastError: { at: at(3), occurrence: at(42), reason: LLM_REASON, errorCode: 'LLM_CALL_FAILED', pushStatus: null },
    });
    const row = tickRow('failing', { tickReport: { ok: true, report: tickReport({ tasks: [task] }) } });

    expect(row.level).toBe('warn');
    // 在重试的任务既不能报绿，也不能说成触发器坏了。
    expect(row.detail).not.toContain(TRIGGER_BROKEN_TEXT);
    expect(row.detail).toContain('失败重试');
    expect(row.items?.[0].text).toContain('小明');
    expect(row.items?.[0].text).toContain('晚了 42 分钟');
    expect(row.items?.[0].text).toContain('已经失败 2 次');
    expect(row.items?.[0].text).toContain('06:05 再试');
    expect(row.items?.[0].text).toContain('模型接口拒了这次请求');
    expect(row.items?.[0].text).toContain('gpt-4o-typo');
    expect(row.items?.some((item) => item.text.includes(TRIGGER_BROKEN_TEXT))).toBe(false);
    // 原文一个字都不截：状态码和 Request URL 那半句只有在这儿才看得到。
    expect(row.items?.[0].raw).toBe(LLM_REASON);
  });

  it('后台任务被用户暂停着 → warn 并说暂停中，不说触发器坏了', () => {
    const row = tickRow('stalled', {
      cronPaused: true,
      tickReport: { ok: true, report: tickReport({ tasks: [reportTask({ stuck: true })] }) },
    }, { overdueTasks: 3, pendingTasks: 3 });

    expect(row.level).toBe('warn');
    expect(row.detail).toContain('暂停');
    expect(row.detail).not.toContain(TRIGGER_BROKEN_TEXT);
    expect(row.items?.[0].text).toContain('暂停');
    expect(row.items?.[0].text).not.toContain('Trigger events');
  });

  it('暂停着、也没拿到细账时同样不说触发器坏了', () => {
    const row = tickRow('stalled', { cronPaused: true }, { overdueTasks: 3, pendingTasks: 3 });
    expect(row.level).toBe('warn');
    expect(row.detail).toContain('暂停');
    expect(row.detail).toContain('3');
    expect(row.detail).not.toContain(TRIGGER_BROKEN_TEXT);
  });

  it('每分钟那一跳正在报错 → 报红，原文带上报错名和原话；缺列的话指去「重新连接并验证」', () => {
    const row = tickRow('healthy', {
      tickReport: {
        ok: true,
        report: tickReport({
          tickFailure: {
            stage: 'tick',
            name: 'D1_ERROR',
            message: 'no such column: lease_until: SQLITE_ERROR',
            code: null,
            firstAt: at(30),
            lastAt: at(1),
            count: 30,
            ongoing: true,
          },
        }),
      },
    });

    expect(row.level).toBe('bad');
    expect(row.detail).toContain('每分钟那一跳在报错');
    const item = row.items?.find((entry) => entry.text.includes('每分钟那一跳'));
    expect(item?.text).toContain('连着 30 次');
    expect(item?.text).toContain('整轮处理任务那一步');
    expect(item?.text).toContain('重新连接并验证');
    expect(item?.raw).toContain('no such column: lease_until');
    expect(item?.raw).toContain('D1_ERROR');
  });

  it('只有清理云端数据那一步在报错 → 提醒但不报红，说明消息照常投递', () => {
    const row = tickRow('healthy', {
      tickReport: {
        ok: true,
        report: tickReport({
          tickFailure: {
            stage: 'cloud-cleanup',
            name: 'D1_ERROR',
            message: 'no such table: cloud_cleanup_work',
            code: null,
            firstAt: at(30),
            lastAt: at(1),
            count: 30,
            ongoing: true,
          },
        }),
      },
    });

    expect(row.level).toBe('warn');
    expect(row.detail).toContain('清理云端数据');
    expect(row.detail).toContain('消息照常投递');
    const item = row.items?.find((entry) => entry.text.includes('每分钟那一跳'));
    expect(item?.text).toContain('清理云端数据那一步');
    expect(item?.text).toContain('消息照常投递');
    expect(item?.raw).toContain('no such table: cloud_cleanup_work');
  });

  it('整轮报错认得出来的另外两种各给一句该怎么办；阶段代号翻成中文', () => {
    const failureRow = (patch: Record<string, unknown>) => tickRow('healthy', {
      tickReport: {
        ok: true,
        report: tickReport({
          tickFailure: {
            stage: 'config', name: 'Error', message: 'boom', code: null,
            firstAt: at(2), lastAt: at(1), count: 2, ongoing: true, ...patch,
          },
        }),
      },
    });

    const vapid = failureRow({ name: 'VapidNotConfigured', message: 'VAPID keys missing' }).items?.[0];
    expect(vapid?.text).toContain('VAPID');
    expect(vapid?.text).toContain('读配置那一步');

    const timeout = failureRow({ stage: 'claim_failed', message: 'D1 query timed out', code: 'D1_TIMEOUT' }).items?.[0];
    expect(timeout?.text).toContain('没响应');
    expect(timeout?.text).toContain('给任务占位写库那一步');
    expect(timeout?.raw).toBe('Error: D1 query timed out (D1_TIMEOUT)');

    const storageFull = failureRow({ message: 'D1_ERROR: Exceeded maximum DB size', code: 'D1_STORAGE_FULL' }).items?.[0];
    expect(storageFull?.text).toContain('云端数据库满了');
    expect(storageFull?.raw).toBe('Error: D1_ERROR: Exceeded maximum DB size (D1_STORAGE_FULL)');

    const cleanup = failureRow({ stage: 'post_send_cleanup_failed_advance' }).items?.[0];
    expect(cleanup?.text).toContain('发完之后写库那一步');
  });

  it('整轮报错已经停了：一小时内报 warn，更早的不提级', () => {
    const stopped = (lastMinutesAgo: number) => tickRow('healthy', {
      tickReport: {
        ok: true,
        report: tickReport({
          tickFailure: {
            stage: 'tick', name: 'Error', message: 'boom', code: null,
            firstAt: at(lastMinutesAgo + 10), lastAt: at(lastMinutesAgo), count: 10, ongoing: false,
          },
        }),
      },
    });

    expect(stopped(20).level).toBe('warn');
    expect(stopped(20).items?.[0].text).toContain('之前报错');
    expect(stopped(180).level).toBe('ok');
  });

  it('开跑过、没发完、也没留下原因 → 说多半是被 Cloudflare 掐掉了', () => {
    const row = tickRow('stalled', {
      tickReport: {
        ok: true,
        report: tickReport({
          tasks: [reportTask({ stuck: true, unfinishedAttempt: true, lastStartedAt: at(30) })],
        }),
      },
    });

    expect(row.level).toBe('bad');
    expect(row.items?.[0].text).toContain('掐掉');
    expect(row.items?.[0].text).toContain('05:30 开始发过');
    expect(row.items?.[0].text).toContain('Observability');
    expect(row.items?.[0].raw).toBeUndefined();
  });

  it('一直没人来领、Worker 也没留下报错 → 指去看 Trigger events；有整轮报错时改指那条', () => {
    const stuck = reportTask({ stuck: true });
    const noFailure = tickRow('stalled', { tickReport: { ok: true, report: tickReport({ tasks: [stuck] }) } });
    expect(noFailure.level).toBe('bad');
    expect(noFailure.detail).toContain('有 1 条任务到点还没发出去');
    expect(noFailure.items?.[0].text).toContain('一直没开始发');
    expect(noFailure.items?.[0].text).toContain('Trigger events');

    const withFailure = tickRow('stalled', {
      tickReport: {
        ok: true,
        report: tickReport({
          tasks: [stuck],
          tickFailure: {
            stage: 'tick', name: 'Error', message: 'boom', code: null,
            firstAt: at(40), lastAt: at(1), count: 40, ongoing: true,
          },
        }),
      },
    });
    expect(withFailure.items?.[0].text).toContain('原因见下面');
    expect(withFailure.items?.[0].text).not.toContain('Trigger events');
    // 任务在前，整轮报错跟在后面——「见下面」才对得上。
    expect(withFailure.items?.[1].text).toContain('每分钟那一跳');
  });

  it('排队、正在发、开跑晚了，各说各的', () => {
    const report = tickReport({
      tasks: [
        reportTask({ uuid: 'a', state: 'sending', lastStartedAt: at(2) }),
        reportTask({ uuid: 'b', queuedBehind: true }),
        reportTask({ uuid: 'c', state: 'sending', lateStart: true, lastStartedAt: at(10), nextSendAt: at(42) }),
      ],
    });
    const row = tickRow('failing', { tickReport: { ok: true, report } });

    expect(row.items?.[0].text).toContain('正在发（2 分钟前开始的）');
    expect(row.items?.[1].text).toContain('排队');
    expect(row.items?.[2].text).toContain('到点 32 分钟后才开始的');
    expect(row.detail).toContain('开始发得比平时晚');
  });

  it('称呼：后台任务、即时回复、拿不到名字的各有说法', () => {
    const report = tickReport({
      tasks: [
        reportTask({ uuid: 'a', kind: 'doorplate' }),
        reportTask({ uuid: 'b', messageType: 'instant' }),
        reportTask({ uuid: 'c', contactName: null }),
      ],
    });
    const texts = tickRow('failing', { tickReport: { ok: true, report } }).items?.map((item) => item.text) ?? [];
    expect(texts[0].startsWith('小明的后台任务：')).toBe(true);
    expect(texts[1].startsWith('小明的即时回复：')).toBe(true);
    expect(texts[2].startsWith('某个角色：')).toBe(true);
  });

  it('最近一小时彻底没发出去的 → warn 并逐条列出；过期跳过的不给原文', () => {
    const row = tickRow('healthy', {
      tickReport: {
        ok: true,
        report: tickReport({
          recentFailures: [
            {
              uuid: 'f1', charId: 'char-1', contactName: '小明', kind: null, messageType: 'auto', outcome: 'failed',
              error: { at: at(10), occurrence: at(12), reason: 'CREDENTIAL_MISSING: 凭据 cred-1 不存在', errorCode: 'CREDENTIAL_MISSING', pushStatus: null },
            },
            {
              uuid: 'f2', charId: 'char-1', contactName: '小明', kind: null, messageType: 'auto', outcome: 'skipped',
              error: { at: at(20), occurrence: at(50), reason: 'stale', errorCode: null, pushStatus: null },
            },
          ],
        }),
      },
    });

    expect(row.level).toBe('warn');
    expect(row.detail).toContain('最近一小时有 2 次');
    expect(row.items?.[0].text).toContain('05:48 那次没发出去，不会再补发了');
    expect(row.items?.[0].text).toContain('API 凭据');
    expect(row.items?.[0].raw).toBe('CREDENTIAL_MISSING: 凭据 cred-1 不存在');
    expect(row.items?.[1].text).toContain('这次跳过了，下次到点照常');
    expect(row.items?.[1].text).toContain('过期太久');
    expect(row.items?.[1].raw).toBeUndefined();
  });

  it('一小时以前的失败不提级；这一行本来就不正常时才陪着列出来', () => {
    const oldFailure = {
      uuid: 'f1', charId: 'char-1', contactName: '小明', kind: null, messageType: 'auto', outcome: 'failed' as const,
      error: { at: at(180), occurrence: at(181), reason: 'boom', errorCode: null, pushStatus: null },
    };
    const quiet = tickRow('healthy', { tickReport: { ok: true, report: tickReport({ recentFailures: [oldFailure] }) } });
    expect(quiet.level).toBe('ok');
    expect(quiet.items).toBeUndefined();

    const busy = tickRow('stalled', {
      tickReport: { ok: true, report: tickReport({ tasks: [reportTask({ stuck: true })], recentFailures: [oldFailure] }) },
    });
    expect(busy.items?.map((item) => item.raw)).toContain('boom');

    // 一天以前的一律不提。
    const ancient = tickRow('stalled', {
      tickReport: {
        ok: true,
        report: tickReport({
          tasks: [reportTask({ stuck: true })],
          recentFailures: [{ ...oldFailure, error: { ...oldFailure.error, at: at(60 * 30), occurrence: at(60 * 30) } }],
        }),
      },
    });
    expect(ancient.items?.map((item) => item.raw)).not.toContain('boom');
  });

  it('细账没拉到 → 照旧给笼统的那句（带积压条数和 Observability），原因挂在下面', () => {
    const reason = '没拿到每条任务的细账（Worker 上的代码可能还不是最新，点上面的「更新 Worker」）。';
    const row = tickRow('stalled', { tickReport: { ok: false, reason } }, { overdueTasks: 3, pendingTasks: 3 });

    expect(row.level).toBe('bad');
    expect(row.detail).toContain('3');
    expect(row.detail).toContain('42');
    expect(row.detail).toContain('Observability');
    expect(row.detail).toContain(TRIGGER_BROKEN_TEXT);
    expect(row.items).toEqual([{ text: reason }]);
  });

  it('一切正常时细账拉没拉到都不多说话', () => {
    const row = tickRow('healthy', { tickReport: { ok: false, reason: '连不上' } }, { overdueTasks: 0, oldestOverdueMinutes: null });
    expect(row.level).toBe('ok');
    expect(row.items).toBeUndefined();
  });
});

describe('parseAmsgTickReport — 认定时任务细账', () => {
  it('单条任务形状不对就跳过那一条，整轮报错照样认下来', () => {
    const parsed = parseAmsgTickReport({
      success: true,
      data: {
        now: '2026-09-18T06:00:00.000Z',
        tasks: [
          { uuid: 'ok', nextSendAt: '2026-09-18T05:00:00.000Z', state: 'ready', retryCount: 1 },
          { uuid: 'bad-state', nextSendAt: '2026-09-18T05:00:00.000Z', state: 'wat' },
          null,
        ],
        recentFailures: [],
        tickFailure: {
          stage: 'tick', name: 'D1_ERROR', message: 'no such column: lease_until',
          firstAt: '2026-09-18T05:00:00.000Z', lastAt: '2026-09-18T05:59:00.000Z', count: 60, ongoing: true,
        },
        truncated: false,
      },
    });

    expect(parsed?.tasks.map((task) => task.uuid)).toEqual(['ok']);
    expect(parsed?.tickFailure?.message).toBe('no such column: lease_until');
    expect(parsed?.tickFailure?.ongoing).toBe(true);
  });

  it('没有这个端点的 Worker 回什么都不采信', () => {
    expect(parseAmsgTickReport({ success: false, error: { code: 'NOT_FOUND' } })).toBeNull();
    expect(parseAmsgTickReport('<!doctype html>')).toBeNull();
  });
});

describe('resolveInstantChatBlocker — 即时对话卡在哪一道', () => {
  const ALL_PASS: InstantChatGateInput = {
    connected: true,
    pushSubscribed: true,
    workerSupportsInstantChat: true,
  };

  it('三道全过才返回 null', () => {
    expect(resolveInstantChatBlocker(ALL_PASS)).toBeNull();
  });

  it('按「先补哪个」的顺序只报第一道：没连上盖过后面所有', () => {
    // 什么都没配的人会同时踩中三道。一次把三条都说给他，等于让他自己排先后。
    expect(resolveInstantChatBlocker({
      connected: false,
      pushSubscribed: false,
      workerSupportsInstantChat: false,
    })).toBe('没连上Worker');
  });

  it('连上了但没订阅推送 → 没开推送（这时候开了就是发得出、收不到）', () => {
    expect(resolveInstantChatBlocker({ ...ALL_PASS, pushSubscribed: false, workerSupportsInstantChat: false }))
      .toBe('没开推送');
  });

  it('连上了、推送也开了，只差 Worker 不认 /instant-chat → Worker太旧', () => {
    expect(resolveInstantChatBlocker({ ...ALL_PASS, workerSupportsInstantChat: false })).toBe('Worker太旧');
  });

  it('每个代号都配着一句话——设置页的黄字和使用统计的属性共用这份判定', () => {
    // 少一条的话界面上会出现空白提示：开关灰着、下面什么都不说。
    const codes: InstantChatBlocker[] = ['没连上Worker', '没开推送', 'Worker太旧'];
    for (const code of codes) {
      expect(INSTANT_CHAT_BLOCKER_HINTS[code], `${code} 没有对应文案`).toBeTruthy();
    }
    expect(Object.keys(INSTANT_CHAT_BLOCKER_HINTS)).toHaveLength(codes.length);
  });
});

