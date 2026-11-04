import { buildHtmlPrompt } from './htmlPrompt';
import { buildThinkingChainPrompt } from './thinkingChainPrompt';
import { normalizeTranslationLangLabel } from './translationLang';

/** 聊天与定时主动消息共享用户配置的输出协议。 */
export function buildChatOutputStylePrompt(input: {
    charName: string;
    userName?: string;
    translationConfig?: { enabled: boolean; sourceLang: string; targetLang: string };
    htmlMode?: { enabled: boolean; customPrompt?: string };
    thinkingChain?: { enabled: boolean; customPrompt?: string };
    sarEnvelopeActive?: boolean;
}) {
    const { translationConfig, htmlMode, thinkingChain, sarEnvelopeActive } = input;
    const char = { name: input.charName };
    const userProfile = { name: input.userName };
    let prompt = '';
    // ── 4. 双语指令注入 ───────────────────────────────────
    const sourceLang = normalizeTranslationLangLabel(translationConfig?.sourceLang);
    const targetLang = normalizeTranslationLangLabel(translationConfig?.targetLang);
    const bilingualActive = !!(translationConfig?.enabled && sourceLang && targetLang);
    if (bilingualActive && translationConfig) {
        prompt += `\n\n[CRITICAL: 双语输出模式 - 必须严格遵守]
你的每句话都必须用以下XML标签格式输出双语内容：
<翻译>
<原文>${sourceLang}内容</原文>
<译文>${targetLang}内容</译文>
</翻译>

规则：
- 每句话单独包裹一个<翻译>标签
- 多句话就输出多个<翻译>标签，一句一个
- ${sarEnvelopeActive
            ? 'SAR 模块生效中：最外层必须是 <SAR_MODULE_OUTPUT>；在 CHAR_TRUE 与 CHAR_SURFACE 字段内部，各自用完整的 <翻译> 标签包裹每句话。除这个 SAR 容器与字段标签外，不写散落文字'
            : '<翻译>标签外不要写任何文字'}
- 表情包命令 [[SEND_EMOJI: ...]] 放在所有<翻译>标签外面
- 引用命令 [[QUOTE: ...]] 也放在所有<翻译>标签外面；引用内容请原样照抄用户说过的原文（不要翻译、不要包<翻译>标签）

示例（${sourceLang}→${targetLang}）：
<翻译>
<原文>こんにちは！</原文>
<译文>你好！</译文>
</翻译>
<翻译>
<原文>今日は何する？</原文>
<译文>今天做什么？</译文>
</翻译>`;
    }

    // ── 5. HTML 卡片模式 ─────────────────────────────────
    const htmlActive = !!htmlMode?.enabled;
    if (htmlActive) {
        prompt += `\n\n${buildHtmlPrompt(htmlMode?.customPrompt)}`;
    }

    // ── 6. 思考链提示词 ───────────────────────────────────
    const thinkingActive = !!thinkingChain?.enabled;
    if (thinkingActive) {
        const userName = (userProfile?.name && userProfile.name.trim()) || '用户';
        prompt += `\n\n${buildThinkingChainPrompt(char.name, userName)}`;
        const extra = (thinkingChain?.customPrompt || '').trim();
        if (extra) {
            prompt += `\n\n## 用户对内心独白的额外要求\n${extra}`;
        }
    }

    return { prompt, bilingualActive, htmlActive, thinkingActive };
}

/** 与 ChatApp 已持久化的角色翻译开关和旧版全局语言回退保持一致。 */
export function readChatTranslationConfig(charId: string) {
    try {
        const enabled = JSON.parse(localStorage.getItem(`chat_translate_enabled_${charId}`) || 'false') === true;
        return {
            enabled,
            sourceLang: normalizeTranslationLangLabel(localStorage.getItem(`chat_translate_source_lang_${charId}`)
                || localStorage.getItem('chat_translate_source_lang') || '日本語'),
            targetLang: normalizeTranslationLangLabel(localStorage.getItem(`chat_translate_lang_${charId}`)
                || localStorage.getItem('chat_translate_lang') || '中文'),
        };
    } catch { return undefined; }
}
