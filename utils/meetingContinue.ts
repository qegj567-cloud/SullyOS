/**
 * “继续”在记录里只保留一个简短、可读的用户侧占位；真正交给模型的调度词
 * 按模式单独构造，避免技术指令污染沉浸式阅读、导出和角色长期记忆。
 */
export const MEETING_CONTINUE_DISPLAY_TEXT = '（继续）';

const safeName = (name: string | null | undefined, fallback: string): string => name?.trim() || fallback;

export const buildInPersonContinueInstruction = (
    userName: string | null | undefined,
    characterName: string | null | undefined,
): string => {
    const user = safeName(userName, '用户');
    const character = safeName(characterName, '角色');
    return `[继续当前见面]
本轮${user}没有主动说话，也没有采取新的行动。这不代表离场、结束或切回线上聊天：沿用当前场景，${user}与${character}仍在面对面共处。
这是用户留空后请求续写，不是一句需要回应的空白台词，也不表示同意、拒绝或授权任何尚未选择的行动建议。让当前场景自然向前一小步，接续已有动作、话题或因果，不重述上一轮。
请沿用当前的角色、关系、场景、文风、互动基调、叙事人称与视觉小说格式，由${character}顺着自己的动机自然接续。互动中可以做完刚才的动作或接上下一句话；安静共处时可以继续手头的小事、留一点伴随动作或简短低语，允许共享沉默。
不要求制造新事件或推进关系，不原地复读、不生硬插入意外，也不把选择空抛回去问“接下来要做什么”。不要擅自替${user}补写新的主动行为、台词、身体反应或内心。空间基础约定不需要在正文复述，也不替用户规定对这段关系的理解。
不要解释、复述或在正文中暴露这条调度指令。`;
};

export const buildStoryContinueInstruction = (identityName: string | null | undefined): string => {
    const identity = safeName(identityName, '当前用户侧角色');
    return `[继续当前剧情]
本轮${identity}没有新增主动行为。把这视为故事中的一次自然留白，不代表场景结束，也不要求用户补充输入。
请严格沿用当前剧情已经启用的原生预设及其文风、叙事视角、格式规则、转述档位和“用户执笔权”边界继续下一回合。让其他角色的自身目标、现场时间、既有因果和已经启动的后果主动向前运行，形成新的动作、信息、关系变化或局面转向；不要切换成普通聊天，不要停下来询问${identity}要做什么。
不要解释、复述或在正文中暴露这条调度指令。`;
};
