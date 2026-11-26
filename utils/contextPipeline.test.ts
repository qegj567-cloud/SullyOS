import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

// 仅保留已审计的文本消费者；新增 App 不得再接旧文本入口。
// 多人布局先渲染不带世界书的人设，最终仍走 ContextBuilder 消息管线。
const legacyTextCalls: Record<string, number> = {
    'apps/GroupChat.tsx': 1,
    'apps/GameApp.tsx': 1,
    'components/date/story/StoryTheaterSession.tsx': 2,
    'utils/socialGeneration.ts': 1,
    // 记忆诊断、迁移、后台门牌任务目前的契约是序列化文本，不是角色对话。
    'apps/MemoryPalaceApp.tsx': 1,
    'utils/memoryPalace/memoryRepair.ts': 1,
    'utils/memoryPalace/roomPlates.ts': 1,
};

function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const path = join(dir, entry.name);
        return entry.isDirectory() ? sourceFiles(path)
            : /\.tsx?$/.test(path) && !/\.(test|spec)\./.test(path) ? [path] : [];
    });
}

it('世界书底层处理只允许 ContextBuilder 调用；旧文本调用点不能继续扩散', () => {
    const root = process.cwd();
    const actual: Record<string, number> = {};
    const violations: string[] = [];
    for (const path of ['apps', 'components', 'utils'].flatMap(dir => sourceFiles(join(root, dir)))) {
        const name = relative(root, path).replace(/\\/g, '/');
        if (name === 'utils/context.ts' || name === 'utils/worldbook.ts') continue;
        const source = readFileSync(path, 'utf8');
        if (!/buildCoreContext|resolveWorldbookEntries|resolveWorldbookDepthEntries|injectWorldbookDepthEntries|splitWorldbookSections/.test(source)) continue;
        const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
        const visit = (node: ts.Node) => {
            if (ts.isCallExpression(node) && node.expression.getText(file) === 'ContextBuilder.buildCoreContext') {
                actual[name] = (actual[name] || 0) + 1;
            }
            if (ts.isImportDeclaration(node) && /worldbook['"]$/.test(node.moduleSpecifier.getText(file))
                && /resolveWorldbookEntries|resolveWorldbookDepthEntries|injectWorldbookDepthEntries|splitWorldbookSections/.test(node.getText(file))) {
                violations.push(name);
            }
            ts.forEachChild(node, visit);
        };
        visit(file);
    }
    expect(violations).toEqual([]);
    expect(actual).toEqual(legacyTextCalls);
});

it('异步上下文必须等待完成，不能把 Promise 拼进提示词或请求', () => {
    const violations: string[] = [];
    const asyncEntries = /^ContextBuilder\.(buildCoreContext|buildRoleSettingsContext|buildVolatileCoreState|buildCharacterContext|buildCharacterRequest)$/;
    for (const path of ['apps', 'components', 'utils', 'features', 'hooks', 'context'].flatMap(dir => sourceFiles(join(process.cwd(), dir)))) {
        const source = readFileSync(path, 'utf8');
        if (!source.includes('ContextBuilder.')) continue;
        const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
        const visit = (node: ts.Node) => {
            if (ts.isCallExpression(node) && asyncEntries.test(node.expression.getText(file))) {
                let parent = node.parent;
                while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
                // 直接 return 可把 Promise 交给上层；拼接字符串/数组/JSON 前必须 await。
                if (!ts.isAwaitExpression(parent) && !ts.isReturnStatement(parent)) {
                    violations.push(`${relative(process.cwd(), path)}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(file);
    }
    expect(violations).toEqual([]);
});

// 召回结果不挂在角色对象上（进出库都剥掉，见 utils/db.ts withoutRuntimeRecall）。
// 直接拿角色拼上下文的入口必须自己在副本上跑召回，或显式传清空召回的副本——
// 否则读到的是别的 App 刚留在共享对象上的召回。下列文件是已审计的例外。
const recallExemptions: Record<string, string> = {
    'utils/chatPrompts.ts': '被调用的那一层，召回由上游调用方准备',
    'components/date/story/StoryTheaterSession.tsx': '用 retrieveMemories 自算召回后显式挂到副本上',
    'apps/MemoryPalaceApp.tsx': '记忆诊断输出序列化文本，不是角色对话',
    'utils/memoryPalace/memoryRepair.ts': '记忆修复的序列化文本契约',
    'utils/memoryPalace/roomPlates.ts': '后台门牌整理的序列化文本契约',
};

it('直接拼角色上下文的入口必须自备召回，不能读共享角色对象上留下的召回', () => {
    const builders = /ContextBuilder\.(buildCharacterRequest|buildCoreContext|buildCharacterContext|buildVolatileCoreState)\(|ChatPrompts\.buildSystemPrompt(Parts)?\(/;
    const recallReady = /injectMemoryPalace\(|buildChatRequestPayload\(|memoryPalaceInjection: ''/;
    const root = process.cwd();
    const violations: string[] = [];
    for (const path of ['apps', 'components', 'utils', 'features', 'hooks', 'context'].flatMap(dir => sourceFiles(join(root, dir)))) {
        const name = relative(root, path).replace(/\\/g, '/');
        const source = readFileSync(path, 'utf8');
        if (builders.test(source) && !recallReady.test(source) && !recallExemptions[name]) violations.push(name);
    }
    expect(violations).toEqual([]);
});

// 世界书按「生效场景」筛选，每个装配入口都必须声明自己是哪个场景。
// 对象参数入口靠类型必填兜住，这里再补上类型管不到的：buildCoreContext / buildSystemPrompt 的
// 位置参数选项、写死的场景字符串是否登记过。值是变量时交给类型检查（WorldbookSceneId）。
const sceneArgs: Record<string, { index: number; key?: string }> = {
    buildCharacterRequest: { index: 0, key: 'scene' },
    buildCharacterContext: { index: 0, key: 'scene' },
    buildWorldbookRequest: { index: 0, key: 'scene' },
    buildGroupWorldbookRequest: { index: 0, key: 'scene' },
    buildChatRequestPayload: { index: 0, key: 'scene' },
    buildCoreContext: { index: 5, key: 'worldbookScene' },
    buildSystemPrompt: { index: 11, key: 'scene' },
    buildSystemPromptParts: { index: 12, key: 'scene' },
    inspectWorldbooks: { index: 3 },
    buildGroupSharedScene: { index: 3 },
};
// 原样转发选项的那一层：场景由它的调用方声明。
const sceneForwarders: Record<string, string[]> = {
    'utils/chatPrompts.ts': ['buildSystemPromptParts'],
};

it('世界书装配入口都声明了已登记的生效场景（主动消息模板 forFirePack 除外）', async () => {
    const { WORLDBOOK_SCENE_CATEGORIES } = await import('./worldbookScenes');
    const registered = new Set<string>(WORLDBOOK_SCENE_CATEGORIES.flatMap(category => category.subs.map(sub => sub.id)));
    const root = process.cwd();
    const violations: string[] = [];
    const calleeName = /\b(buildCharacterRequest|buildCharacterContext|buildWorldbookRequest|buildGroupWorldbookRequest|buildChatRequestPayload|buildCoreContext|buildSystemPromptParts|buildSystemPrompt|inspectWorldbooks|buildGroupSharedScene)\b/;
    for (const path of ['apps', 'components', 'utils', 'features', 'hooks', 'context'].flatMap(dir => sourceFiles(join(root, dir)))) {
        const name = relative(root, path).replace(/\\/g, '/');
        const source = readFileSync(path, 'utf8');
        if (!calleeName.test(source)) continue;
        const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
        const report = (node: ts.Node, why: string) =>
            violations.push(`${name}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${why}`);
        const checkValue = (node: ts.Node, value: ts.Expression) => {
            if (ts.isStringLiteralLike(value)) {
                if (!registered.has(value.text)) report(node, `未登记的场景 ${value.text}`);
            } else if (value.kind === ts.SyntaxKind.UndefinedKeyword || value.getText(file) === 'undefined') {
                report(node, '场景写成了 undefined');
            }
        };
        const visit = (node: ts.Node) => {
            if (ts.isCallExpression(node)) {
                const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text
                    : ts.isIdentifier(node.expression) ? node.expression.text : '';
                const rule = Object.prototype.hasOwnProperty.call(sceneArgs, callee) ? sceneArgs[callee] : undefined;
                if (rule && !sceneForwarders[name]?.includes(callee)) {
                    const arg = node.arguments[rule.index];
                    if (!rule.key) {
                        if (!arg) report(node, `${callee} 没传场景`);
                        else checkValue(node, arg);
                    } else if (!arg || !ts.isObjectLiteralExpression(arg)) {
                        report(node, `${callee} 的选项不是对象字面量，看不出场景`);
                    } else {
                        const prop = (key: string) => arg.properties.find(p => p.name && p.name.getText(file) === key);
                        const scene = prop(rule.key);
                        const firePack = prop('forFirePack');
                        const isFirePack = callee.startsWith('buildSystemPrompt') && firePack
                            && ts.isPropertyAssignment(firePack) && firePack.initializer.kind === ts.SyntaxKind.TrueKeyword;
                        if (!scene) {
                            if (!isFirePack) report(node, `${callee} 没传 ${rule.key}`);
                        } else if (ts.isPropertyAssignment(scene)) checkValue(node, scene.initializer);
                    }
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(file);
    }
    expect(violations).toEqual([]);
});
