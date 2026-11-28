/**
 * canary 更新日志（docs/canary-channel.md「更新日志」）。
 *
 * 每次把 dev 发到 canary 之前，在最上面补当天的条目：写给 canary 志愿者看，一条一句，
 * 说这次能试什么、修了什么。同一天发了几次就往当天追加。canary 里每条按「日期 + 原文」认，
 * 没看过的条目在更新后第一次打开时按天弹出来；改了某条的措辞会被当成新条目再弹一次。
 */
import { RELEASE_CHANNEL, type ReleaseChannel } from './releaseChannel';

export interface CanaryChangelogDay {
  /** YYYY-MM-DD，新的在前。 */
  date: string;
  items: string[];
}

export const CANARY_CHANGELOG: CanaryChangelogDay[] = [
  {
    date: '2026-11-28',
    items: [
      '首次配置 API 改为「新建预设」入口，不再展开空白表单；Sully-11 与新手引导同步更新。',
      '模型选择恢复原地下拉，移除「存为新预设」按钮，预设修改保存成功后短暂提示「修改成功！」，新建可沿用已有预设参数。',
      '修复手机轻点 API 预设被防误触拦截的问题，减少预设列表重复排序和滚动监听；测试推送统一使用全局预设组件。',
      '见面入口换成雨夜票券布局：先选靠近 TA、让 TA 靠近或直接见面，再确认进入；十套文风可按文学风格名称搜索选择。',
      '见面支持四种可编辑行动建议，选中后可补充再发送；输入框默认收起，留空时继续当前剧情，也可展开到画面中央编辑。',
      '场景布置重新整理：观测、行动选择和离开提醒合为一组，立绘与皮肤统一管理，套装和预设改用自定义选择面板，选择及位置调整自动保存。',
      '见面文字播放与浮层渲染减负，并补齐使用统计和 Sully-11 配置答疑；本轮见面改动不升级数据库。',
      '世界书支持外层分组与一键全开全关：在世界书顶部点「分组」可把多本世界书归入一组整组启停，也能在组内单独开关某一本；重开整本书时保留书内原本停用的分割线或分支词条。',
      'API 预设改为底部选择面板：支持搜索和分组筛选，长按编辑，滑动时防误触；对话与识图统一紧凑布局和自定义菜单，测试成功／失败恢复绿红提示。',
      '选择预设默认跟随更新，移除容易误解的「引用同步中」标签；只改当前位置可用「复制为独立配置」，编辑预设会明确提示影响范围。',
      'API 调用记录移到识图右侧页签，每页 5 条、固定列表高度；输入构成单独弹窗，后端自报未返回时明确标注。',
      '开启「减弱模糊」后，桌面角色消息栏与默认透明日程卡改为与图标框一致的浅白半透底，浅色文字自动附带细阴影保证亮色壁纸下的清晰度。',
    ],
  },
  {
    date: '2026-11-27',
    items: [
      '修复：有时角色不理你刚发的话、接着上一个话题往下说。遇到过这个问题的话欢迎多聊几轮看看还会不会出现。',
      '世界书条目可以按场景启用：在条目编辑页「启用场景」里选它只在哪些 App 或功能里生效，比如一组书只给跑团用、不进私聊和记忆总结。欢迎试试整类开关和「编辑整组」统一设置。',
      '修复：云端生成的梦打开后没看完就刷新或被系统关掉，这场梦就没了。现在要看到结尾、或在弹窗里确认放弃才会收走，中途离开的下次从头再播。',
      '云端生成（日程、人格模拟、梦境）的完成通知没送到时，页面开着也会每分钟自己去取一次结果，不用再刷新或切出去再回来。',
      '修复：角色偶尔把一串 schedule_active_message(...) 排程代码直接发进聊天气泡和通知里。',
      '设置「备份与恢复」里的本机存储明细改成一个 App 一行：彼方、交换日记、哔哔、角色语音缓存等各自占多少都能看到，不再挤在「其他 App 数据」里。',
      '聊天回复期间更省资源：边听歌边聊天不再让页面持续重绘，角色连发几条消息时读库次数明显减少，流式输出的界面刷新合并成固定节奏。聊天记录很多、回复时容易卡或发烫的朋友，欢迎感受一下有没有改善。',
      '启动更轻：开机只读取壁纸、图标、字体这些桌面要用的资源，语音和歌曲缓存不再跟着一起读。更新后如果发现壁纸、图标、小组件或外观预设有哪样没显示出来，请告诉我们。',
      '外观「系统主题 → 动画与过场」新增「减弱模糊」开关：关掉毛玻璃效果，滚动更顺也更省电，默认关闭。',
      '设置「备份与恢复 → 一键优化」现在会顺带清理没有任何地方在用的图片（存进来不满三天的不清），结果里会写明清了几张、释放多少。只开着这一个标签页或窗口时才会清理。',
      '3D 小屋退出时立即释放显卡资源；省电档下房间里有两个小人时，画面静止后也会停止绘制。欢迎留意省电档里访客走动、张望、起身这些动作是否还自然。',
    ],
  },
  {
    date: '2026-11-26',
    items: [
      '聊天回复提示词调整：保留防敷衍与理解情绪的底线，把语气、句长和表达方式交还角色设定。欢迎用同一场景对比不同角色的回应。',
      '智能语境精简为话题锚点与最多一条条件提醒：闲聊无持续话题时不注入，继续、收束和换话题分别处理，并减少重复泛化安慰。',
    ],
  },
  {
    date: '2026-11-25',
    items: [
      '全站 API 配置改为自动保存：设置页、角色独立 API、记忆宫殿、情绪评估、心象翻译、独立识图及各独立应用填写完整或切换预设后直接生效。',
      'API 预设改为按引用同步：在任意面板点选预设后，编辑该预设会自动更新所有正在使用它的位置；只想改当前位置可点「改为单独填写」。',
      '彼方、查手机、家园的独立 API 面板支持按分组选预设、单独填写地址、拉取模型列表与测试连接。',
      '记忆宫殿副 API 与心象翻译 API 支持留空自动回退使用主对话 API（消耗主 API 额度），也可随时一键清空恢复回退；情绪副 API 收拢为全局共用并同步刷新云端凭据。',
      '修复：上一次更新后，打开应用时角色列表加载不出来（数据没有丢）。',
    ],
  },
  {
    date: '2026-11-24',
    items: [
      'canary 有了更新日志：每次更新后第一次打开，会按天列出新加的改动。',
      '开着主动消息 2.0 时，日程、人格模拟、梦境改为交给云端生成：顶部弹出「云端生成」后就可以切出去，生成不会中断。',
      '「云端生成」小条停 3 秒自己收起，也可以上滑收起；点开能看说明，或选「本功能不再提醒」。',
      '设置 → 主动消息 2.0 → 功能总览新增「云端生成」：私聊、日程、人格模拟、梦境可以分别切回本机生成，后三项能单独开关完成通知。',
      '修复：日程生成失败后每次进聊天都会重试；两个角色同时做梦时，前一场还没看就被覆盖。',
      '本次需要更新 Worker（开着自动更新的会自己跟上）。',
      '修复：开着主动消息 2.0 时，见面开了一个多小时才走开会收不到离开提醒；停在见面画面里时，离开后消息会被当成过期丢掉。这条同样要更新 Worker。',
      '报错提示更好读了：不再冒出 [object Object] 这类字样，网关报错只留关键几行；报错记录和诊断导出会带上版本号，密钥、令牌和推送地址自动打码。',
      '使用统计加了几项，用来看云端生成实际救回了多少次被切走打断的生成、失败都卡在哪；只收档位和固定选项，不收聊天内容。',
    ],
  },
];

/** 看过的条目。这台设备的状态，不进备份。 */
export const CANARY_CHANGELOG_SEEN_KEY = 'sullyos_canary_changelog_seen';

const entryKey = (date: string, item: string): string => `${date}\n${item}`;

/** 没看过的条目，按天分组，保持日志里的顺序。 */
export const unseenCanaryChangelog = (log: CanaryChangelogDay[], seen: ReadonlySet<string>): CanaryChangelogDay[] =>
  log
    .map((day) => ({ date: day.date, items: day.items.filter((item) => !seen.has(entryKey(day.date, item))) }))
    .filter((day) => day.items.length > 0);

/** 读不出来返回 null：宁可这次不弹，也别因为存储坏了每次开机都弹。 */
const readSeen = (): Set<string> | null => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CANARY_CHANGELOG_SEEN_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : []);
  } catch {
    return null;
  }
};

/** 只记日志里现在还有的条目，删掉的旧条目跟着从记录里消失，记录不会越攒越大。 */
export const markCanaryChangelogSeen = (log: CanaryChangelogDay[] = CANARY_CHANGELOG): void => {
  try {
    localStorage.setItem(
      CANARY_CHANGELOG_SEEN_KEY,
      JSON.stringify(log.flatMap((day) => day.items.map((item) => entryKey(day.date, item)))),
    );
  } catch {
    // 存不下就下次再弹一遍。
  }
};

/**
 * 这次启动要弹的条目。刚加入 canary 的那次启动有小金丝雀落地动画，日志不叠上去，
 * 直接记成看过：加入不是一次更新，之前的条目对新人没有意义。
 */
export const takeCanaryChangelog = (
  arrivedThisBoot: boolean,
  log: CanaryChangelogDay[] = CANARY_CHANGELOG,
  channel: ReleaseChannel = RELEASE_CHANNEL,
): CanaryChangelogDay[] => {
  if (channel !== 'canary') return [];
  if (arrivedThisBoot) {
    markCanaryChangelogSeen(log);
    return [];
  }
  const seen = readSeen();
  return seen ? unseenCanaryChangelog(log, seen) : [];
};

/** 「2026-11-24」显示成「11 月 24 日」。 */
export const formatCanaryChangelogDate = (date: string): string => {
  const [, month, day] = date.split('-').map(Number);
  return `${month} 月 ${day} 日`;
};
