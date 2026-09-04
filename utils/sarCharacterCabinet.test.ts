import { describe, expect, it } from 'vitest';
import {
    buildSARCharacterCabinetTurn,
    createSARCharacterCabinetNote,
    parseSARCharacterCabinetOutput,
    rollSARCharacterCabinetScenario,
} from './vrWorld/sarCharacterCabinet';

describe('SAR 角色柜子自由活动', () => {
    const actor = { id: 'actor', name: '凯恩', vrState: { enabled: true } } as any;
    const other = { id: 'other', name: '艾文', vrState: { enabled: true } } as any;
    const offline = { id: 'offline', name: '未接入者', vrState: { enabled: false } } as any;
    const user = { name: 'User' } as any;

    it('随机对象包含 User 与已接入角色，但排除自己和未接入角色', () => {
        const rolls = [0.99, 0, 0];
        const scenario = rollSARCharacterCabinetScenario(actor, [actor, other, offline], user, () => rolls.shift() ?? 0);
        expect(scenario.target).toMatchObject({ id: 'other', name: '艾文', kind: 'character' });
        expect(scenario.variant.pool).toBe('variant');
        expect(scenario.story.pool).toBe('story');

        const userScenario = rollSARCharacterCabinetScenario(actor, [actor, other], user, () => 0);
        expect(userScenario.target).toMatchObject({ id: 'user', name: 'User', kind: 'user' });
    });

    it('提示词锁定对象和两枚芯片，并要求完整剧情与私人随笔', () => {
        const scenario = rollSARCharacterCabinetScenario(actor, [actor, other], user, () => 0.99);
        const prompt = buildSARCharacterCabinetTurn(actor.name, scenario);
        expect(prompt).toContain(`已经把它们同时用在 ${scenario.target.name} 身上`);
        expect(prompt).toContain(`异界异格芯片「${scenario.variant.title}」`);
        expect(prompt).toContain(`异界坐标芯片「${scenario.story.title}」`);
        expect(prompt).toContain('完整的小剧情');
        expect(prompt).toContain('第一人称随笔和吐槽');
        expect(prompt).toContain('不是 User 的五十轮正式推演');
    });

    it('解析结构化随笔并生成可写入私信卡的柜中记录', () => {
        const parsed = parseSARCharacterCabinetOutput('```json\n{"title":"黄瓜警报","activity":"给艾文装了两枚芯片，结果追着猫跑了三条街。","story":"艾文先变成了一只猫。","notes":"我发誓我只拿出了一根黄瓜。","highlight":"他看到黄瓜以后跳上了吊灯。"}\n```');
        expect(parsed).toEqual({
            title: '黄瓜警报',
            activity: '给艾文装了两枚芯片，结果追着猫跑了三条街。',
            story: '艾文先变成了一只猫。',
            notes: '我发誓我只拿出了一根黄瓜。',
            highlight: '他看到黄瓜以后跳上了吊灯。',
        });
        const scenario = rollSARCharacterCabinetScenario(actor, [actor, other], user, () => 0.99);
        const note = createSARCharacterCabinetNote(actor, scenario, parsed!, 12345);
        expect(note.actorName).toBe('凯恩');
        expect(note.targetName).toBe('艾文');
        expect(note.variantTitle).toBe(scenario.variant.title);
        expect(note.storyTitle).toBe(scenario.story.title);
        expect(note.createdAt).toBe(12345);
    });

    it('模型漏掉 JSON 时仍保住整篇随笔', () => {
        const parsed = parseSARCharacterCabinetOutput('他变成猫以后，真的被一根黄瓜吓上了吊灯。');
        expect(parsed?.story).toContain('黄瓜');
        expect(parsed?.notes).toContain('黄瓜');
    });
});
