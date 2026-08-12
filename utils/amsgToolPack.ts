/**
 * amsgToolPack — 满血 v2 服务端工具循环的云端状态数据形状（前端 / amsg worker 共用）
 *
 * fire_pack 解决「到点拿什么 prompt」，这里解决「到点跑工具要什么数据」：
 *   - tool_pack（每角色，namespace `amsg:char:<id>`）：recall 要读的月度总结、
 *     XHS 角色开关、日记查询要用的角色名。
 *   - tool_config（全局，namespace `amsg:global`）：搜索 / Notion / 飞书凭据、
 *     XHS MCP 配置、代理 worker 地址——即 agenticTools 各工具从 realtimeConfig
 *     里读的那个子集，多一分都不上云。
 *
 * 两份都由前端在 amsgStateSync 冲刷时与 fire_pack 同批 putClientState（tool_pack
 * 上传前过 packStateValue，够大会压成 gz1: 前缀）；worker 在 onBeforeFire 先解压再
 * 解析，任何一份解不出来都按云端状态异常抛 AMSG2_FIRE_STATE_MISSING 硬失败，不降级。
 *
 * 环境无关叶子模块：不 import 任何带浏览器依赖的东西（会进 worker bundle）。
 */

import type { CharacterProfile, RealtimeConfig } from '../types';
import type { AgenticToolMemory, AgenticToolRealtimeConfig } from './agenticTools';
import type { McpFireServer } from './mcpFireCore';
import { getProxyWorkerUrl } from './proxyWorker';

export const AMSG_TOOL_PACK_KEY = 'tool_pack';
export const AMSG_GLOBAL_NAMESPACE = 'amsg:global';
export const AMSG_TOOL_CONFIG_KEY = 'tool_config';

export interface AmsgToolPromptControls {
  mcpTools: boolean;
  realtimeState: boolean;
  timeAwareness: boolean;
}

export const normalizeAmsgToolPromptControls = (
  value: Partial<AmsgToolPromptControls> | null | undefined,
): AmsgToolPromptControls => ({
  mcpTools: value?.mcpTools !== false,
  realtimeState: value?.realtimeState !== false,
  timeAwareness: value?.timeAwareness !== false,
});

/** recall / 日记 / XHS 门控要用的角色侧数据（CharacterProfile 的极小子集）。 */
export interface AmsgToolPack {
  v: 1;
  charName: string;
  xhsEnabled: boolean;
  activeMemoryMonths: string[];
  memories: AgenticToolMemory[];
  /**
   * 角色的「时间感知」开关。关掉的角色不该知道今天几号，所以到点注入的实时世界里
   * 也不给今日节日——这个字段不上云的话，前台守着的开关一到主动消息就失效。
   */
  timeAwarenessEnabled: boolean;
}

/**
 * 工具凭据与配置（RealtimeConfig 的工具子集 + 代理地址）。
 *
 * 凭据字段表直接继承 AgenticToolRealtimeConfig——那边是工具真正会读的字段，这边是把它们
 * 上云的载体，本来就该一模一样。抄成两份的话，agenticTools 多读一个字段而这边忘了加，
 * worker 到点就静默拿 undefined（编译期一声不吭），正是窄接口想消灭的那类失配。
 */
export interface AmsgToolConfig extends AgenticToolRealtimeConfig {
  v: 1;
  /** 搜索 / Notion / 飞书都经它转发；worker 端用 setProxyWorkerUrlOverride 注入。 */
  proxyWorkerUrl: string;
  /**
   * 实时天气：worker 到点自己去拉一次填进提示词（不是工具，是常驻注入，跟前台一样）。
   * key 留空走免费的 Open-Meteo，所以只要开关加城市就够。
   */
  weatherEnabled: boolean;
  weatherCity?: string;
  weatherApiKey?: string;
  /** 热榜要拉哪几个平台（继承来的 newsEnabled 管开关）。留空 worker 用内置默认。 */
  newsPlatforms?: string[];
  /** 上云这份比工具侧多一个 cookie（lite 模式的登录态），并且两个开关字段是必填。 */
  xhsMcpConfig?: {
    enabled: boolean;
    serverUrl: string;
    cookie?: string;
    platform?: 'xhs' | 'rednote';
    loggedInUserId?: string;
    loggedInNickname?: string;
    userXsecToken?: string;
  };
  /**
   * 用户自配的通用 MCP 服务器（enabled 且已发现工具、worker 够得着的那部分，
   * 见 mcpClient.collectMcpFireServers）。代理字段不上云——worker 直连没有 CORS。
   */
  mcpServers?: McpFireServer[];
  /** 前台「兼容模式」同款开关：false = 中转拒 tools，worker 退到正文协议。缺省按 true。 */
  mcpUseNativeTools?: boolean;
  promptControls?: AmsgToolPromptControls;
}

/**
 * CF worker 直连打不通的地址（本机 / 私网 / 链路本地）。这类服务器不上云、也不在
 * 打包给主动消息的提示词里出现——上了只会教角色用一个必失败的工具，然后它把一次
 * 根本没发生的搜索说成「我刚搜了下，没啥好东西」。
 *
 * 这是体验护栏、不是安全边界：只看字面地址，域名解析到内网之类拦不住。
 * 住在这个叶子里是因为浏览器侧（MCP 服务器清单、小红书配置）和打包链路都要用同一份判断。
 */
export const isWorkerReachableUrl = (url: string): boolean => {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    const h = u.hostname.toLowerCase();
    // 本机与「没有地址」的占位地址
    if (h === 'localhost' || h === '0.0.0.0' || h === '[::]' || h === '[::1]') return false;
    // 只在局域网里能解析的域名后缀（my-nas.local、foo.localhost）
    if (/\.(local|localhost)$/.test(h)) return false;
    // IPv4 回环 / 私网 / 链路本地
    if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h)) return false;
    // IPv6 唯一本地地址 fc00::/7（首段以 fc / fd 开头，hostname 带方括号）
    if (/^\[f[cd]/.test(h)) return false;
    return true;
  } catch { return false; }
};

export const buildToolPack = (
  char: CharacterProfile,
  promptControls?: Partial<AmsgToolPromptControls>,
): AmsgToolPack => ({
  v: 1,
  charName: char.name,
  xhsEnabled: !!char.xhsEnabled,
  activeMemoryMonths: char.activeMemoryMonths || [],
  // id 等工具用不到的字段不上云；runRecall 只读 date / mood / summary。
  memories: (char.memories || []).map((mem) => ({
    date: mem.date,
    summary: mem.summary,
    ...(mem.mood ? { mood: mem.mood } : {}),
  })),
  // 前台的判定是「没显式关就算开」，这边照抄同一句，别让同一个开关两处读出不同结果。
  timeAwarenessEnabled: normalizeAmsgToolPromptControls(promptControls).timeAwareness && char.timeAwarenessEnabled !== false,
});

/**
 * mcp 参数由浏览器侧调用方现读现传（本模块是环境无关叶子，不能自己碰 localStorage）。
 * 不传就一个 mcp 字段都不写——老 worker 解析这份配置时零影响。
 */
export const buildToolConfig = (
  realtimeConfig: RealtimeConfig | undefined,
  mcp?: { servers: McpFireServer[]; useNativeTools: boolean },
  promptControls?: Partial<AmsgToolPromptControls>,
): AmsgToolConfig => {
  const rc = realtimeConfig;
  const xhs = rc?.xhsMcpConfig;
  return {
    v: 1,
    proxyWorkerUrl: getProxyWorkerUrl(),
    promptControls: normalizeAmsgToolPromptControls(promptControls),
    weatherEnabled: !!rc?.weatherEnabled,
    ...(rc?.weatherCity ? { weatherCity: rc.weatherCity } : {}),
    ...(rc?.weatherApiKey ? { weatherApiKey: rc.weatherApiKey } : {}),
    newsEnabled: !!rc?.newsEnabled,
    ...(rc?.newsApiKey ? { newsApiKey: rc.newsApiKey } : {}),
    ...(rc?.newsPlatforms?.length ? { newsPlatforms: rc.newsPlatforms } : {}),
    notionEnabled: !!rc?.notionEnabled,
    ...(rc?.notionApiKey ? { notionApiKey: rc.notionApiKey } : {}),
    ...(rc?.notionDatabaseId ? { notionDatabaseId: rc.notionDatabaseId } : {}),
    ...(rc?.notionNotesDatabaseId ? { notionNotesDatabaseId: rc.notionNotesDatabaseId } : {}),
    feishuEnabled: !!rc?.feishuEnabled,
    ...(rc?.feishuAppId ? { feishuAppId: rc.feishuAppId } : {}),
    ...(rc?.feishuAppSecret ? { feishuAppSecret: rc.feishuAppSecret } : {}),
    ...(rc?.feishuBaseId ? { feishuBaseId: rc.feishuBaseId } : {}),
    ...(rc?.feishuTableId ? { feishuTableId: rc.feishuTableId } : {}),
    // 小红书服务器多半就跑在用户自己电脑上（localhost:xxxx）。worker 从 CF 那头连不上，
    // 这份配置上了云也只是让角色去撞一次必失败的调用，所以够不着的干脆不带。
    ...(xhs?.serverUrl && isWorkerReachableUrl(xhs.serverUrl)
      ? {
          xhsMcpConfig: {
            enabled: !!xhs.enabled,
            serverUrl: xhs.serverUrl,
            ...(xhs.cookie ? { cookie: xhs.cookie } : {}),
            ...(xhs.platform ? { platform: xhs.platform } : {}),
            ...(xhs.loggedInUserId ? { loggedInUserId: xhs.loggedInUserId } : {}),
            ...(xhs.loggedInNickname ? { loggedInNickname: xhs.loggedInNickname } : {}),
            ...(xhs.userXsecToken ? { userXsecToken: xhs.userXsecToken } : {}),
          },
        }
      : {}),
    ...(mcp?.servers.length ? { mcpServers: mcp.servers, mcpUseNativeTools: mcp.useNativeTools } : {}),
  };
};

/** 云端 tool_pack 字符串 → 结构；形状不对返回 null（fire 链按无工具数据继续）。 */
export const parseToolPack = (value: string): AmsgToolPack | null => {
  try {
    const parsed = JSON.parse(value);
    if (
      !parsed || typeof parsed !== 'object' ||
      parsed.v !== 1 ||
      typeof parsed.charName !== 'string' ||
      typeof parsed.timeAwarenessEnabled !== 'boolean' ||
      !Array.isArray(parsed.activeMemoryMonths) ||
      !Array.isArray(parsed.memories)
    ) {
      return null;
    }
    return parsed as AmsgToolPack;
  } catch {
    return null;
  }
};

/** 云端 tool_config 字符串 → 结构；形状不对返回 null。 */
export const parseToolConfig = (value: string): AmsgToolConfig | null => {
  try {
    const parsed = JSON.parse(value);
    if (
      !parsed || typeof parsed !== 'object' ||
      parsed.v !== 1 ||
      typeof parsed.proxyWorkerUrl !== 'string'
    ) {
      return null;
    }
    // MCP 清单是列表，坏条目单独丢掉就行——整份判 null 会连搜索/Notion 凭据一起赔进去。
    const cleaned = Array.isArray(parsed.mcpServers)
      ? parsed.mcpServers.filter((s: any) =>
          s && typeof s === 'object' &&
          typeof s.id === 'string' && typeof s.name === 'string' &&
          typeof s.url === 'string' && Array.isArray(s.tools))
      : undefined;
    // 丢东西要留痕：不然「角色怎么不调这个工具了」只能靠猜。
    if (cleaned && cleaned.length !== parsed.mcpServers.length) {
      console.warn('[amsg:tool_config] MCP 清单有条目形状不对，已丢弃',
        parsed.mcpServers.length - cleaned.length);
    }
    if (cleaned?.length) {
      parsed.mcpServers = cleaned;
    } else {
      // 两个字段同进同退（与 buildToolConfig 一致）：没有服务器时留个开关没有意义。
      delete parsed.mcpServers;
      delete parsed.mcpUseNativeTools;
    }
    parsed.promptControls = normalizeAmsgToolPromptControls(parsed.promptControls);
    return parsed as AmsgToolConfig;
  } catch {
    return null;
  }
};
