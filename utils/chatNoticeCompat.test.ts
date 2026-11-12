// @vitest-environment jsdom
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {afterEach, describe, expect, it} from 'vitest';
import {renderChatDecorationSample} from '../components/chat/ChatDecorationSample';
import ChatRuntimeStyle from '../components/chat/ChatRuntimeStyle';

// Selectors used by published whiteboxes, including escaped arbitrary values.
const oldPoke = String.raw`.group.relative.cursor-pointer .text-\[11px\].text-slate-500.bg-slate-200\/50.backdrop-blur-sm.px-4.py-1\.5.rounded-full.flex.items-center.gap-1\.5.border.border-white\/40.shadow-sm.select-none`;
const oldHistory = String.raw`.sully-chat-root .px-4.py-2.bg-white\/50.backdrop-blur-sm.rounded-full.text-xs.text-slate-500.shadow-sm.border.border-white.hover\:bg-white.transition-colors`;
const oldSystem = String.raw`.flex.items-center.gap-1\.5.bg-slate-200\/40.backdrop-blur-md.text-slate-500.px-3.py-1.rounded-full.shadow-sm.border.border-white\/20`;
const sample = (scene: string, css = '') => renderChatDecorationSample({format:'sullyos-chat-decoration',version:1,name:'兼容测试',parts:{css}}, scene);
const chatSource = readFileSync('apps/Chat.tsx', 'utf8');
const historyClasses = [...chatSource.matchAll(/className="(sully-chat-history-load[^"]+)"/g)].map(match => match[1]);

afterEach(() => { document.body.innerHTML = ''; document.head.innerHTML = ''; });

describe('published whitebox notice selectors', () => {
    it('matches the original poke and system selectors on real MessageItem markup', () => {
        document.body.innerHTML = sample('interaction').markup + sample('system').markup;
        expect(document.querySelector(oldPoke)).toBe(document.querySelector('.sully-chat-poke'));
        expect(document.querySelector(oldPoke)).not.toBeNull();
        expect(document.querySelector(oldSystem)).toBe(document.querySelector('.sully-chat-system-notice'));
        expect(document.querySelector(oldSystem)).not.toBeNull();
    });

    it('preserves the load-more chain and gives both history directions stable hooks', () => {
        expect(historyClasses).toHaveLength(3);
        document.body.innerHTML = `<main class="sully-chat-root">${historyClasses.map(classes => `<button class="${classes}">历史</button>`).join('')}</main>`;
        expect(document.querySelector(oldHistory)).toBe(document.querySelector('.sully-chat-history-load'));
        expect(document.querySelector(oldHistory)).not.toBeNull();
        expect(document.querySelector('.sully-chat-history-older')).not.toBeNull();
        expect(document.querySelector('.sully-chat-history-newer')).not.toBeNull();
    });

    it.each(['runtime', 'preview'])('keeps the optimized default fill and disables legacy blur in %s', target => {
        const poke = sample('interaction');
        const system = sample('system');
        const styles = target === 'runtime' ? renderToStaticMarkup(React.createElement(ChatRuntimeStyle)) : `<style>${poke.css}</style>`;
        document.body.innerHTML = styles + poke.markup + system.markup + `<button class="${historyClasses[0]}">历史</button>`;
        for (const selector of ['.sully-chat-poke', '.sully-chat-system-notice', '.sully-chat-history-load']) {
            const style = getComputedStyle(document.querySelector(selector)!);
            expect(style.backgroundColor, selector).toBe('rgba(255, 255, 255, 0.6)');
            expect(style.getPropertyValue('backdrop-filter')).toBe('none');
        }
        expect(getComputedStyle(document.querySelector('.sully-chat-poke')!).borderTopColor).toBe('rgba(226, 232, 240, 0.7)');
    });

    it.each(['runtime', 'preview'])('allows old author CSS and new single-class hooks to override the baseline in %s', target => {
        const authorCss = `${oldPoke}{background-color:rgb(10, 20, 30)} ${oldPoke} img{display:none} ${oldHistory}{background-color:rgb(30, 20, 10)}`;
        const poke = sample('interaction', authorCss);
        const styles = target === 'runtime' ? renderToStaticMarkup(React.createElement(ChatRuntimeStyle)) + `<style>${authorCss}</style>` : `<style>${poke.css}</style>`;
        document.body.innerHTML = styles + poke.markup + `<main class="sully-chat-root"><button class="${historyClasses[0]}">历史</button></main>`;
        expect(getComputedStyle(document.querySelector('.sully-chat-poke')!).backgroundColor).toBe('rgb(10, 20, 30)');
        expect(getComputedStyle(document.querySelector('.sully-chat-poke img')!).display).toBe('none');
        expect(getComputedStyle(document.querySelector('.sully-chat-history-load')!).backgroundColor).toBe('rgb(30, 20, 10)');
        // Authors using the new hook don't need !important to replace the default.
        document.body.innerHTML = renderToStaticMarkup(React.createElement(ChatRuntimeStyle)) + '<style>.sully-chat-poke{background-color:rgb(1, 2, 3)}</style>' + sample('interaction').markup;
        expect(getComputedStyle(document.querySelector('.sully-chat-poke')!).backgroundColor).toBe('rgb(1, 2, 3)');
    });
});
