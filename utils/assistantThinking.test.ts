import { describe, expect, it } from 'vitest';
import { normalizeAssistantCompletion, readAssistantMessage, readAssistantThinking, splitInlineThinking } from './assistantThinking';

describe('provider-labelled assistant thinking', () => {
    it.each(['reasoning_content', 'reasoning', 'thinking'])('reads %s even after an empty placeholder', field => {
        expect(readAssistantMessage({reasoning_content:'', [field]:'先想一下', content:'你好'}))
            .toEqual({content:'你好', reasoning:'先想一下'});
    });

    it('separates Gemini thought blocks and Anthropic thinking blocks from text', () => {
        expect(readAssistantMessage({content:[
            {text:'摘要一', thought:true, thoughtSignature:'opaque'},
            {type:'thinking', thinking:'摘要二', signature:'opaque'},
            {type:'redacted_thinking', data:'encrypted', text:'不要显示'},
            {type:'text', text:'你好'}, {text:'呀'},
        ]})).toEqual({content:'你好呀', reasoning:'摘要一摘要二'});
    });

    it('reads structured summaries but never encrypted data or signatures', () => {
        expect(readAssistantMessage({content:'你好', reasoning_details:[
            {type:'reasoning.summary', summary:'先'},
            {type:'reasoning.text', text:'想一下', signature:'opaque'},
            {type:'reasoning.encrypted', data:'encrypted', text:'不要显示'},
        ]})).toEqual({content:'你好', reasoning:'先想一下'});
    });

    it('does not duplicate mirrored aliases or drop whitespace stream chunks', () => {
        expect(readAssistantMessage({reasoning_content:' ',reasoning:'摘要'}).reasoning).toBe('摘要');
        expect(readAssistantMessage({reasoning_content:' ',reasoning_details:[{type:'reasoning.summary',summary:'摘要'}]}).reasoning).toBe('摘要');
        expect(readAssistantMessage({reasoning:' ',reasoning_details:[{type:'reasoning.text',text:' '}]}).reasoning).toBe(' ');
        expect(readAssistantMessage({reasoning:'摘要',thinking:'摘要',reasoning_details:[{type:'reasoning.summary',summary:'摘要'}]}).reasoning).toBe('摘要');
    });

    it('normalizes once without losing tool continuation fields', () => {
        const message = {content:[{text:'摘要',thought:true},{text:'你好'}],
            anthropic_content:[{type:'thinking',thinking:'摘要',signature:'signed'}],
            reasoning_details:[{type:'reasoning.encrypted',data:'opaque'}],tool_calls:[{id:'call1'}]};
        const result=normalizeAssistantCompletion({choices:[{message}]});
        expect(result.choices[0].message).toEqual({...message,content:'你好',reasoning_content:'摘要'});
        expect(normalizeAssistantCompletion(result)).toEqual(result);
    });

    it('captures a trailing unfinished block after a closed block, including tag attributes', () => {
        const text='<THINK mode="summary">第一段</THINK >你好<thought>后半段';
        expect(splitInlineThinking(text)).toEqual({content:'你好',reasoning:'第一段\n\n后半段'});
        expect(readAssistantThinking({content:text, reasoning:'原生摘要'})).toBe('原生摘要\n\n第一段\n\n后半段');
    });

    it('keeps unmarked analytical prose as normal content', () => {
        const content="The patient's recollection aligns with the timeline. This needs investigation.";
        expect(readAssistantMessage({content})).toEqual({content,reasoning:''});
        expect(splitInlineThinking(content)).toEqual({content,reasoning:''});
    });
});
