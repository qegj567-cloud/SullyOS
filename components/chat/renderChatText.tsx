import React from 'react';

// --- Inline formatting parser: code → bold → italic → plain ---
const renderInline = (text: string): React.ReactNode[] => {
    // Pre-clean: markdown links [text](url) → just text
    let cleaned = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    // Pre-clean: stray backticks
    cleaned = cleaned.replace(/``+/g, '').replace(/(^|\s)`(\s|$)/g, '$1$2');

    const nodes: React.ReactNode[] = [];
    let nodeKey = 0;

    // Step 1: Split by inline code (`code`)
    const codeParts = cleaned.split(/(`[^`]+`)/g);
    for (const codePart of codeParts) {
        if (codePart.startsWith('`') && codePart.endsWith('`') && codePart.length > 2) {
            nodes.push(<code key={nodeKey++} className="bg-black/10 px-1 py-0.5 rounded text-[13px] font-mono">{codePart.slice(1, -1)}</code>);
            continue;
        }
        // Step 2: Split by bold (**text**)
        const boldParts = codePart.split(/(\*\*[^*]+\*\*)/g);
        for (const boldPart of boldParts) {
            if (boldPart.startsWith('**') && boldPart.endsWith('**') && boldPart.length > 4) {
                nodes.push(<strong key={nodeKey++} className="font-bold">{boldPart.slice(2, -2)}</strong>);
                continue;
            }
            // Strip orphaned ** that didn't form a valid bold pair
            const cleanedBold = boldPart.replace(/\*\*/g, '');
            // Step 3: Split by italic (*text*) — safe because ** already stripped
            const italicParts = cleanedBold.split(/(\*[^*]+\*)/g);
            for (const italicPart of italicParts) {
                if (italicPart.startsWith('*') && italicPart.endsWith('*') && italicPart.length > 2) {
                    nodes.push(<em key={nodeKey++} className="italic opacity-80">{italicPart.slice(1, -1)}</em>);
                    continue;
                }
                // Strip orphaned * that didn't form a valid italic pair
                const cleanedItalic = italicPart.replace(/\*/g, '');
                if (cleanedItalic) nodes.push(cleanedItalic);
            }
        }
    }
    return nodes;
};

// --- Enhanced Text Rendering (Markdown Lite) ---
export const renderContent = (text: string) => {
    // 1. Split by Code Blocks (triple backtick)
    const parts = text.split(/(```[\s\S]*?```)/g);
    return parts.map((part, index) => {
        // Render Code Block
        if (part.startsWith('```') && part.endsWith('```')) {
            const codeContent = part.replace(/^```\w*\n?/, '').replace(/```$/, '');
            return (
                <pre key={index} className="bg-black/80 text-gray-100 p-3 rounded-lg text-xs font-mono overflow-x-auto my-2 whitespace-pre shadow-inner border border-white/10">
                    {codeContent}
                </pre>
            );
        }

        // Clean stray backtick artifacts from non-code text
        let cleanedPart = part
            .replace(/``+/g, '')
            .replace(/(^|\s)`(\s|$)/gm, '$1$2');

        // Render Regular Text (split by newlines for paragraph spacing)
        return cleanedPart.split('\n').map((line, lineIdx) => {
            const key = `${index}-${lineIdx}`;

            // Quote Format "> text"
            if (line.trim().startsWith('>')) {
                const quoteText = line.trim().substring(1).trim();
                if (!quoteText) return null;
                return (
                    <div key={key} className="my-1 pl-2.5 border-l-[3px] border-current opacity-70 italic text-[13px]">
                        {renderInline(quoteText)}
                    </div>
                );
            }

            // Markdown Header "# text" → render as bold text (strip the #)
            const headerMatch = line.match(/^#{1,6}\s+(.+)$/);
            if (headerMatch) {
                return <div key={key} className="min-h-[1.2em] font-bold">{renderInline(headerMatch[1])}</div>;
            }

            return <div key={key} className="min-h-[1.2em]">{renderInline(line)}</div>;
        });
    });
};
