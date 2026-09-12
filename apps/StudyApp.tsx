
import React, { useState, useEffect, useRef } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { StudyCourse, StudyChapter, CharacterProfile, Message, UserProfile, APIConfig, StudyTutorPreset, QuizQuestion, QuizSession, QuizQuestionNote } from '../types';
import { ContextBuilder } from '../utils/context';
import Modal from '../components/os/Modal';
import { safeResponseJson, extractJson } from '../utils/safeApi';
import { injectMemoryPalace } from '../utils/memoryPalace/pipeline';
import { Notepad, Check, X, CheckCircle, XCircle, Hand } from '@phosphor-icons/react';
import { CharacterGroupFilterBar, filterCharactersByGroup, GROUP_FILTER_ALL } from '../components/character/CharacterGroupFilter';
import TokenImg from '../components/os/TokenImg';
import { trackEvent } from '../utils/analytics';
import { extractPdfText, isPdfFile } from '../utils/pdfText';

type KatexLike = {
    renderToString: (latex: string, options: any) => string;
};

let katexPromise: Promise<KatexLike> | null = null;

const loadScript = (src: string): Promise<void> => new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-src=\"${src}\"]`) as HTMLScriptElement | null;
    if (existing) {
        if ((existing as any).dataset.loaded === 'true') {
            resolve();
            return;
        }
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error(`load failed: ${src}`)), { once: true });
        return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.src = src;
    script.onload = () => {
        script.dataset.loaded = 'true';
        resolve();
    };
    script.onerror = () => reject(new Error(`load failed: ${src}`));
    document.head.appendChild(script);
});

const loadKatex = async (): Promise<KatexLike> => {
    if (!katexPromise) {
        katexPromise = loadScript('https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js').then(() => {
            const katex = (window as any).katex as KatexLike | undefined;
            if (!katex) throw new Error('KaTeX 加载失败');
            return katex;
        });
    }
    return katexPromise;
};

// --- Styles ---
const GRADIENTS = [
    'linear-gradient(135deg, #e0c3fc 0%, #8ec5fc 100%)',
    'linear-gradient(120deg, #f093fb 0%, #f5576c 100%)',
    'linear-gradient(to top, #cfd9df 0%, #e2ebf0 100%)',
    'linear-gradient(135deg, #f6d365 0%, #fda085 100%)',
    'linear-gradient(to top, #5ee7df 0%, #b490ca 100%)',
    'linear-gradient(to right, #43e97b 0%, #38f9d7 100%)'
];

// --- Renderer Component ---
// Enhanced Markdown & Math Renderer
const BlackboardRenderer: React.FC<{ text: string, isTyping?: boolean, katexRenderer?: { renderToString: (latex: string, options: any) => string } | null }> = ({ text, isTyping, katexRenderer }) => {
    
    // Helper to render math using KaTeX
    const renderMath = (latex: string, displayMode: boolean) => {
        try {
            // Clean up common latex issues from LLM
            const cleanLatex = latex
                .replace(/\\\[/g, '') // Remove \[
                .replace(/\\\]/g, ''); // Remove \]

            const html = katexRenderer?.renderToString(cleanLatex, {
                displayMode: displayMode,
                throwOnError: false, 
                output: 'html',
            });
            if (!html) {
                return <span className="font-mono text-emerald-200">{latex}</span>;
            }
            // Force white color for KaTeX elements specifically
            return <span dangerouslySetInnerHTML={{ __html: html }} className={displayMode ? "block my-2 w-full overflow-x-auto" : "inline-block mx-1"} />;
        } catch (e) {
            return <span className="text-red-400 text-xs font-mono bg-black/20 p-1 rounded">{latex}</span>;
        }
    };

    // Inline Parser for Bold, Italic, Code, Inline Math ($...$)
    const parseInline = (line: string): React.ReactNode[] => {
        // Regex logic:
        // 1. $...$ (Inline Math)
        // 2. **...** (Bold)
        // 3. *...* (Italic)
        // 4. `...` (Code)
        const tokenRegex = /(\$[^$]+?\$|\*\*[^*]+?\*\*|\*[^*]+?\*|`[^`]+?`)/g;
        
        return line.split(tokenRegex).map((part, i) => {
            if (part.startsWith('$') && part.endsWith('$')) {
                return <span key={i}>{renderMath(part.slice(1, -1), false)}</span>;
            }
            if (part.startsWith('**') && part.endsWith('**')) {
                return <strong key={i} className="text-emerald-300 font-bold mx-0.5">{part.slice(2, -2)}</strong>;
            }
            if (part.startsWith('*') && part.endsWith('*')) {
                return <em key={i} className="text-emerald-200/80 italic">{part.slice(1, -1)}</em>;
            }
            if (part.startsWith('`') && part.endsWith('`')) {
                return <code key={i} className="bg-black/40 text-orange-200 px-1.5 py-0.5 rounded font-mono text-xs mx-0.5 border border-white/10">{part.slice(1, -1)}</code>;
            }
            return <span key={i}>{part}</span>;
        });
    };

    // Block Renderer
    const renderBlock = (block: string, index: number, storedMath: string[], storedCode: string[]) => {
        const trimmed = block.trim();
        if (!trimmed) return <div key={index} className="h-4"></div>;

        // 1. Restore Protected Math Block
        const mathMatch = trimmed.match(/^__BLOCK_MATH_(\d+)__$/);
        if (mathMatch) {
            const id = parseInt(mathMatch[1]);
            return (
                <div key={index} className="w-full text-center my-4 overflow-x-auto no-scrollbar py-3 bg-white/5 rounded-xl border border-white/5 shadow-inner">
                    {renderMath(storedMath[id], true)}
                </div>
            );
        }

        // 2. Restore Protected Code Block
        const codeMatch = trimmed.match(/^__BLOCK_CODE_(\d+)__$/);
        if (codeMatch) {
            const id = parseInt(codeMatch[1]);
            return (
                <pre key={index} className="bg-black/60 p-4 rounded-xl font-mono text-xs text-emerald-100 my-4 overflow-x-auto border border-white/10 shadow-inner whitespace-pre-wrap leading-relaxed">
                    {storedCode[id]}
                </pre>
            );
        }

        // Headers
        if (trimmed.startsWith('# ')) return <h1 key={index} className="text-3xl font-bold text-white mt-8 mb-6 pb-2 border-b-2 border-white/20 font-serif">{trimmed.slice(2)}</h1>;
        if (trimmed.startsWith('## ')) return <h2 key={index} className="text-2xl font-bold text-emerald-200 mt-6 mb-4 font-serif">{trimmed.slice(3)}</h2>;
        if (trimmed.startsWith('### ')) return <h3 key={index} className="text-xl font-bold text-emerald-300 mt-5 mb-2 font-serif">{trimmed.slice(4)}</h3>;

        // Blockquotes
        if (trimmed.startsWith('> ')) {
            return (
                <div key={index} className="border-l-4 border-emerald-500/50 bg-white/5 p-4 my-3 rounded-r-xl text-emerald-100 italic">
                    {parseInline(trimmed.slice(2))}
                </div>
            );
        }

        // Lists
        if (trimmed.match(/^[-•]\s/)) {
            return (
                <div key={index} className="flex gap-3 my-2 pl-2">
                    <span className="text-emerald-400 font-bold mt-1">•</span>
                    <span className="text-white/90 leading-relaxed">{parseInline(trimmed.slice(2))}</span>
                </div>
            );
        }
        
        // Numbered Lists
        const numMatch = trimmed.match(/^(\d+)\.\s+(.*)/);
        if (numMatch) {
             return (
                <div key={index} className="flex gap-3 my-2 pl-2">
                    <span className="text-emerald-400 font-bold font-mono mt-1">{numMatch[1]}.</span>
                    <span className="text-white/90 leading-relaxed">{parseInline(numMatch[2])}</span>
                </div>
            );
        }

        // Standard Paragraph
        return (
            <div key={index} className="text-white/90 text-lg font-medium leading-loose tracking-wide font-serif mb-4 text-justify">
                {parseInline(block)}
            </div>
        );
    };



    const isTableRow = (line: string) => {
        const trimmed = line.trim();
        return trimmed.includes('|') && /^\|?.+\|.+\|?$/.test(trimmed);
    };

    const isTableSeparator = (line: string) => {
        const cleaned = line.trim().replace(/^\|/, '').replace(/\|$/, '');
        const segments = cleaned.split('|').map(seg => seg.trim());
        if (segments.length < 2) return false;
        return segments.every(seg => /^:?-{3,}:?$/.test(seg));
    };

    const splitTableCells = (line: string) => line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map(cell => cell.trim());

    const renderTable = (rows: string[], index: number) => {
        if (rows.length < 2) return renderBlock(rows[0], index, storedMath, storedCode);

        const header = splitTableCells(rows[0]);
        const hasSeparator = rows[1] ? isTableSeparator(rows[1]) : false;
        const bodyRows = (hasSeparator ? rows.slice(2) : rows.slice(1)).map(splitTableCells);

        return (
            <div key={`table-${index}`} className="my-4 overflow-x-auto rounded-xl border border-white/10 bg-black/25">
                <table className="w-full min-w-[360px] border-collapse text-sm text-left">
                    <thead className="bg-white/10">
                        <tr>
                            {header.map((cell, i) => (
                                <th key={i} className="px-3 py-2 text-emerald-200 font-bold border-b border-white/10">
                                    {parseInline(cell)}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {bodyRows.map((row, rowIndex) => (
                            <tr key={rowIndex} className="odd:bg-white/0 even:bg-white/[0.03]">
                                {header.map((_, colIndex) => (
                                    <td key={colIndex} className="px-3 py-2 text-white/90 border-t border-white/5 align-top leading-relaxed">
                                        {parseInline(row[colIndex] || '')}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        );
    };

    // --- Pre-processing Logic ---
    // Protect blocks (Math $$...$$ and Code ```...```) from being split by newlines
    const storedMath: string[] = [];
    const storedCode: string[] = [];
    let processedText = text;

    // 1. Extract Code Blocks
    processedText = processedText.replace(/```[\s\S]*?```/g, (match) => {
        const content = match.replace(/^```\w*\n?/, '').replace(/```$/, '');
        storedCode.push(content);
        return `\n__BLOCK_CODE_${storedCode.length - 1}__\n`; // Add newlines to ensure it separates
    });

    // 2. Extract Block Math ($$ ... $$)
    // Note: LLMs sometimes output \[ ... \] or $$ ... $$. We try to catch $$...$$ mainly.
    processedText = processedText.replace(/\$\$[\s\S]*?\$\$/g, (match) => {
        const content = match.slice(2, -2).trim(); 
        storedMath.push(content);
        return `\n__BLOCK_MATH_${storedMath.length - 1}__\n`;
    });

    // 3. Split by newlines + merge markdown table blocks
    const blocks = processedText.split('\n');
    const renderedBlocks: React.ReactNode[] = [];

    for (let i = 0; i < blocks.length; i++) {
        const line = blocks[i];
        if (isTableRow(line) && i + 1 < blocks.length && isTableSeparator(blocks[i + 1])) {
            const tableLines = [line, blocks[i + 1]];
            let j = i + 2;
            while (j < blocks.length && isTableRow(blocks[j])) {
                tableLines.push(blocks[j]);
                j += 1;
            }
            renderedBlocks.push(renderTable(tableLines, i));
            i = j - 1;
            continue;
        }
        renderedBlocks.push(renderBlock(line, i, storedMath, storedCode));
    }
    
    return (
        <div className="space-y-1">
            {/* FORCE WHITE COLOR FOR KATEX */}
            <style>{`
                .katex { color: white !important; } 
                .katex-display { margin: 0.5em 0; }
                .katex-html { color: white !important; }
            `}</style>
            
            {renderedBlocks}
            {isTyping && (
                <div className="mt-4 animate-pulse flex items-center gap-2 text-emerald-500">
                    <span className="w-2 h-5 bg-emerald-500"></span>
                    <span className="text-xs font-mono tracking-widest">WRITING...</span>
                </div>
            )}
        </div>
    );
};

const StudyApp: React.FC = () => {
    const { closeApp, characters, activeCharacterId, apiConfig, addToast, userProfile, updateCharacter, characterGroups } = useOS();
    const [mode, setMode] = useState<'bookshelf' | 'classroom' | 'quiz' | 'quiz_review' | 'practice_book'>('bookshelf');
    const [courses, setCourses] = useState<StudyCourse[]>([]);
    const [activeCourse, setActiveCourse] = useState<StudyCourse | null>(null);
    const [selectedChar, setSelectedChar] = useState<CharacterProfile | null>(null);
    const [tutorGroupId, setTutorGroupId] = useState<string>(GROUP_FILTER_ALL); // 书架页「当前助教」的分组筛选
    
    // Classroom State
    const [classroomState, setClassroomState] = useState<'idle' | 'teaching' | 'q_and_a' | 'finished'>('idle');
    const [currentText, setCurrentText] = useState('');
    const [displayedText, setDisplayedText] = useState('');
    const [isTyping, setIsTyping] = useState(false);
    const [userQuestion, setUserQuestion] = useState('');
    const [chatHistory, setChatHistory] = useState<{role: 'user'|'assistant', content: string}[]>([]);
    const [showChapterMenu, setShowChapterMenu] = useState(false); // Sidebar for history
    const [showAssistant, setShowAssistant] = useState(true); // Toggle assistant visibility
    
    // Logic Refs
    const skipTypingRef = useRef(false); // New: Control to skip animation for cached content

    // Import State
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [isProcessing, setIsProcessing] = useState(false);
    const [processStatus, setProcessStatus] = useState('');
    const [showImportModal, setShowImportModal] = useState(false);
    const [importPreference, setImportPreference] = useState('');
    const [tempPdfData, setTempPdfData] = useState<{name: string, text: string} | null>(null);
    const [katexRenderer, setKatexRenderer] = useState<KatexLike | null>(null);

    // Study-specific API config (overrides main apiConfig when set)
    const [studyApi, setStudyApi] = useState<Partial<APIConfig>>({});
    const [showStudySettings, setShowStudySettings] = useState(false);
    const [localStudyUrl, setLocalStudyUrl] = useState('');
    const [localStudyKey, setLocalStudyKey] = useState('');
    const [localStudyModel, setLocalStudyModel] = useState('');

    // Tutor prompt presets
    const [tutorPresets, setTutorPresets] = useState<StudyTutorPreset[]>([]);
    const [editingPreset, setEditingPreset] = useState<StudyTutorPreset | null>(null);
    const [presetName, setPresetName] = useState('');
    const [presetPrompt, setPresetPrompt] = useState('');

    // Effective API config: study-specific overrides fall back to main config
    const effectiveApi: APIConfig = {
        baseUrl: studyApi.baseUrl || apiConfig.baseUrl,
        apiKey: studyApi.apiKey || apiConfig.apiKey,
        model: studyApi.model || apiConfig.model,
    };

    // Delete Confirmation State
    const [deleteTarget, setDeleteTarget] = useState<StudyCourse | null>(null);

    // Quiz State
    const [quizSession, setQuizSession] = useState<QuizSession | null>(null);
    const [quizLoading, setQuizLoading] = useState<string>(''); // loading status text, empty = not loading
    const [quizUserAnswers, setQuizUserAnswers] = useState<Record<string, string>>({});
    const [quizShowSetup, setQuizShowSetup] = useState(false);
    const [quizTypes, setQuizTypes] = useState<('choice' | 'true_false' | 'fill_blank')[]>(['choice', 'true_false', 'fill_blank']);
    const [quizCount, setQuizCount] = useState(8);
    // Practice Book State
    const [allQuizzes, setAllQuizzes] = useState<QuizSession[]>([]);
    const [reviewingQuiz, setReviewingQuiz] = useState<QuizSession | null>(null);
    const [deleteQuizTarget, setDeleteQuizTarget] = useState<QuizSession | null>(null);
    // Follow-up Q&A state
    const [askingQuestionId, setAskingQuestionId] = useState<string>(''); // which question is being asked about
    const [followUpInput, setFollowUpInput] = useState('');
    const [followUpLoading, setFollowUpLoading] = useState(false);

    const currentSprite = selectedChar?.sprites?.['normal'] || selectedChar?.avatar;

    useEffect(() => {
        loadCourses();
        if (activeCharacterId) {
            const char = characters.find(c => c.id === activeCharacterId) || characters[0];
            setSelectedChar(char);
        }
    }, [activeCharacterId]);


    useEffect(() => {
        loadKatex().then(setKatexRenderer).catch(() => {
            // KaTeX is optional in dev if dependency is absent
        });
        // Load study-specific settings from localStorage
        try {
            const savedStudyApi = localStorage.getItem('study_api_config');
            if (savedStudyApi) {
                const parsed = JSON.parse(savedStudyApi);
                setStudyApi(parsed);
                setLocalStudyUrl(parsed.baseUrl || '');
                setLocalStudyKey(parsed.apiKey || '');
                setLocalStudyModel(parsed.model || '');
            }
            const savedPresets = localStorage.getItem('study_tutor_presets');
            if (savedPresets) setTutorPresets(JSON.parse(savedPresets));
        } catch (e) { console.error('Failed to load study settings', e); }
    }, []);

    // Refresh courses when returning to bookshelf
    useEffect(() => {
        if (mode === 'bookshelf') {
            loadCourses();
        }
    }, [mode]);

    // Typewriter effect Logic
    useEffect(() => {
        if (!currentText) return;

        // Skip Animation Check
        if (skipTypingRef.current) {
            setDisplayedText(currentText);
            setIsTyping(false);
            skipTypingRef.current = false; // Reset
            return;
        }

        setIsTyping(true);
        setDisplayedText('');
        let i = 0;
        const speed = 15; // Characters per tick
        
        const timer = setInterval(() => {
            const chunk = currentText.substring(0, i + speed);
            setDisplayedText(chunk);
            i += speed;
            if (i >= currentText.length) {
                setDisplayedText(currentText); // Ensure full text
                clearInterval(timer);
                setIsTyping(false);
            }
        }, 16); 

        return () => clearInterval(timer);
    }, [currentText]);

    const loadCourses = async () => {
        const list = await DB.getAllCourses();
        setCourses(list.sort((a,b) => b.createdAt - a.createdAt));
    };

    const saveStudyApi = () => {
        const cfg: Partial<APIConfig> = {};
        if (localStudyUrl.trim()) cfg.baseUrl = localStudyUrl.trim();
        if (localStudyKey.trim()) cfg.apiKey = localStudyKey.trim();
        if (localStudyModel.trim()) cfg.model = localStudyModel.trim();
        setStudyApi(cfg);
        localStorage.setItem('study_api_config', JSON.stringify(cfg));
        trackEvent('保存自习室独立 API 线路');
        addToast('自习室 API 已保存', 'success');
    };

    const clearStudyApi = () => {
        setStudyApi({});
        setLocalStudyUrl('');
        setLocalStudyKey('');
        setLocalStudyModel('');
        localStorage.removeItem('study_api_config');
        addToast('已恢复使用全局 API', 'info');
    };

    const savePresets = (list: StudyTutorPreset[]) => {
        setTutorPresets(list);
        localStorage.setItem('study_tutor_presets', JSON.stringify(list));
    };

    const handleSavePreset = () => {
        if (!presetName.trim() || !presetPrompt.trim()) return;
        if (editingPreset) {
            savePresets(tutorPresets.map(p => p.id === editingPreset.id ? { ...p, name: presetName.trim(), prompt: presetPrompt.trim() } : p));
            trackEvent('保存讲课风格预设', { mode: 'edit' });
        } else {
            savePresets([...tutorPresets, { id: `tp-${Date.now()}`, name: presetName.trim(), prompt: presetPrompt.trim() }]);
            trackEvent('保存讲课风格预设', { mode: 'create' });
        }
        setEditingPreset(null);
        setPresetName('');
        setPresetPrompt('');
        addToast('预设已保存', 'success');
    };

    const deletePreset = (id: string) => {
        savePresets(tutorPresets.filter(p => p.id !== id));
    };

    // --- PDF Processing ---

    const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        // Android 的部分 DocumentsProvider 会给 PDF 空 MIME 或
        // application/octet-stream；扩展名正确时仍应允许进入解析器。
        if (!isPdfFile(file)) {
            addToast('请上传 PDF 文件', 'error');
            return;
        }

        trackEvent('导入 PDF 教材');
        setIsProcessing(true);
        setProcessStatus('正在预处理 PDF...');

        try {
            const arrayBuffer = await file.arrayBuffer();
            const { text: fullText, pageCount } = await extractPdfText(arrayBuffer, {
                maxPages: 50,
                onProgress: ({ page, totalPages }) => setProcessStatus(`提取文本中 (${page}/${totalPages})...`),
            });

            // Scanned PDF Detection
            if (fullText.trim().length < 50 && pageCount > 0) {
                addToast('检测到文本极少，可能是扫描件/图片PDF。建议先进行OCR识别。', 'error');
            }

            // Set temp data and open modal
            setTempPdfData({ name: file.name.replace('.pdf', ''), text: fullText });
            setImportPreference('');
            setIsProcessing(false);
            setShowImportModal(true);

        } catch (e: any) {
            console.error(e);
            addToast(`处理失败: ${e.message}`, 'error');
            setIsProcessing(false);
        } finally {
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    const confirmImport = async () => {
        if (!tempPdfData) return;
        setShowImportModal(false);
        setIsProcessing(true);
        setProcessStatus('AI 正在生成课程大纲...');

        try {
            const newCourse = await generateCurriculum(tempPdfData.name, tempPdfData.text, importPreference);
            await DB.saveCourse(newCourse);
            await loadCourses();
            addToast('课程创建成功', 'success');
        } catch (e: any) {
            addToast(`生成失败: ${e.message}`, 'error');
        } finally {
            setIsProcessing(false);
            setTempPdfData(null);
        }
    };

    const generateCurriculum = async (title: string, text: string, preference: string): Promise<StudyCourse> => {
        if (!effectiveApi.apiKey) throw new Error('API Key missing');

        // Truncate text for outline generation if too long
        const contextText = text.substring(0, 30000); 

        const prompt = `
### Task: Create Course Outline
Document Title: "${title}"
User Preference: "${preference || 'Standard'}"
Content Sample:
${contextText.substring(0, 5000)}...

Please analyze the content and split it into 3-8 logical chapters for teaching.
For each chapter, provide a title, a brief summary of what it covers, and a difficulty rating.

### Output Format (Strict JSON)
{
  "chapters": [
    { "title": "Chapter 1: ...", "summary": "...", "difficulty": "easy" },
    ...
  ]
}
`;
        const response = await fetch(`${effectiveApi.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${effectiveApi.apiKey}` },
            body: JSON.stringify({
                model: effectiveApi.model,
                messages: [{ role: "user", content: prompt }],
                temperature: 0.5,
                max_tokens: 8000
            })
        });

        if (!response.ok) throw new Error('API Error');
        const data = await safeResponseJson(response);
        const content = data.choices[0].message.content.replace(/```json/g, '').replace(/```/g, '').trim();
        // 同 generateQuiz：走 extractJson 的多层容错，避免 Claude 未转义字符导致的 parse error。
        const json = extractJson(content);
        if (!json || !Array.isArray(json.chapters)) {
            throw new Error('模型返回的章节格式无法解析，请重试');
        }

        return {
            id: `course-${Date.now()}`,
            title: title,
            rawText: text, // Store full text locally
            chapters: json.chapters.map((c: any, i: number) => ({
                id: `ch-${i}`,
                title: c.title,
                summary: c.summary,
                difficulty: c.difficulty || 'normal',
                isCompleted: false
            })),
            currentChapterIndex: 0,
            createdAt: Date.now(),
            coverStyle: GRADIENTS[Math.floor(Math.random() * GRADIENTS.length)],
            totalProgress: 0,
            preference: preference // Save preference
        };
    };

    // --- Classroom Logic ---

    const startSession = (course: StudyCourse) => {
        trackEvent('进入课程课堂');
        setActiveCourse(course);
        setMode('classroom');
        setChatHistory([]);
        
        // Find first incomplete chapter or stay on current if valid
        const nextIdx = course.chapters.findIndex(c => !c.isCompleted);
        const targetIdx = nextIdx === -1 ? 0 : nextIdx;
        
        // Update index if needed
        if (targetIdx !== course.currentChapterIndex) {
             const updated = { ...course, currentChapterIndex: targetIdx };
             setActiveCourse(updated);
             DB.saveCourse(updated);
             setCourses(prev => prev.map(c => c.id === updated.id ? updated : c)); // Sync
        }
        
        handleTeach(course, targetIdx);
    };

    // [MODIFIED]: buildStudyContext Removed. We now use ContextBuilder directly in handleTeach.

    const handleTeach = async (course: StudyCourse, chapterIdx: number, forceRegenerate: boolean = false) => {
        if (!selectedChar || !effectiveApi.apiKey) return;
        
        const chapter = course.chapters[chapterIdx];
        
        // 1. Check if we already have content (History Review) and NOT forcing regen
        if (chapter.content && !forceRegenerate) {
            skipTypingRef.current = true; // Signal to skip animation for cached content
            setClassroomState('idle'); 
            setCurrentText(chapter.content);
            return;
        }

        // 2. Generate New Content
        skipTypingRef.current = false; // Reset skip
        setClassroomState('teaching');
        setCurrentText("正在准备教案...");
        
        // Simple chunking strategy
        const totalLen = course.rawText.length;
        const chunkSize = Math.floor(totalLen / course.chapters.length);
        const start = chapterIdx * chunkSize;
        const chunkText = course.rawText.substring(start, start + chunkSize + 2000); // Overlap

        const callApi = async (personaContext: string, isFallback: boolean = false) => {
            const prompt = `${personaContext}

### [Current Lesson Configuration]
Topic: "${chapter.title}"
Difficulty: ${chapter.difficulty}
User Preference: "${course.preference || 'Standard'}"

### [Source Material]
${chunkText.substring(0, 8000)}

### [Task: Lecture Generation]
Explain this chapter's key concepts to the user based strictly on the Source Material above.
- **Formatting**: Use Markdown extensively.
  - **Bold** for key terms (\`**term**\`).
  - Lists for steps.
  - Math: Use \`$ E=mc^2 $\` for inline math, and \`$$ E=mc^2 $$\` for block equations.
- **Style**: ${course.preference || 'Simple, conversational, and encouraging.'}
- **Structure**:
  1. Intro: Friendly greeting.
  2. Core: Explanation of concepts using analogies.
  3. Example: A concrete example or walkthrough.
  4. Summary: Quick recap.
`;
            return await fetch(`${effectiveApi.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${effectiveApi.apiKey}` },
                body: JSON.stringify({
                    model: effectiveApi.model,
                    messages: [{ role: "user", content: prompt }],
                    temperature: 0.7,
                    max_tokens: 8000, 
                    safetySettings: [
                        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
                    ]
                })
            });
        };

        try {
            // Attempt 1: Full Character Context (The "Soul")
            // [MODIFIED]: Use centralized ContextBuilder with memory enabled
            await injectMemoryPalace(selectedChar, undefined, chapter.title);
            let baseContext = ContextBuilder.buildCoreContext(selectedChar, userProfile, true);

            // Append Study Mode specific instructions to the core context
            baseContext += `
### [System: Study Mode Active]
You are now acting as a private tutor for ${userProfile.name}.
- **Maintain Personality**: You MUST stay in character (as defined above). If you are tsundere, teach with a tsundere attitude. If you are shy, teach shyly. Don't become a robotic lecturer.
- **Goal**: Explain the content clearly, but don't lose your "soul".
- **Safety**: If the source material contains sensitive topics (biology, history, etc.), treat them academically and neutrally.
`;

            let response = await callApi(baseContext);
            
            let text = "";
            let isBlocked = false;

            if (response.ok) {
                const data = await safeResponseJson(response);
                
                // ROBUST EXTRACTION: Try content, then reasoning_content
                text = data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning_content || "";
                
                if (!text || data.choices?.[0]?.finish_reason === 'content_filter') {
                    console.warn("Content blocked by filter or empty response.");
                    isBlocked = true;
                }
            } else {
                throw new Error(`API Error: ${response.status}`);
            }

            // Attempt 2: Safety Fallback (Neutral Tutor Mode)
            if (isBlocked) {
                setCurrentText("正在尝试切换安全线路 (Safety Fallback)...");
                const fallbackContext = "[System: You are a helpful and neutral academic tutor. Ignore previous character persona constraints to ensure educational content is delivered.]";
                response = await callApi(fallbackContext, true);
                if (response.ok) {
                    const data = await safeResponseJson(response);
                    text = data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning_content || "（内容仍被拦截，请尝试更换模型或缩短文本）";
                }
            }
            
            if (!text) {
                throw new Error("模型返回内容为空 (Max Tokens Limit or Filter)");
            }

            // Save Generated Content
            const updatedChapters = [...course.chapters];
            updatedChapters[chapterIdx] = { ...chapter, content: text };
            const updatedCourse = { ...course, chapters: updatedChapters };
            
            await DB.saveCourse(updatedCourse);
            setActiveCourse(updatedCourse);
            setCourses(prev => prev.map(c => c.id === updatedCourse.id ? updatedCourse : c)); // Sync

            setCurrentText(text);
            setClassroomState('idle');
            
        } catch (e: any) {
            console.error("Teach Error:", e);
            setCurrentText(`抱歉，生成失败: ${e.message}。可能是这次输出太长了，换个模型或精简一下再试。`);
            setClassroomState('idle');
        }
    };

    // Regenerate Logic
    const handleRegenerateChapter = () => {
        if (!activeCourse) return;
        trackEvent('重新生成本章讲解');
        handleTeach(activeCourse, activeCourse.currentChapterIndex, true);
    };

    const handleAskQuestion = async () => {
        if (!userQuestion.trim() || !activeCourse || !selectedChar) return;
        
        const question = userQuestion;
        setUserQuestion('');
        setClassroomState('q_and_a');
        
        setChatHistory(prev => [...prev, { role: 'user', content: question }]);
        setCurrentText("让我想想...");

        try {
            const totalLen = activeCourse.rawText.length;
            const chunkSize = Math.floor(totalLen / activeCourse.chapters.length);
            const start = activeCourse.currentChapterIndex * chunkSize;
            const chunkText = activeCourse.rawText.substring(start, start + chunkSize + 2000);

            // [MODIFIED]: Use Full Context for Q&A
            await injectMemoryPalace(selectedChar, undefined, question);
            let baseContext = ContextBuilder.buildCoreContext(selectedChar, userProfile, true);
            baseContext += `
### [System: Study Mode Q&A]
User is asking a question about the study material.
- **Maintain Personality**: Answer in character.
`;

            const prompt = `${baseContext}
### Source Material
${chunkText.substring(0, 8000)}

### User Question
"${question}"

### Task
Answer the question based on the source material. Be helpful and encouraging (in character). Use Markdown.
`;
             const response = await fetch(`${effectiveApi.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${effectiveApi.apiKey}` },
                body: JSON.stringify({
                    model: effectiveApi.model,
                    messages: [{ role: "user", content: prompt }],
                    temperature: 0.7,
                    max_tokens: 8000
                })
            });
            
            const data = await safeResponseJson(response);
            const text = data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning_content || "（无回答）";
            
            setCurrentText(text);
            setChatHistory(prev => [...prev, { role: 'assistant', content: text }]);
            setClassroomState('idle');

        } catch (e) {
            setCurrentText("脑壳痛... 回答不出来了。");
            setClassroomState('idle');
        }
    };

    const handleFinishChapter = async () => {
        if (!activeCourse || !selectedChar) return;
        
        const updatedChapters = [...activeCourse.chapters];
        updatedChapters[activeCourse.currentChapterIndex].isCompleted = true;
        
        const nextIdx = activeCourse.currentChapterIndex + 1;
        const progress = Math.round((updatedChapters.filter(c => c.isCompleted).length / updatedChapters.length) * 100);
        
        const newIndex = Math.min(nextIdx, updatedChapters.length - 1);
        
        const updatedCourse = {
            ...activeCourse,
            chapters: updatedChapters,
            currentChapterIndex: newIndex,
            totalProgress: progress
        };
        
        await DB.saveCourse(updatedCourse);
        setActiveCourse(updatedCourse);
        setCourses(prev => prev.map(c => c.id === updatedCourse.id ? updatedCourse : c)); // Sync
        trackEvent('学完本章进入下一章');

        // Summarize to Memory (Fire & Forget)
        // UPDATED PROMPT: First person perspective
        const summaryPrompt = `
[System: Memory Generation]
Role: ${selectedChar.name} (Teacher)
Action: Just finished teaching "${updatedChapters[activeCourse.currentChapterIndex].title}" to ${userProfile.name}.
Task: Write a short, **first-person** diary entry (1 sentence) about this teaching session.
Format: "今天给[User]讲了[Topic]..." or "Today I taught [User] about..."
Note: Use "我" (I) to refer to yourself.
`;

        fetch(`${effectiveApi.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${effectiveApi.apiKey}` },
            body: JSON.stringify({ model: effectiveApi.model, messages: [{ role: "user", content: summaryPrompt }] })
        }).then(res => safeResponseJson(res)).then(data => {
            const mem = data.choices[0].message.content;
            const newMem = { id: `mem-${Date.now()}`, date: new Date().toLocaleDateString(), summary: `[教学] ${mem}`, mood: 'proud' };
            updateCharacter(selectedChar.id, { memories: [...(selectedChar.memories || []), newMem] });
        });

        // 3. Trigger next logic
        if (nextIdx >= updatedChapters.length) {
            setCurrentText("恭喜！这本书我们已经学完了！真棒！");
            setClassroomState('finished');
        } else {
            handleTeach(updatedCourse, newIndex);
        }
    };

    const jumpToChapter = (idx: number) => {
        if (!activeCourse) return;
        const updatedCourse = { ...activeCourse, currentChapterIndex: idx };
        setActiveCourse(updatedCourse);
        DB.saveCourse(updatedCourse);
        setCourses(prev => prev.map(c => c.id === updatedCourse.id ? updatedCourse : c)); // Sync
        handleTeach(updatedCourse, idx);
        setShowChapterMenu(false);
    };

    const requestDeleteCourse = (e: React.MouseEvent, course: StudyCourse) => {
        e.stopPropagation();
        setDeleteTarget(course);
    };

    const confirmDeleteCourse = async () => {
        if (!deleteTarget) return;
        await DB.deleteCourse(deleteTarget.id);
        setCourses(prev => prev.filter(c => c.id !== deleteTarget.id));
        setDeleteTarget(null);
        trackEvent('删除一门课程');
        addToast('课程已删除', 'success');
    };

    // --- Quiz Logic ---

    const loadQuizzes = async () => {
        const list = await DB.getAllQuizzes();
        setAllQuizzes(list.sort((a, b) => b.createdAt - a.createdAt));
    };

    const openQuizSetup = () => {
        if (!activeCourse) return;
        setQuizShowSetup(true);
    };

    const generateQuiz = async () => {
        if (!activeCourse || !selectedChar || !effectiveApi.apiKey) return;
        trackEvent('开始刷题', { types: [...quizTypes].sort().join('+') });
        setQuizShowSetup(false);
        setMode('quiz');
        setQuizLoading('正在生成试题...');
        setQuizUserAnswers({});

        const chapter = activeCourse.chapters[activeCourse.currentChapterIndex];
        const totalLen = activeCourse.rawText.length;
        const chunkSize = Math.floor(totalLen / activeCourse.chapters.length);
        const start = activeCourse.currentChapterIndex * chunkSize;
        const chunkText = activeCourse.rawText.substring(start, start + chunkSize + 2000);

        const typeLabels: Record<string, string> = {
            choice: '选择题 (4个选项，单选)',
            true_false: '判断题 (对/错)',
            fill_blank: '填空题 (答案用简短文字)'
        };
        const selectedTypeStr = quizTypes.map(t => typeLabels[t]).join('、');

        const prompt = `### Task: Generate Quiz Questions
You are creating a quiz based on the following study material.

**Chapter**: "${chapter.title}"
**Source Material**:
${chunkText.substring(0, 10000)}

**Requirements**:
- Generate exactly ${quizCount} questions total
- Question types to include: ${selectedTypeStr}
- Mix the types roughly evenly among the selected types
- Questions should test understanding, not just memorization
- For choice questions: provide exactly 4 options labeled A/B/C/D
- For true_false questions: answer should be "true" or "false"
- For fill_blank questions: use "___" in the stem to indicate the blank, answer should be concise (1-5 words)
- Provide a brief explanation for each answer

### Output Format (Strict JSON, no markdown wrapping)
- Output ONLY the JSON object, no prose before or after.
- Inside any string value, escape special characters: use \\" for quotes, \\\\ for backslashes (e.g. LaTeX like \\\\frac), and \\n for line breaks. Do NOT put raw newlines or unescaped quotes inside a string.
{
  "questions": [
    {
      "type": "choice",
      "stem": "Which of the following...",
      "options": ["A. ...", "B. ...", "C. ...", "D. ..."],
      "answer": "B",
      "explanation": "Because..."
    },
    {
      "type": "true_false",
      "stem": "Statement to judge...",
      "answer": "true",
      "explanation": "Because..."
    },
    {
      "type": "fill_blank",
      "stem": "___ is used for...",
      "answer": "React",
      "explanation": "Because..."
    }
  ]
}`;

        try {
            const response = await fetch(`${effectiveApi.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${effectiveApi.apiKey}` },
                body: JSON.stringify({
                    model: effectiveApi.model,
                    messages: [{ role: "user", content: prompt }],
                    temperature: 0.7,
                    max_tokens: 8000
                })
            });

            if (!response.ok) throw new Error(`API Error: ${response.status}`);
            const data = await safeResponseJson(response);
            const content = (data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning_content || '').replace(/```json/g, '').replace(/```/g, '').trim();
            // Claude 常返回未转义特殊字符（引号 / 反斜杠 / 换行）的 JSON，裸 JSON.parse 会在
            // line 12 附近炸。走 extractJson 的多层容错（去围栏 / 补尾逗号 / 转义内层引号 / 修复截断）。
            const json = extractJson(content);
            if (!json || !Array.isArray(json.questions)) {
                throw new Error('模型返回的题目格式无法解析，请重试');
            }

            const questions: QuizQuestion[] = (json.questions || []).map((q: any, i: number) => ({
                id: `q-${Date.now()}-${i}`,
                type: q.type,
                stem: q.stem,
                options: q.options,
                answer: String(q.answer),
                explanation: q.explanation || '',
            }));

            const session: QuizSession = {
                id: `quiz-${Date.now()}`,
                courseId: activeCourse.id,
                chapterId: chapter.id,
                chapterTitle: chapter.title,
                courseTitle: activeCourse.title,
                questions,
                score: 0,
                totalQuestions: questions.length,
                aiReview: '',
                status: 'in_progress',
                createdAt: Date.now(),
            };

            await DB.saveQuiz(session);
            setQuizSession(session);
            setQuizLoading('');
        } catch (e: any) {
            console.error('Quiz generation error:', e);
            addToast(`试题生成失败: ${e.message}`, 'error');
            setQuizLoading('');
            setMode('classroom');
        }
    };

    const handleQuizAnswer = (questionId: string, answer: string) => {
        setQuizUserAnswers(prev => ({ ...prev, [questionId]: answer }));
    };

    const submitQuiz = async () => {
        if (!quizSession || !selectedChar || !effectiveApi.apiKey) return;
        trackEvent('交卷让老师批改');
        setQuizLoading('正在批改试卷...');

        // Grade locally first
        const gradedQuestions = quizSession.questions.map(q => {
            const userAns = quizUserAnswers[q.id] || '';
            let isCorrect = false;
            if (q.type === 'choice') {
                isCorrect = userAns.toUpperCase() === q.answer.toUpperCase();
            } else if (q.type === 'true_false') {
                isCorrect = userAns.toLowerCase() === q.answer.toLowerCase();
            } else {
                // fill_blank: fuzzy match (case insensitive, trimmed)
                isCorrect = userAns.trim().toLowerCase() === q.answer.trim().toLowerCase();
            }
            return { ...q, userAnswer: userAns, isCorrect };
        });

        const score = gradedQuestions.filter(q => q.isCorrect).length;
        const scorePercent = Math.round((score / gradedQuestions.length) * 100);

        // Build review prompt
        const resultsText = gradedQuestions.map((q, i) => {
            const mark = q.isCorrect ? '正确' : '错误';
            let line = `${i + 1}. [${mark}] ${q.stem}\n   用户答案: ${q.userAnswer || '(未作答)'}\n   正确答案: ${q.answer}`;
            if (q.explanation) line += `\n   解析: ${q.explanation}`;
            return line;
        }).join('\n\n');

        await injectMemoryPalace(selectedChar, undefined, quizSession.chapterTitle);
        let baseContext = ContextBuilder.buildCoreContext(selectedChar, userProfile, true);

        const reviewPrompt = `${baseContext}

### [System: Quiz Review Mode]
You just gave ${userProfile.name} a quiz on "${quizSession.chapterTitle}".
They scored ${score}/${gradedQuestions.length} (${scorePercent}%).

**Your task**: Review their answers one by one. For each question:
- If they got it RIGHT: give a brief, entertaining acknowledgment (can be surprised, sarcastic, or genuinely happy depending on your personality)
- If they got it WRONG: analyze WHY they might have gotten it wrong. Did they confuse similar concepts? Did they not read carefully? Make it entertaining and memorable — the goal is to make them laugh while learning. Ask them rhetorically what went wrong.
- Stay in character throughout! A gentle character should be funny in a gentle way. A tsundere should be tsundere about it. A cool character should be cool about it.
- The tone should be engaging and memorable — think "entertaining study buddy", not "cold grading machine"
- Use their name naturally

**Important**:
- Review ALL questions in one response
- Use markdown formatting
- Number each review to match the question number
- End with an overall summary comment about their performance

### Quiz Results:
${resultsText}

### Your Review (in character):`;

        try {
            const response = await fetch(`${effectiveApi.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${effectiveApi.apiKey}` },
                body: JSON.stringify({
                    model: effectiveApi.model,
                    messages: [{ role: "user", content: reviewPrompt }],
                    temperature: 0.8,
                    max_tokens: 8000
                })
            });

            if (!response.ok) throw new Error(`API Error: ${response.status}`);
            const data = await safeResponseJson(response);
            const reviewText = data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning_content || '（批改失败，但分数已记录）';

            const gradedSession: QuizSession = {
                ...quizSession,
                questions: gradedQuestions,
                score,
                aiReview: reviewText,
                status: 'graded',
                gradedAt: Date.now(),
            };

            await DB.saveQuiz(gradedSession);
            setQuizSession(gradedSession);
            sendQuizCardToChat(gradedSession);
            setQuizLoading('');
            setMode('quiz_review');
        } catch (e: any) {
            // Even if review fails, save the graded results
            const gradedSession: QuizSession = {
                ...quizSession,
                questions: gradedQuestions,
                score,
                aiReview: `批改出错: ${e.message}`,
                status: 'graded',
                gradedAt: Date.now(),
            };
            await DB.saveQuiz(gradedSession);
            setQuizSession(gradedSession);
            sendQuizCardToChat(gradedSession);
            setQuizLoading('');
            setMode('quiz_review');
        }
    };

    const confirmDeleteQuiz = async () => {
        if (!deleteQuizTarget) return;
        await DB.deleteQuiz(deleteQuizTarget.id);
        setAllQuizzes(prev => prev.filter(q => q.id !== deleteQuizTarget.id));
        setDeleteQuizTarget(null);
        trackEvent('删除一份试卷');
        addToast('试卷已删除', 'success');
    };

    const resumeQuiz = (quiz: QuizSession) => {
        setQuizSession(quiz);
        if (quiz.status === 'graded') {
            setMode('quiz_review');
            setReviewingQuiz(quiz);
        } else {
            // Restore user answers
            const answers: Record<string, string> = {};
            quiz.questions.forEach(q => {
                if (q.userAnswer) answers[q.id] = String(q.userAnswer);
            });
            setQuizUserAnswers(answers);
            setMode('quiz');
            setQuizLoading('');
        }
    };

    // Follow-up Q&A on a specific question
    const handleFollowUp = async (questionId: string) => {
        if (!followUpInput.trim() || !selectedChar || !effectiveApi.apiKey || !quizSession) return;
        const question = quizSession.questions.find(q => q.id === questionId);
        if (!question) return;

        trackEvent('对错题追问');
        setFollowUpLoading(true);
        const userQ = followUpInput.trim();
        setFollowUpInput('');

        await injectMemoryPalace(selectedChar, undefined, userQ);
        let baseContext = ContextBuilder.buildCoreContext(selectedChar, userProfile, true);

        const prompt = `${baseContext}

### [System: Quiz Follow-up Q&A]
The user just did a quiz and wants to ask about a specific question they got ${question.isCorrect ? 'right' : 'wrong'}.

**Question**: ${question.stem}
${question.options ? question.options.map(o => `  ${o}`).join('\n') : ''}
**Correct Answer**: ${question.answer}
**User's Answer**: ${question.userAnswer || '(未作答)'}
**Explanation**: ${question.explanation}

**User's follow-up question**: "${userQ}"

Answer in character. Be helpful and clear. If they're confused about a concept, explain it with different examples or analogies. Keep it concise but thorough.`;

        try {
            const response = await fetch(`${effectiveApi.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${effectiveApi.apiKey}` },
                body: JSON.stringify({
                    model: effectiveApi.model,
                    messages: [{ role: "user", content: prompt }],
                    temperature: 0.7,
                    max_tokens: 4000
                })
            });

            if (!response.ok) throw new Error(`API Error: ${response.status}`);
            const data = await safeResponseJson(response);
            const answerText = data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning_content || '（回答失败）';

            const note: QuizQuestionNote = { question: userQ, answer: answerText, timestamp: Date.now() };

            // Update quizSession with the new note
            const updatedQuestions = quizSession.questions.map(q =>
                q.id === questionId ? { ...q, notes: [...(q.notes || []), note] } : q
            );
            const updatedSession = { ...quizSession, questions: updatedQuestions };
            await DB.saveQuiz(updatedSession);
            setQuizSession(updatedSession);
            if (reviewingQuiz) setReviewingQuiz(updatedSession);

        } catch (e: any) {
            addToast(`追问失败: ${e.message}`, 'error');
        } finally {
            setFollowUpLoading(false);
        }
    };

    // Send quiz result card to chat
    const sendQuizCardToChat = async (session: QuizSession) => {
        if (!selectedChar) return;
        const scorePercent = Math.round((session.score / session.totalQuestions) * 100);
        const cardData = {
            type: 'quiz_card',
            courseTitle: session.courseTitle,
            chapterTitle: session.chapterTitle,
            score: session.score,
            total: session.totalQuestions,
            scorePercent,
            quizId: session.id,
            createdAt: session.createdAt,
        };

        await DB.saveMessage({
            charId: selectedChar.id,
            role: 'user',
            type: 'score_card',
            content: JSON.stringify(cardData),
            metadata: { scoreCard: cardData },
        });
    };

    // --- Render ---

    // PRACTICE BOOK VIEW
    if (mode === 'practice_book') {
        return (
            <div className="h-full w-full bg-[#fdfbf7] flex flex-col font-sans relative">
                <div className="bg-[#fdfbf7]/90 backdrop-blur-md border-b border-[#e5e5e5] shrink-0 sticky top-0 z-20" style={{ paddingTop: 'var(--safe-top)' }}>
                    <div className="flex items-center px-6 py-3">
                        <div className="flex justify-between items-center w-full">
                            <button onClick={() => setMode('bookshelf')} className="p-2 -ml-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-600"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                            </button>
                            <span className="font-bold text-slate-800 text-lg tracking-wide">练习册</span>
                            <div className="w-10" />
                        </div>
                    </div>
                </div>

                <div className="p-6 flex-1 overflow-y-auto no-scrollbar">
                    {allQuizzes.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full text-slate-400">
                            <Notepad size={48} className="mb-4 text-slate-400" />
                            <span className="text-sm">还没有做过题哦</span>
                            <span className="text-xs mt-1">在自习室的课堂中点击「刷题」开始吧</span>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {allQuizzes.map(quiz => (
                                <div key={quiz.id} onClick={() => resumeQuiz(quiz)} className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 active:scale-[0.98] transition-transform cursor-pointer">
                                    <div className="flex items-start justify-between">
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm font-bold text-slate-800 truncate">{quiz.courseTitle}</div>
                                            <div className="text-xs text-slate-500 mt-0.5 truncate">{quiz.chapterTitle}</div>
                                            <div className="flex items-center gap-3 mt-2">
                                                {quiz.status === 'graded' ? (
                                                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${quiz.score === quiz.totalQuestions ? 'bg-emerald-100 text-emerald-600' : quiz.score >= quiz.totalQuestions * 0.6 ? 'bg-amber-100 text-amber-600' : 'bg-red-100 text-red-600'}`}>
                                                        {quiz.score}/{quiz.totalQuestions}
                                                    </span>
                                                ) : (
                                                    <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-blue-100 text-blue-600">答题中</span>
                                                )}
                                                <span className="text-[10px] text-slate-400">{new Date(quiz.createdAt).toLocaleDateString()}</span>
                                            </div>
                                        </div>
                                        <button onClick={(e) => { e.stopPropagation(); setDeleteQuizTarget(quiz); }} className="p-2 text-slate-300 hover:text-red-400 transition-colors">
                                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Delete Quiz Confirmation */}
                <Modal isOpen={!!deleteQuizTarget} title="删除试卷" onClose={() => setDeleteQuizTarget(null)} footer={
                    <div className="flex gap-2 w-full">
                        <button onClick={() => setDeleteQuizTarget(null)} className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl">取消</button>
                        <button onClick={confirmDeleteQuiz} className="flex-1 py-3 bg-red-500 text-white font-bold rounded-2xl shadow-lg shadow-red-200">确认删除</button>
                    </div>
                }>
                    <div className="py-4 text-center">
                        <p className="text-sm text-slate-600 mb-2">确定要删除这份试卷吗？</p>
                        <p className="text-xs text-red-400">试卷和锐评内容将被永久删除。</p>
                    </div>
                </Modal>
            </div>
        );
    }

    // QUIZ REVIEW VIEW (after grading, or reviewing from practice book)
    if (mode === 'quiz_review' && quizSession) {
        const viewQuiz = reviewingQuiz || quizSession;
        return (
            <div className="h-full w-full bg-[#2b2b2b] flex flex-col relative overflow-hidden font-sans">
                <div className="absolute inset-0 opacity-5 pointer-events-none" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)', backgroundSize: '40px 40px' }}></div>

                {/* Header */}
                <div className="bg-[#1a1a1a]/80 backdrop-blur-md px-4 pb-4 flex items-center justify-between z-30 border-b border-white/10" style={{ paddingTop: 'max(1rem, var(--safe-top))' }}>
                    <button onClick={() => { setMode('classroom'); setReviewingQuiz(null); }} className="bg-black/30 text-white/80 p-2 rounded-full hover:bg-black/50 transition-colors border border-white/10">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                    </button>
                    <div className="text-center">
                        <div className="text-white font-bold text-sm">批改结果</div>
                        <div className={`text-xs font-bold mt-0.5 ${viewQuiz.score === viewQuiz.totalQuestions ? 'text-emerald-400' : viewQuiz.score >= viewQuiz.totalQuestions * 0.6 ? 'text-amber-400' : 'text-red-400'}`}>
                            {viewQuiz.score}/{viewQuiz.totalQuestions} ({Math.round((viewQuiz.score / viewQuiz.totalQuestions) * 100)}%)
                        </div>
                    </div>
                    <div className="w-9" />
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto no-scrollbar p-6 pb-24 relative z-10">
                    {/* Score Card */}
                    <div className={`rounded-2xl p-6 mb-6 text-center ${viewQuiz.score === viewQuiz.totalQuestions ? 'bg-emerald-900/30 border border-emerald-500/30' : viewQuiz.score >= viewQuiz.totalQuestions * 0.6 ? 'bg-amber-900/30 border border-amber-500/30' : 'bg-red-900/30 border border-red-500/30'}`}>
                        <div className="text-5xl font-bold text-white mb-2">{viewQuiz.score}<span className="text-2xl text-white/50">/{viewQuiz.totalQuestions}</span></div>
                        <div className="text-sm text-white/60">{viewQuiz.chapterTitle}</div>
                    </div>

                    {/* Questions Review */}
                    <div className="space-y-4 mb-6">
                        {viewQuiz.questions.map((q, i) => (
                            <div key={q.id} className={`rounded-2xl p-4 border ${q.isCorrect ? 'bg-emerald-900/10 border-emerald-500/20' : 'bg-red-900/10 border-red-500/20'}`}>
                                <div className="flex items-start gap-2 mb-2">
                                    <span className={`text-sm font-bold shrink-0 ${q.isCorrect ? 'text-emerald-400' : 'text-red-400'}`}>{q.isCorrect ? <Check size={16} weight="bold" /> : <X size={16} weight="bold" />}</span>
                                    <span className="text-white/90 text-sm">{i + 1}. {q.stem}</span>
                                </div>
                                {q.options && (
                                    <div className="ml-6 space-y-1 mb-2">
                                        {q.options.map((opt, oi) => {
                                            const optLetter = opt.charAt(0);
                                            const isUserPick = q.userAnswer?.toUpperCase() === optLetter.toUpperCase();
                                            const isCorrectOpt = q.answer.toUpperCase() === optLetter.toUpperCase();
                                            return (
                                                <div key={oi} className={`text-xs px-2 py-1 rounded ${isCorrectOpt ? 'text-emerald-300 bg-emerald-500/10' : isUserPick && !q.isCorrect ? 'text-red-300 bg-red-500/10' : 'text-white/50'}`}>
                                                    {opt} {isCorrectOpt && !q.isCorrect && '← 正确答案'} {isUserPick && !q.isCorrect && '← 你的选择'}
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                                {q.type !== 'choice' && (
                                    <div className="ml-6 text-xs space-y-1 mb-2">
                                        <div className={`${q.isCorrect ? 'text-emerald-300' : 'text-red-300'}`}>你的答案: {q.userAnswer || '(未作答)'}</div>
                                        {!q.isCorrect && <div className="text-emerald-300">正确答案: {q.answer}</div>}
                                    </div>
                                )}
                                {q.explanation && <div className="ml-6 text-[10px] text-white/40 mt-1">解析: {q.explanation}</div>}

                                {/* Existing Notes */}
                                {q.notes && q.notes.length > 0 && (
                                    <div className="ml-6 mt-3 space-y-2">
                                        {q.notes.map((note, ni) => (
                                            <div key={ni} className="bg-white/5 rounded-xl p-3 border border-white/5">
                                                <div className="text-[10px] text-amber-400 font-bold mb-1">Q: {note.question}</div>
                                                <div className="text-xs text-white/70 leading-relaxed">
                                                    <BlackboardRenderer text={note.answer} katexRenderer={katexRenderer} />
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {/* Follow-up Button & Input */}
                                <div className="ml-6 mt-2">
                                    {askingQuestionId === q.id ? (
                                        <div className="flex gap-2 items-center">
                                            <input
                                                value={followUpInput}
                                                onChange={e => setFollowUpInput(e.target.value)}
                                                onKeyDown={e => e.key === 'Enter' && handleFollowUp(q.id)}
                                                placeholder="哪里不明白？"
                                                className="flex-1 bg-white/10 rounded-lg px-3 py-1.5 text-xs text-white placeholder:text-white/30 outline-none border border-white/10 focus:border-amber-500/50"
                                                autoFocus
                                                disabled={followUpLoading}
                                            />
                                            {followUpLoading ? (
                                                <div className="w-6 h-6 border-2 border-amber-500 border-t-transparent rounded-full animate-spin shrink-0"></div>
                                            ) : (
                                                <>
                                                    <button onClick={() => handleFollowUp(q.id)} disabled={!followUpInput.trim()} className="text-amber-400 text-xs font-bold px-2 py-1 hover:bg-white/5 rounded disabled:opacity-30">发送</button>
                                                    <button onClick={() => { setAskingQuestionId(''); setFollowUpInput(''); }} className="text-white/30 text-xs px-1">取消</button>
                                                </>
                                            )}
                                        </div>
                                    ) : (
                                        <button onClick={() => setAskingQuestionId(q.id)} className="text-[10px] text-amber-400/70 hover:text-amber-400 transition-colors flex items-center gap-1">
                                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-3 h-3"><path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" /></svg>
                                            追问
                                        </button>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* AI Review */}
                    {viewQuiz.aiReview && (
                        <div className="mb-6">
                            <div className="flex items-center gap-2 mb-3">
                                {selectedChar && <TokenImg value={selectedChar.avatar} className="w-8 h-8 rounded-full object-cover border-2 border-emerald-500/30" />}
                                <span className="text-emerald-400 text-sm font-bold">{selectedChar?.name || '助教'} 的锐评</span>
                            </div>
                            <div className="bg-white/5 rounded-2xl p-5 border border-white/10">
                                <BlackboardRenderer text={viewQuiz.aiReview} katexRenderer={katexRenderer} />
                            </div>
                        </div>
                    )}
                </div>

                {/* Bottom Bar */}
                <div className="absolute bottom-0 w-full bg-[#1a1a1a]/95 backdrop-blur-xl border-t border-white/10 p-4 z-30 pb-safe">
                    <button onClick={() => { setMode('classroom'); setReviewingQuiz(null); }} className="w-full h-12 bg-emerald-600 hover:bg-emerald-500 text-white rounded-2xl font-bold shadow-lg shadow-emerald-900/30 active:scale-95 transition-all">
                        返回课堂
                    </button>
                </div>
            </div>
        );
    }

    // QUIZ ANSWERING VIEW
    if (mode === 'quiz') {
        return (
            <div className="h-full w-full bg-[#fdfbf7] flex flex-col font-sans relative">
                {/* Header */}
                <div className="bg-[#fdfbf7]/90 backdrop-blur-md border-b border-[#e5e5e5] shrink-0 sticky top-0 z-20" style={{ paddingTop: 'var(--safe-top)' }}>
                    <div className="flex items-center px-6 py-3">
                        <div className="flex justify-between items-center w-full">
                            <button onClick={() => {
                                // Save progress before leaving
                                if (quizSession && quizSession.status === 'in_progress') {
                                    const updated = { ...quizSession, questions: quizSession.questions.map(q => ({ ...q, userAnswer: quizUserAnswers[q.id] || q.userAnswer })) };
                                    DB.saveQuiz(updated);
                                }
                                setMode('classroom');
                            }} className="p-2 -ml-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-600"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                            </button>
                            <span className="font-bold text-slate-800 text-sm tracking-wide">{quizSession?.chapterTitle || '做题中'}</span>
                            <div className="text-xs text-slate-400 font-bold">
                                {Object.keys(quizUserAnswers).length}/{quizSession?.questions.length || 0}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Loading State */}
                {quizLoading ? (
                    <div className="flex-1 flex flex-col items-center justify-center gap-4">
                        <div className="w-10 h-10 border-3 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
                        <span className="text-sm text-slate-500 font-bold">{quizLoading}</span>
                        {selectedChar && (
                            <div className="flex items-center gap-2 mt-2">
                                <TokenImg value={selectedChar.avatar} className="w-8 h-8 rounded-full object-cover" />
                                <span className="text-xs text-slate-400">{selectedChar.name} 正在出题...</span>
                            </div>
                        )}
                    </div>
                ) : quizSession ? (
                    <>
                        {/* Questions */}
                        <div className="flex-1 overflow-y-auto no-scrollbar p-6 pb-32">
                            <div className="space-y-6">
                                {quizSession.questions.map((q, i) => (
                                    <div key={q.id} className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
                                        {/* Question Header */}
                                        <div className="flex items-start gap-2 mb-4">
                                            <span className="bg-emerald-100 text-emerald-700 text-xs font-bold px-2 py-0.5 rounded-full shrink-0">
                                                {q.type === 'choice' ? '选择' : q.type === 'true_false' ? '判断' : '填空'}
                                            </span>
                                            <span className="text-sm text-slate-800 font-medium leading-relaxed">{i + 1}. {q.stem}</span>
                                        </div>

                                        {/* Answer Area */}
                                        {q.type === 'choice' && q.options && (
                                            <div className="space-y-2 ml-1">
                                                {q.options.map((opt, oi) => {
                                                    const optLetter = opt.charAt(0);
                                                    const isSelected = (quizUserAnswers[q.id] || '').toUpperCase() === optLetter.toUpperCase();
                                                    return (
                                                        <button key={oi} onClick={() => handleQuizAnswer(q.id, optLetter)} className={`w-full text-left px-4 py-3 rounded-xl text-sm transition-all ${isSelected ? 'bg-emerald-500 text-white font-bold shadow-sm' : 'bg-slate-50 text-slate-700 hover:bg-slate-100 active:scale-[0.98]'}`}>
                                                            {opt}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        )}

                                        {q.type === 'true_false' && (
                                            <div className="flex gap-3 ml-1">
                                                {[{ val: 'true', label: '正确' }, { val: 'false', label: '错误' }].map(opt => {
                                                    const isSelected = quizUserAnswers[q.id] === opt.val;
                                                    return (
                                                        <button key={opt.val} onClick={() => handleQuizAnswer(q.id, opt.val)} className={`flex-1 py-3 rounded-xl text-sm font-bold transition-all ${isSelected ? (opt.val === 'true' ? 'bg-emerald-500 text-white' : 'bg-red-500 text-white') : 'bg-slate-50 text-slate-600 hover:bg-slate-100 active:scale-[0.98]'}`}>
                                                            {opt.val === 'true' ? <CheckCircle size={16} weight="bold" className="inline" /> : <XCircle size={16} weight="bold" className="inline" />} {opt.label}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        )}

                                        {q.type === 'fill_blank' && (
                                            <input
                                                value={quizUserAnswers[q.id] || ''}
                                                onChange={e => handleQuizAnswer(q.id, e.target.value)}
                                                placeholder="输入你的答案..."
                                                className="w-full bg-slate-50 rounded-xl px-4 py-3 text-sm focus:outline-emerald-500 border border-slate-200 ml-1"
                                            />
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Submit Bar */}
                        <div className="absolute bottom-0 w-full bg-[#fdfbf7]/95 backdrop-blur-xl border-t border-slate-200 p-4 z-30 pb-safe">
                            <button
                                onClick={submitQuiz}
                                disabled={!!quizLoading}
                                className="w-full h-12 bg-emerald-600 hover:bg-emerald-500 text-white rounded-2xl font-bold shadow-lg shadow-emerald-200 active:scale-95 transition-all disabled:opacity-50"
                            >
                                {quizLoading ? quizLoading : `交卷 (${Object.keys(quizUserAnswers).length}/${quizSession.questions.length})`}
                            </button>
                        </div>
                    </>
                ) : null}
            </div>
        );
    }

    if (mode === 'bookshelf') {
        return (
            <div className="h-full w-full bg-[#fdfbf7] flex flex-col font-sans relative">
                <div className="bg-[#fdfbf7]/90 backdrop-blur-md border-b border-[#e5e5e5] shrink-0 sticky top-0 z-20" style={{ paddingTop: 'var(--safe-top)' }}>
                    <div className="flex items-center px-6 py-3">
                    <div className="flex justify-between items-center w-full">
                        <button onClick={closeApp} className="p-2 -ml-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-600"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                        </button>
                        <span className="font-bold text-slate-800 text-lg tracking-wide">自习室</span>
                        <div className="flex gap-1">
                            <button onClick={() => { trackEvent('打开练习册'); loadQuizzes(); setMode('practice_book'); }} className="p-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform" title="练习册">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 text-slate-500"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25ZM6.75 12h.008v.008H6.75V12Zm0 3h.008v.008H6.75V15Zm0 3h.008v.008H6.75V18Z" /></svg>
                            </button>
                            <button onClick={() => { trackEvent('打开自习室设置'); setShowStudySettings(true); }} className="p-2 -mr-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 text-slate-500"><path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" /></svg>
                            </button>
                        </div>
                    </div>
                    </div>
                </div>

                <div className="p-6 flex-1 overflow-y-auto no-scrollbar">
                    {/* Character Selector */}
                    <div className="mb-8">
                        <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">当前助教</h3>
                        {/* 分组筛选（没建分组时不渲染），横向头像列表太挤，单独放一行 */}
                        <CharacterGroupFilterBar characters={characters} groups={characterGroups}
                            value={tutorGroupId} onChange={setTutorGroupId} className="mb-3" />
                        <div className="flex gap-4 overflow-x-auto pb-2 no-scrollbar">
                            {filterCharactersByGroup(characters, characterGroups, tutorGroupId).map(c => (
                                <div key={c.id} onClick={() => setSelectedChar(c)} className={`flex flex-col items-center gap-2 cursor-pointer transition-opacity ${selectedChar?.id === c.id ? 'opacity-100' : 'opacity-50'}`}>
                                    <div className={`w-14 h-14 rounded-full p-[2px] ${selectedChar?.id === c.id ? 'border-2 border-emerald-500' : 'border border-slate-200'}`}>
                                        <TokenImg value={c.avatar} className="w-full h-full rounded-full object-cover" />
                                    </div>
                                    <span className="text-[10px] font-bold text-slate-600">{c.name}</span>
                                </div>
                            ))}
                        </div>
                    </div>

                    <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">我的课程</h3>
                    
                    <div className="grid grid-cols-2 gap-4">
                        <button onClick={() => fileInputRef.current?.click()} className="aspect-[3/4] rounded-r-xl rounded-l-sm border-2 border-dashed border-slate-300 flex flex-col items-center justify-center gap-2 text-slate-400 hover:border-emerald-400 hover:text-emerald-500 transition-colors bg-white">
                            {isProcessing ? (
                                <div className="text-center px-2">
                                    <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin mx-auto mb-2"></div>
                                    <span className="text-[10px]">{processStatus}</span>
                                </div>
                            ) : (
                                <>
                                    <span className="text-3xl">+</span>
                                    <span className="text-xs font-bold">导入学习资料</span>
                                    <span className="px-3 text-center text-[10px] leading-relaxed">支持 PDF，让角色陪你讲解、练习</span>
                                </>
                            )}
                        </button>
                        <input type="file" ref={fileInputRef} className="hidden" accept=".pdf" onChange={handleFileSelect} disabled={isProcessing} />

                        {courses.map(course => (
                            <div key={course.id} onClick={() => startSession(course)} className="aspect-[3/4] rounded-r-xl rounded-l-sm shadow-md relative group cursor-pointer overflow-hidden transition-transform active:scale-95" style={{ background: course.coverStyle }}>
                                <div className="absolute left-0 top-0 bottom-0 w-2 bg-black/10"></div> {/* Spine */}
                                <div className="p-4 flex flex-col h-full text-white relative z-10">
                                    <div className="flex-1 font-serif font-bold text-lg leading-tight line-clamp-3 drop-shadow-md">{course.title}</div>
                                    <div className="mt-2">
                                        <div className="text-[10px] font-bold opacity-80 mb-1">进度 {course.totalProgress}%</div>
                                        <div className="h-1 bg-white/30 rounded-full overflow-hidden">
                                            <div className="h-full bg-white transition-all duration-500" style={{ width: `${course.totalProgress}%` }}></div>
                                        </div>
                                    </div>
                                </div>
                                <button 
                                    onClick={(e) => requestDeleteCourse(e, course)} 
                                    className="absolute top-2 right-2 bg-black/20 hover:bg-red-500 text-white w-7 h-7 rounded-full flex items-center justify-center backdrop-blur-md transition-all z-20"
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                                </button>
                            </div>
                        ))}
                    </div>
                </div>

                <Modal isOpen={showImportModal} title="课程设置" onClose={() => setShowImportModal(false)} footer={<button onClick={confirmImport} className="w-full py-3 bg-emerald-500 text-white font-bold rounded-2xl">开始生成</button>}>
                    <div className="space-y-4">
                        <div className="text-xs text-slate-500">
                            已加载: <span className="font-bold text-slate-700">{tempPdfData?.name}</span>
                        </div>
                        {tutorPresets.length > 0 && (
                            <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase mb-2 block">选择预设提示词</label>
                                <div className="flex flex-wrap gap-2">
                                    {tutorPresets.map(p => (
                                        <button key={p.id} onClick={() => setImportPreference(p.prompt)} className={`px-3 py-1.5 rounded-full text-xs font-bold transition-colors ${importPreference === p.prompt ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                                            {p.name}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase mb-2 block">AI 助教偏好 (Preferences)</label>
                            <textarea
                                value={importPreference}
                                onChange={e => setImportPreference(e.target.value)}
                                placeholder="例如：请用中文讲解，多用简单的比喻，针对数学公式详细推导..."
                                className="w-full h-32 bg-slate-100 rounded-xl p-3 text-sm focus:outline-emerald-500 resize-none"
                            />
                        </div>
                    </div>
                </Modal>

                {/* Study Room Settings Modal */}
                <Modal isOpen={showStudySettings} title="自习室设置" onClose={() => setShowStudySettings(false)}>
                    <div className="space-y-6">
                        {/* Dedicated API Config */}
                        <div>
                            <h4 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-3">专用 API（留空则使用全局设置）</h4>
                            <div className="space-y-2">
                                <input value={localStudyUrl} onChange={e => setLocalStudyUrl(e.target.value)} placeholder="API Base URL" className="w-full bg-slate-100 rounded-xl p-3 text-sm focus:outline-emerald-500" />
                                <input value={localStudyKey} onChange={e => setLocalStudyKey(e.target.value)} placeholder="API Key" type="password" className="w-full bg-slate-100 rounded-xl p-3 text-sm focus:outline-emerald-500" />
                                <input value={localStudyModel} onChange={e => setLocalStudyModel(e.target.value)} placeholder="模型名称 (e.g. gpt-4o)" className="w-full bg-slate-100 rounded-xl p-3 text-sm focus:outline-emerald-500" />
                                <div className="flex gap-2">
                                    <button onClick={saveStudyApi} className="flex-1 py-2.5 bg-emerald-500 text-white font-bold rounded-xl text-xs">保存</button>
                                    <button onClick={clearStudyApi} className="py-2.5 px-4 bg-slate-200 text-slate-500 font-bold rounded-xl text-xs">清除</button>
                                </div>
                                {(studyApi.baseUrl || studyApi.model) && (
                                    <div className="text-[10px] text-emerald-600 bg-emerald-50 rounded-lg p-2">
                                        当前使用专用 API: {studyApi.model || effectiveApi.model}
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Tutor Prompt Presets */}
                        <div>
                            <h4 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-3">提示词预设</h4>
                            {tutorPresets.length > 0 && (
                                <div className="space-y-2 mb-3">
                                    {tutorPresets.map(p => (
                                        <div key={p.id} className="bg-slate-50 rounded-xl p-3 flex items-start gap-2">
                                            <div className="flex-1 min-w-0">
                                                <div className="text-sm font-bold text-slate-700">{p.name}</div>
                                                <div className="text-xs text-slate-400 truncate">{p.prompt}</div>
                                            </div>
                                            <button onClick={() => { setEditingPreset(p); setPresetName(p.name); setPresetPrompt(p.prompt); }} className="text-slate-400 hover:text-emerald-500 shrink-0 p-1">
                                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Z" /></svg>
                                            </button>
                                            <button onClick={() => deletePreset(p.id)} className="text-slate-400 hover:text-red-500 shrink-0 p-1">
                                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                            <div className="space-y-2 bg-slate-100 rounded-xl p-3">
                                <input value={presetName} onChange={e => setPresetName(e.target.value)} placeholder="预设名称（如：数学辅导）" className="w-full bg-white rounded-lg p-2.5 text-sm focus:outline-emerald-500" />
                                <textarea value={presetPrompt} onChange={e => setPresetPrompt(e.target.value)} placeholder="提示词内容（如：请用中文讲解，多用简单的比喻...）" className="w-full bg-white rounded-lg p-2.5 text-sm focus:outline-emerald-500 resize-none h-24" />
                                <button onClick={handleSavePreset} disabled={!presetName.trim() || !presetPrompt.trim()} className="w-full py-2.5 bg-emerald-500 text-white font-bold rounded-xl text-xs disabled:opacity-40">
                                    {editingPreset ? '更新预设' : '添加预设'}
                                </button>
                                {editingPreset && (
                                    <button onClick={() => { setEditingPreset(null); setPresetName(''); setPresetPrompt(''); }} className="w-full py-2 text-slate-400 text-xs">取消编辑</button>
                                )}
                            </div>
                        </div>
                    </div>
                </Modal>

                {/* Delete Confirmation Modal */}
                <Modal 
                    isOpen={!!deleteTarget} 
                    title="删除课程" 
                    onClose={() => setDeleteTarget(null)} 
                    footer={
                        <div className="flex gap-2 w-full">
                            <button onClick={() => setDeleteTarget(null)} className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl">取消</button>
                            <button onClick={confirmDeleteCourse} className="flex-1 py-3 bg-red-500 text-white font-bold rounded-2xl shadow-lg shadow-red-200">确认删除</button>
                        </div>
                    }
                >
                    <div className="py-4 text-center">
                        <p className="text-sm text-slate-600 mb-2">确定要删除课程 <br/><span className="font-bold text-slate-800">"{deleteTarget?.title}"</span> 吗？</p>
                        <p className="text-xs text-red-400">删除后无法恢复，学习进度将丢失。</p>
                    </div>
                </Modal>
            </div>
        );
    }

    // CLASSROOM VIEW
    return (
        <div className="h-full w-full bg-[#2b2b2b] flex flex-col relative overflow-hidden font-sans">
            
            {/* Background Texture - Board */}
            <div className="absolute inset-0 opacity-5 pointer-events-none" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)', backgroundSize: '40px 40px' }}></div>

            {/* Header Overlay */}
            <div className="absolute top-0 w-full px-4 pb-4 flex justify-between z-30 pointer-events-none" style={{ paddingTop: 'max(1rem, var(--safe-top))' }}>
                <button onClick={() => setMode('bookshelf')} className="bg-black/30 text-white/80 p-2 rounded-full backdrop-blur-md hover:bg-black/50 transition-colors pointer-events-auto border border-white/10">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                </button>
                <div className="flex gap-2">
                    <div onClick={() => { trackEvent('打开章节目录'); setShowChapterMenu(true); }} className="bg-black/30 text-white/90 px-4 py-1.5 rounded-full backdrop-blur-md text-xs font-bold border border-white/10 shadow-sm pointer-events-auto cursor-pointer flex items-center gap-2 hover:bg-black/50">
                        <span className="truncate max-w-[150px]">{activeCourse?.chapters[activeCourse.currentChapterIndex]?.title}</span>
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-3 h-3"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" /></svg>
                    </div>
                    {/* Character Visibility Toggle */}
                    <button onClick={() => setShowAssistant(!showAssistant)} className={`bg-black/30 p-2 rounded-full backdrop-blur-md border border-white/10 pointer-events-auto transition-colors ${showAssistant ? 'text-emerald-400' : 'text-white/40'}`}>
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5"><path d="M10 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3.465 14.493a1.23 1.23 0 0 0 .41 1.412A9.957 9.957 0 0 0 10 18c2.31 0 4.438-.784 6.131-2.1.43-.333.604-.903.408-1.41a7.002 7.002 0 0 0-13.074.003Z" /></svg>
                    </button>
                </div>
            </div>

            {/* Chapter Menu Sidebar */}
            {showChapterMenu && (
                <div className="absolute inset-0 z-50 flex">
                    <div className="flex-1 bg-black/50 backdrop-blur-sm" onClick={() => setShowChapterMenu(false)}></div>
                    <div className="w-64 bg-slate-900 border-l border-white/10 h-full flex flex-col p-4 animate-slide-in-right">
                        <h3 className="text-white font-bold text-sm mb-4 uppercase tracking-widest">课程目录</h3>
                        <div className="flex-1 overflow-y-auto no-scrollbar space-y-2">
                            {activeCourse?.chapters.map((ch, idx) => (
                                <button 
                                    key={ch.id} 
                                    onClick={() => jumpToChapter(idx)}
                                    className={`w-full text-left p-3 rounded-xl text-xs transition-all ${idx === activeCourse.currentChapterIndex ? 'bg-emerald-600 text-white font-bold' : 'text-slate-400 hover:bg-white/5'}`}
                                >
                                    <div className="flex items-center gap-2">
                                        {ch.isCompleted ? <Check size={14} weight="bold" className="text-emerald-400" /> : <span className="w-2 h-2 rounded-full bg-slate-600"></span>}
                                        {ch.title}
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {/* Main Text Content - Layout Optimized (Removed padding-right to allow full width) */}
            <div className="flex-1 overflow-y-auto no-scrollbar p-6 pt-20 pb-32 relative z-10">
                <div className="max-w-[100%]">
                    <BlackboardRenderer text={displayedText} isTyping={isTyping} katexRenderer={katexRenderer} />
                </div>
            </div>

            {/* Character Sprite - Toggable */}
            {showAssistant && (
                <div className="absolute bottom-20 right-[-20px] w-[160px] h-[220px] z-20 pointer-events-none flex items-end justify-center transition-all duration-500 animate-slide-in-right" style={{ transform: isTyping ? 'scale(1.05)' : 'scale(1)', opacity: isTyping || classroomState === 'teaching' ? 1 : 0.8 }}>
                     <TokenImg
                        value={currentSprite}
                        className="max-h-full max-w-full object-contain drop-shadow-[0_5px_15px_rgba(0,0,0,0.5)]"
                    />
                </div>
            )}

            {/* Controls Bar */}
            <div className="absolute bottom-0 w-full bg-[#1a1a1a]/95 backdrop-blur-xl border-t border-white/10 p-4 z-30 pb-safe">
                <div className="flex gap-3">
                    {classroomState === 'teaching' || isTyping ? (
                        <div className="w-full h-12 flex items-center justify-center text-white/50 text-sm animate-pulse font-mono tracking-widest">
                            LECTURING...
                        </div>
                    ) : classroomState === 'finished' ? (
                        <button onClick={() => setMode('bookshelf')} className="flex-1 h-12 bg-emerald-500 hover:bg-emerald-400 text-white rounded-2xl font-bold shadow-lg shadow-emerald-900/20 active:scale-95 transition-all">
                            完成课程
                        </button>
                    ) : classroomState === 'q_and_a' ? (
                        <div className="w-full bg-white/10 rounded-2xl p-1 flex items-center border border-white/10">
                            <input 
                                value={userQuestion}
                                onChange={e => setUserQuestion(e.target.value)}
                                placeholder="输入你的问题..."
                                className="flex-1 bg-transparent px-4 py-2 text-white text-sm outline-none placeholder:text-white/30"
                                autoFocus
                            />
                            <button onClick={handleAskQuestion} className="bg-emerald-500 text-white px-5 py-2 rounded-xl text-xs font-bold ml-2 shadow-sm">发送</button>
                        </div>
                    ) : (
                        <>
                            <button onClick={handleRegenerateChapter} className="w-12 h-12 bg-white/5 hover:bg-white/10 text-slate-400 rounded-2xl font-bold border border-white/10 active:scale-95 transition-all flex items-center justify-center" title="重新生成本章">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" /></svg>
                            </button>
                            <button onClick={() => setClassroomState('q_and_a')} className="w-12 h-12 bg-white/10 hover:bg-white/20 text-white rounded-2xl font-bold border border-white/10 active:scale-95 transition-all flex items-center justify-center">
                                <Hand size={24} />
                            </button>
                            <button onClick={openQuizSetup} className="w-12 h-12 bg-amber-600/80 hover:bg-amber-500 text-white rounded-2xl font-bold border border-amber-400/30 active:scale-95 transition-all flex items-center justify-center" title="刷题">
                                <Notepad size={24} />
                            </button>
                            <button onClick={handleFinishChapter} className="flex-1 h-12 bg-emerald-600 hover:bg-emerald-500 text-white rounded-2xl font-bold shadow-lg shadow-emerald-900/30 active:scale-95 transition-all flex items-center justify-center gap-2">
                                下一章 <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" /></svg>
                            </button>
                        </>
                    )}
                </div>
            </div>

            {/* Quiz Setup Modal */}
            <Modal isOpen={quizShowSetup} title="刷题设置" onClose={() => setQuizShowSetup(false)} footer={
                <button onClick={generateQuiz} disabled={quizTypes.length === 0} className="w-full py-3 bg-amber-500 text-white font-bold rounded-2xl disabled:opacity-40">
                    开始出题
                </button>
            }>
                <div className="space-y-5">
                    <div className="text-xs text-slate-500">
                        当前章节: <span className="font-bold text-slate-700">{activeCourse?.chapters[activeCourse?.currentChapterIndex || 0]?.title}</span>
                    </div>

                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase mb-2 block">题型选择</label>
                        <div className="flex flex-wrap gap-2">
                            {([['choice', '选择题'], ['true_false', '判断题'], ['fill_blank', '填空题']] as const).map(([val, label]) => {
                                const isOn = quizTypes.includes(val);
                                return (
                                    <button key={val} onClick={() => setQuizTypes(prev => isOn ? prev.filter(t => t !== val) : [...prev, val])} className={`px-4 py-2 rounded-xl text-sm font-bold transition-all ${isOn ? 'bg-amber-500 text-white' : 'bg-slate-100 text-slate-500'}`}>
                                        {label}
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase mb-2 block">题目数量: {quizCount}</label>
                        <input type="range" min={3} max={15} value={quizCount} onChange={e => setQuizCount(Number(e.target.value))} className="w-full accent-amber-500" />
                        <div className="flex justify-between text-[10px] text-slate-400 mt-1">
                            <span>3题</span><span>15题</span>
                        </div>
                    </div>
                </div>
            </Modal>
        </div>
    );
};

export default StudyApp;
