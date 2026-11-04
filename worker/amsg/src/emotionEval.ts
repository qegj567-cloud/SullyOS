import {FRIEND_FEED_MAIN_PROMPT_PREFIX} from '../../../utils/friendFeedReplyFormat';
/**
 * 即时对话的云端情绪评估。
 *
 * 用户按下发送那一刻，前端把「评估提示词模板 + 副 API 凭据」一起交给云端；这一轮的
 * 主回复在 worker 里生成，情绪评估也在这里跑完，结果随最后一条推送回去。发完就能关
 * 页面——过去评估是在浏览器里 fire-and-forget 跑的，页面一关情绪底色就停更了。
 *
 * 模板是前端用 `buildEmotionEvalPrompt(..., includeContext=false, ...)` 生成的：两段
 * 大文本（角色的 system prompt、完整对话历史）留成占位符，由本次请求已有的 chat 段
 * 还原回原位。这样上下文不必在请求体里重复发一份，输出又与本地逐字对齐。
 *
 * 还原规则必须与前端生成模板时的约定**逐字同款**——格式一漂输出就变味。内核放在
 * utils/emotionEvalCore.ts 这份零依赖叶子里；这里只留 amsg 侧特有的部分（评估配置的
 * 摘取与红线处理、旁路存储键）。
 *
 * 失败绝不连累主回复——用户等的是那句话，情绪只是附赠；跑挂了就带一句短原因回去，
 * 让客户端能照实说明白，而不是丢一句「可查 worker 日志」。
 *
 * 零浏览器依赖（这份代码会被打进 worker bundle）。
 */

import {
  EMOTION_EVAL_TIMEOUT_MS,
  requestEmotionEval,
  restoreEvalPrompt as coreRestoreEvalPrompt,
  type EmotionEvalOutcome,
  tagHomeSecretEval,
} from '../../../utils/emotionEvalCore';

/** 副 API 凭据的两种长相：任务里内联的 { baseUrl, apiKey, model }，或凭据表里的三件套。 */
export interface AmsgEmotionEvalApi {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 前端塞进任务 metadata.amsgEmotionEval 的那份评估配置。 */
export interface AmsgEmotionEvalSpec {
  /** 带两个占位符的评估提示词模板。 */
  prompt: string;
  homeSecretRequestId?: string;
  /**
   * 副 API 凭据（没单独配就是主 API 那一份）。
   *
   * 支持凭据表的 Worker 上这里是空的——凭据存在 `llm_credentials` 里，任务只带
   * `credRefs.emotion` 这个名字，到点由 `ctx.resolveLlmCredential` 现读（见
   * resolveEmotionEvalApi）。换 Key 只要覆盖那一行，任务一个字都不用改。
   * 还带着它的是老 Worker 建的任务，或旧版前端排的存量任务，照旧直接用。
   */
  api?: AmsgEmotionEvalApi;
}

/** fire 时按名字取一行凭据（上游 amsg-server 2.6.0-next.17+ 挂在 hook ctx 上）。 */
export type ResolveLlmCredential = (
  credId: string,
) => Promise<{ apiUrl: string; apiKey: string; primaryModel: string } | null>;

/**
 * 这一轮评估用哪份副 API 凭据。
 *
 * 顺序：任务里内联的那份优先（存量任务只有这一份），没有才按 `credRefs.emotion` 去表里现读。
 * 两条都取不到就返回 null——调用方据此跳过评估，主回复照发（评估从来不连累正文）。
 *
 * 凭据表里存的是 `apiUrl`（已经是 /chat/completions 那个终点地址），而评估请求走的是
 * requestEmotionEval 那套 `{ baseUrl }` 口径——它自己会补 /chat/completions，所以这里
 * 把末尾那一段摘掉再交出去，两条路发出去的地址才一模一样。
 */
export const resolveEmotionEvalApi = async (
  spec: AmsgEmotionEvalSpec,
  credRefs: Record<string, unknown> | undefined | null,
  resolveLlmCredential: ResolveLlmCredential | undefined,
): Promise<AmsgEmotionEvalApi | null> => {
  if (spec.api?.baseUrl && spec.api.model) return spec.api;
  const credId = credRefs && typeof credRefs === 'object' && !Array.isArray(credRefs)
    ? (credRefs as Record<string, unknown>).emotion
    : undefined;
  if (typeof credId !== 'string' || !credId || typeof resolveLlmCredential !== 'function') return null;
  let resolved: Awaited<ReturnType<ResolveLlmCredential>> = null;
  try {
    resolved = await resolveLlmCredential(credId);
  } catch (error) {
    console.warn('[amsg:emotion] 凭据读不出来，这一轮不评估（主回复不受影响）', error);
    return null;
  }
  if (!resolved?.apiUrl || !resolved.primaryModel) return null;
  return {
    baseUrl: resolved.apiUrl.replace(/\/chat\/completions\/*$/i, ''),
    apiKey: resolved.apiKey || '',
    model: resolved.primaryModel,
  };
};


/**
 * 评估结果太大、一条 push 装不下时的旁路存储键（同 XHS 那套，见 amsgXhsSessionKey）。
 * push 里只留 `metadata.amsgEmotionRef` 指过来，客户端按键取回、用完即删。
 * 每任务固定一份、下次触发覆盖，所以没人来取也有上限，不需要额外的过期清理。
 */
export const amsgEmotionUpdateKey = (clientTaskId: string) => `emotion_update:${clientTaskId}`;

/**
 * 这份配置能不能用来发请求。
 *
 * 提示词是硬要求；凭据两种给法认一种就行——内联三件套（存量任务 / 老 Worker），
 * 或者整个不带 api、由 `credRefs.emotion` 到点现读（见 resolveEmotionEvalApi）。
 * 带了 api 却配不齐的那种一律判不可用（那份发不出去），和以前一样。
 */
const isUsableEvalSpec = (spec: unknown): spec is AmsgEmotionEvalSpec => {
  const s = spec as AmsgEmotionEvalSpec | undefined;
  if (!s || typeof s.prompt !== 'string' || !s.prompt) return false;
  if (s.api === undefined || s.api === null) return true;
  return typeof s.api.baseUrl === 'string' && !!s.api.baseUrl
    && typeof s.api.model === 'string' && !!s.api.model;
};

/**
 * 从要交给推送的 metadata 里摘掉评估配置。**红线**：它里头是用户副 API 的 apiKey。
 *
 * 任务 metadata 走的是端到端加密的信封，放在那儿是安全的；而推送 payload 出了这台
 * worker 就归推送服务管了，凭据跟着走等于把用户的副 API 送人。组 push 的那一层
 * （agentic 的 buildScheduledPush）把 metadata 整个摊开带走，所以只能在喂进去之前摘。
 */
export const stripEmotionEvalSpec = (
  metadata: Record<string, unknown> | undefined | null,
): Record<string, unknown> => {
  const { amsgEmotionEval: _secret, ...rest } = (metadata ?? {}) as Record<string, unknown>;
  return rest;
};

/**
 * 取出任务 metadata 里那份评估配置，**并就地从这个对象上删掉**（没有 / 不完整时返回 null，
 * 键照删——不完整的那份同样带着 apiKey）。
 *
 * 为什么是「取完就删」而不是只读：上游把解密后的 payload.metadata 按引用一路传下去——
 * `buildHookTask` 只做浅拷贝（`Object.freeze` 也只冻最外层），`onLLMOutput` 的
 * `ctx.metadata`、以及**没有 hook 接手时那条模板路径**读的都是同一个对象，而模板路径
 * 里 `push.metadata = args.metadata` 是直接引用赋值。也就是说，只要 `onBeforeFire`
 * 哪天在某个分支返回了 undefined（上游据此判「这次 hook 不接」），整份解密 metadata
 * 连副 API 的 apiKey 一起就会被塞进每一条推送。
 *
 * 在捕获点就地删掉，那条路径便无从可漏：这一跳的内存对象里根本没有这个键了。
 * D1 里的 encrypted_payload 一个字节没动，投递失败重跑时会重新解密出完整的一份，
 * 所以重试那一轮照样评估得了。
 *
 * 组 push 之前还有第二道 `stripEmotionEvalSpec`——两道都留着，别因为「上面已经删过」
 * 把哪一道拆了。
 */
export const takeEmotionEvalSpec = (
  metadata: Record<string, unknown> | undefined | null,
): AmsgEmotionEvalSpec | null => {
  const bag = metadata as Record<string, unknown> | undefined | null;
  if (!bag || typeof bag !== 'object') return null;
  const spec = bag.amsgEmotionEval;
  if (spec === undefined) return null;
  try {
    delete bag.amsgEmotionEval;
  } catch (error) {
    // 上游哪天把 metadata 也冻上了（严格模式下 delete 冻结属性会抛）。纵深防御的这一层
    // 自己绝不能变成故障源——记一笔就走，组 push 之前那道 strip 仍然拦得住。
    console.warn('[amsg:emotion] 评估配置删不掉（metadata 被冻结？），只剩组 push 前那道防线', error);
  }
  return isUsableEvalSpec(spec) ? spec : null;
};

// 占位符还原 / 打码 / 请求内核在 utils/emotionEvalCore.ts。
// re-export 保住既有导入点（本文件历史上就是它们的家）。
export { restoreEvalPrompt } from '../../../utils/emotionEvalCore';

/** 一次评估的结局：拿到原文，或者一句能给用户看的短失败原因。 */
export type AmsgEmotionEvalOutcome = EmotionEvalOutcome;

/**
 * 正文写完之后，最多再给情绪评估这么久搭上这班车。用在 index.ts 的 raceEmotionEval。
 *
 * 评估在 onBeforeFire 就跟主生成并行起跑了，正常情况下走到收尾时早就回来了，这个窗口
 * 一秒都用不上；它管的是副 API 限流 / 挂起的那种时候。评估自己的超时是 120 秒
 * （EMOTION_EVAL_TIMEOUT_MS），死等的话用户会对着「正在输入…」多看两分钟——同一句话走
 * 本地路径十秒就上屏了；工具循环吃掉大半预算时，这两分钟还会把整轮 600 秒的预算顶穿，
 * fire 失败重跑，用户拿到的是一句失败说明而不是那条已经写好的回复。
 *
 * 取舍：回复优先，情绪让路。没赶上的评估不作废：push 上挂引用键 + pending 标记
 * （客户端那盏「情绪更新中」继续亮着），收尾 hook（amsgFireSettled，上游会 await 它）
 * 接着等评估出结果，写进旁路存储（amsgEmotionUpdateKey），客户端对着引用键轮询补落
 * ——对齐本地路径「评估慢是晚到，不是丢弃」的语义。评估自带 EMOTION_EVAL_TIMEOUT_MS，
 * 这段续等是有界的。
 *
 * 放在这个文件而不是 index.ts：Worker 入口模块的具名导出会被 workerd 当成「命名入口点」
 * （Durable Object / WorkerEntrypoint 类就是靠这个认的），只接受函数和类。从入口导出一个
 * 数字，整个 Worker 起不来——报的是 `Incorrect type for map entry '<导出名>'`。
 * 入口只能导出函数，常量一律住在别的模块里。见 index.test.ts 的同名回归守卫。
 */
export const EMOTION_EVAL_RIDE_ALONG_MS = 10_000;

/**
 * 跑一次评估。成功给原文（解析交给客户端的 applyEmotionEvalRaw，与本地路径共用同一套
 * 容错），失败给一句短原因——它会跟着「评估有结论了」的信号回到客户端，替掉过去那句
 * 「可查 worker 日志」。用户自己部署的 worker，日志不是人人都会看。
 *
 * `chatMessages` 要传**主生成真正看到的那一串**（含末尾追加的时效块），
 * 少了那一块评估模型连现在几点都不知道，判出来的情绪会对不上角色刚说的话。
 */
export const runAmsgEmotionEval = async (
  spec: AmsgEmotionEvalSpec,
  /** 这一轮用哪份副 API——由 resolveEmotionEvalApi 从内联凭据或凭据表里取好再传进来。 */
  api: AmsgEmotionEvalApi,
  chatMessages: Array<{ role: string; content: unknown }>,
  charName: string,
  timeoutMs: number = EMOTION_EVAL_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<AmsgEmotionEvalOutcome> => {
  // User-comment replies belong to the main generation. Keep its separate task
  // out of the emotion prompt while retaining the shared history and live context.
  const emotionMessages = chatMessages.filter(message => !(message.role === 'system'
    && typeof message.content === 'string' && message.content.startsWith(FRIEND_FEED_MAIN_PROMPT_PREFIX)));
  const result = await requestEmotionEval(api, coreRestoreEvalPrompt(spec.prompt, emotionMessages, charName), timeoutMs, signal);
  return result.raw ? {...result, raw: tagHomeSecretEval(result.raw, spec.homeSecretRequestId)} : result;
};
