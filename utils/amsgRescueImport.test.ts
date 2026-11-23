import { beforeEach, expect, it } from 'vitest';
import { ContextBuilder } from './context';
import { AMSG2_INSTANT_STUB_TEMPLATE, AMSG_SLOT_SELF_LOG } from './amsgFirePack';
import {
    buildRescueImportAnalytics,
    isAmsgRescueExport,
    parseRescuePrompt,
    rescueExportToBackup,
} from './amsgRescueImport';
import { assertSupportedSullyBackup } from './backupImportPolicy';
import { DB, openSpaceDB } from './db';
import { importLegacyAsIndependentUser } from './legacyIndependentUserImport';
import { commitSpaceRows, readSpaceStore } from './userSpaceData';
import { saveUserSpaces } from './userSpaces';

const BUILT_AT = Date.UTC(2026, 10, 18, 13, 0);

// 角色设定里自带 markdown 小标题：拆的时候不能在它这里截断。
const char: any = {
    id: 'c1',
    name: '雾岛',
    avatar: '',
    description: '小雾',
    systemPrompt: '你是雾岛，说话很慢。\n\n### 我的习惯\n- 睡前要喝热牛奶',
    worldview: '雾港是一座常年起雾的海边城市。',
    memories: [],
    refinedMemories: { '2026-10': '一起去看了海\n还拍了很多照片', '2026-11': '天冷了，开始约着散步' },
    mountedWorldbooks: [{ id: 'w1', title: '雾港', content: '港口每晚十点关灯。', category: '地理', constant: true }],
};
const user: any = { name: '小明', avatar: '', bio: '喜欢猫，怕冷' };

/** 照 buildFirePack 的骨架拼模板；对话行格式同 activeMsgClient 的 formatHistoryLine + 时间前缀。 */
const buildTemplate = async () => [
    '你将代表下面这个角色，生成一条“主动发给用户”的私聊消息。',
    '',
    '【角色系统设定】',
    await ContextBuilder.buildCoreContext(char, user, true),
    '',
    '【最近对话上下文】',
    `【小明】\n[2026-11-18 21:00] 晚安\n\n【雾岛】\n[2026-11-18 21:01] 晚安，好梦\n\n【小明】\n[图片]${AMSG_SLOT_SELF_LOG}`,
    '',
    '【当前时刻补充】',
].join('\n');

const decoded = (value: unknown) => ({ status: 'decrypted', format: 'json', value });

const rescueFile = async () => ({
    format: 'sullyos-amsg-rescue',
    version: 1,
    users: {
        u1: {
            clientState: {
                'amsg:char:c1': {
                    fire_pack: { v: 7, template: await buildTemplate(), builtAt: BUILT_AT, tzId: 'Asia/Tokyo', userTzId: 'Asia/Shanghai', targetName: '小明' },
                    tool_pack: { v: 1, charName: '雾岛', memories: [{ date: '2026-11-01', summary: '散步到灯塔', mood: 'calm' }], activeMemoryMonths: ['2026-11'], timeAwarenessEnabled: true },
                },
                // 没开定时主动消息的角色：云端只有占位模板。
                'amsg:char:c2': {
                    fire_pack: { v: 7, template: AMSG2_INSTANT_STUB_TEMPLATE, builtAt: BUILT_AT, targetName: '小明' },
                    tool_pack: { v: 1, charName: '阿空', memories: [] },
                },
            },
            tables: {
                llm_credentials: [
                    { cred_id: 'char:c1/chat', decoded: { encrypted_value: decoded({ apiUrl: 'https://api.example.com/v1/chat/completions', apiKey: 'sk-c1', primaryModel: 'model-x' }) } },
                    { cred_id: 'char:c1/emotion', decoded: { encrypted_value: decoded({ apiUrl: 'https://api.anthropic.com/v1/messages', apiKey: 'sk-ant', primaryModel: 'claude-x' }) } },
                ],
                message_outbox: [
                    // 快照之前的推送已经在上下文里，不能再补一遍。
                    { decoded: { payload: decoded({ messageKind: 'content', messageId: 'old', message: '旧的', timestamp: new Date(BUILT_AT - 3_600_000).toISOString(), metadata: { charId: 'c1' } }) } },
                    { decoded: { payload: decoded({ messageKind: 'content', messageId: 'm2', message: '醒了吗', timestamp: new Date(BUILT_AT + 3_600_000).toISOString(), avatarUrl: 'https://img.example.com/c1.png', metadata: { charId: 'c1' } }) } },
                    { decoded: { payload: decoded({ messageKind: 'reasoning', messageId: 'r1', message: '内心独白', timestamp: new Date(BUILT_AT + 3_600_000).toISOString(), metadata: { charId: 'c1' } }) } },
                    { decoded: { payload: decoded({ messageKind: 'content', messageId: 'm3', message: '在忙吗', timestamp: new Date(BUILT_AT).toISOString(), metadata: { charId: 'c2' } }) } },
                ],
            },
        },
    },
});

beforeEach(() => localStorage.clear());

it('从真实拼出来的提示词里拆回角色设定、世界书、用户人设和月度总结', async () => {
    const parsed = parseRescuePrompt(await ContextBuilder.buildCoreContext(char, user, true))!;
    expect(parsed).toMatchObject({
        name: '雾岛',
        description: '小雾',
        systemPrompt: char.systemPrompt,
        worldview: char.worldview,
        userName: '小明',
        userBio: '喜欢猫，怕冷',
        refinedMemories: char.refinedMemories,
    });
    expect(parsed.worldbookText).toContain('港口每晚十点关灯。');
    expect(parsed.worldbookText).not.toContain('互动对象');
});

it('救援文件转成备份：角色、对话、日记、凭据、世界书各归各位', async () => {
    const file = await rescueFile();
    expect(isAmsgRescueExport(file)).toBe(true);
    const { backup, summary } = rescueExportToBackup(file, BUILT_AT + 7_200_000);
    expect(() => assertSupportedSullyBackup(backup)).not.toThrow();
    expect(summary).toEqual({ characters: 2, messages: 5, withoutPrompt: ['阿空'] });
    expect(buildRescueImportAnalytics(summary)).toEqual({ 救回角色设定: '部分' });

    const c1 = backup.characters!.find((c) => c.id === 'c1')!;
    expect(c1).toMatchObject({
        name: '雾岛',
        avatar: 'https://img.example.com/c1.png',
        systemPrompt: char.systemPrompt,
        refinedMemories: char.refinedMemories,
        memories: [{ date: '2026-11-01', summary: '散步到灯塔', mood: 'calm' }],
        activeMemoryMonths: ['2026-11'],
        customTimezoneEnabled: true,
        customTimezone: 'Asia/Tokyo',
        dialogueApi: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-c1', model: 'model-x' },
        emotionConfig: { enabled: true, api: { baseUrl: 'https://api.anthropic.com/v1/messages', apiType: 'anthropic' } },
    });
    expect(c1.mountedWorldbooks?.[0]).toMatchObject({ id: 'rescue-wb-c1', constant: true });
    expect(backup.worldbooks?.map((book) => book.id)).toEqual(['rescue-wb-c1']);
    expect(backup.userProfile).toMatchObject({ name: '小明', bio: '喜欢猫，怕冷' });

    const c1Messages = backup.messages!.filter((m) => m.charId === 'c1');
    expect(c1Messages.map((m) => [m.role, m.content])).toEqual([
        ['user', '晚安'],
        ['assistant', '晚安，好梦'],
        ['user', '[图片]'],
        ['assistant', '醒了吗'],
    ]);
    // 时间前缀按角色时区（东京）解读。
    expect(c1Messages[0].timestamp).toBe(Date.UTC(2026, 10, 18, 12, 0));
    expect(c1Messages.map((m) => m.timestamp)).toEqual([...c1Messages.map((m) => m.timestamp)].sort((a, b) => a - b));

    // 只剩占位模板的角色：名字、推送消息照样救回，设定留空。
    const c2 = backup.characters!.find((c) => c.id === 'c2')!;
    expect(c2).toMatchObject({ name: '阿空', systemPrompt: '' });
    expect(backup.messages!.filter((m) => m.charId === 'c2').map((m) => m.content)).toEqual(['在忙吗']);
});

it('即时对话那一轮比定时快照新时，对话改用它的结构化消息', async () => {
    const file: any = await rescueFile();
    file.users.u1.clientState['amsg:instant-input'] = {
        'turn-1': {
            v: 1, charId: 'c1',
            packedFirePack: { v: 7, template: AMSG2_INSTANT_STUB_TEMPLATE, builtAt: BUILT_AT + 60_000, chat: { builtAt: BUILT_AT + 60_000, messages: [
                { role: 'system', content: 'SYSTEM' },
                { role: 'user', content: '[2026-11-18 22:00] 还没睡' },
                { role: 'assistant', content: [{ type: 'text', text: '我也是' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] },
            ] } },
        },
    };
    const { backup } = rescueExportToBackup(file, BUILT_AT + 7_200_000);
    expect(backup.messages!.filter((m) => m.charId === 'c1').map((m) => m.content)).toEqual(['还没睡', '我也是\n[图片]', '醒了吗']);
    // 设定仍从定时快照里拆。
    expect(backup.characters!.find((c) => c.id === 'c1')!.systemPrompt).toBe(char.systemPrompt);
});

it('走「迁入为独立用户」导入：新建空间，原有数据不动', async () => {
    saveUserSpaces([{ id: 'default', name: '原用户' }]);
    const db = await openSpaceDB('default');
    await commitSpaceRows(db, Object.fromEntries(Array.from(db.objectStoreNames).map((name) => [name, []])), true);
    await commitSpaceRows(db, { characters: [{ id: 'c1', name: '原角色' }] });

    const { backup } = rescueExportToBackup(await rescueFile(), BUILT_AT + 7_200_000);
    const [space] = await importLegacyAsIndependentUser(backup, null);
    const spaceDb = await openSpaceDB(space.id);
    const characters = await readSpaceStore(spaceDb, 'characters');
    const imported = characters.find((c: any) => c.name === '雾岛');
    expect(imported).toBeTruthy();
    expect(imported.dialogueApi.apiKey).toBe('sk-c1');
    const messages = await readSpaceStore(spaceDb, 'messages');
    expect(messages.filter((m: any) => m.charId === imported.id).map((m: any) => m.content)).toContain('晚安，好梦');
    expect((await readSpaceStore(spaceDb, 'worldbooks')).length).toBe(1);
    expect(await DB.getCharacter('c1')).toMatchObject({ name: '原角色' });
});

// 定时模板里的世界书概率标记、chat 凭据行上的 -thinking 后缀、图片别猜的提示，都是云端那一侧加的，
// 救回本地时要还原，不能写进人设、世界书和对话正文。
it('救回时去掉云端专用的标记、思考后缀和图片提示', async () => {
    const file: any = await rescueFile();
    const pack = file.users.u1.clientState['amsg:char:c1'].fire_pack;
    pack.template = pack.template
        .replace('港口每晚十点关灯。\n---\n', '{{AMSG_WB_IF:w1}}港口每晚十点关灯。\n---\n{{/AMSG_WB_IF}}')
        .replace('【小明】\n[图片]', '【小明】\n[图片]（配图描述暂不可用，请不要猜测。）');
    expect(pack.template).toContain('AMSG_WB_IF');
    file.users.u1.tables.llm_credentials[0].decoded.encrypted_value = decoded({ apiUrl: 'https://relay.example.com/v1/chat/completions', apiKey: 'sk-c1', primaryModel: 'claude-sonnet-4-thinking' });
    const { backup } = rescueExportToBackup(file, BUILT_AT + 7_200_000);
    const c1 = backup.characters!.find((c) => c.id === 'c1')!;
    expect(JSON.stringify(backup.worldbooks)).not.toContain('AMSG_WB');
    expect(JSON.stringify(backup.worldbooks)).toContain('港口每晚十点关灯。');
    expect(c1.dialogueApi?.model).toBe('claude-sonnet-4');
    expect(backup.messages!.filter((m) => m.charId === 'c1').map((m) => m.content)).toContain('[图片]');
});
