
import React, { useState, useEffect, useRef } from 'react';
import { useOS } from '../context/OSContext';
import { processImage } from '../utils/file';
import { safeResponseJson } from '../utils/safeApi';
import Modal from '../components/os/Modal';
import { Camera, ImageSquare, GlobeSimple, MagnifyingGlass, Lightning } from '@phosphor-icons/react';

const TWEMOJI_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72';
const twemojiUrl = (codepoint: string) => `${TWEMOJI_BASE}/${codepoint}.png`;

// --- Simple Markdown Renderer for Web Content ---
const WebRenderer: React.FC<{ content: string }> = ({ content }) => {
    // Basic cleaning and rendering logic
    const lines = content.split('\n');
    return (
        <div className="space-y-4 text-slate-800 leading-relaxed font-sans text-sm">
            {lines.map((line, i) => {
                const trimmed = line.trim();
                if (!trimmed) return <div key={i} className="h-2" />;
                
                // Headers
                if (trimmed.startsWith('# ')) return <h1 key={i} className="text-2xl font-bold text-black mt-4 border-b pb-2">{trimmed.slice(2)}</h1>;
                if (trimmed.startsWith('## ')) return <h2 key={i} className="text-xl font-bold text-slate-900 mt-3">{trimmed.slice(3)}</h2>;
                if (trimmed.startsWith('### ')) return <h3 key={i} className="text-lg font-bold text-slate-800 mt-2">{trimmed.slice(4)}</h3>;
                
                // Specialized: Note Card (Xiaohongshu style simulation)
                // Detected by format: [NOTE_CARD|Title|Author|Likes]
                const noteMatch = trimmed.match(/\[NOTE_CARD\|(.*?)\|(.*?)\|(.*?)\]/);
                if (noteMatch) {
                    return (
                        <div key={i} className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden mb-4 inline-block w-[48%] mr-[2%] align-top break-inside-avoid">
                            <div className="aspect-[3/4] bg-slate-200 w-full flex items-center justify-center text-slate-400"><Camera size={48} /></div>
                            <div className="p-2">
                                <div className="font-bold text-slate-800 text-xs line-clamp-2 mb-2">{noteMatch[1]}</div>
                                <div className="flex justify-between items-center">
                                    <div className="flex items-center gap-1">
                                        <div className="w-4 h-4 rounded-full bg-slate-300"></div>
                                        <span className="text-[10px] text-slate-500 truncate w-12">{noteMatch[2]}</span>
                                    </div>
                                    <div className="flex items-center gap-0.5 text-slate-400">
                                        <span className="text-[10px] flex items-center gap-0.5"><img src={twemojiUrl('2764-fe0f')} alt="heart" className="w-3 h-3 inline" /> {noteMatch[3]}</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    );
                }

                // Specialized: Video Card (Bilibili style simulation)
                // Detected by format: [VIDEO_CARD|Title|Uploader|Views]
                const videoMatch = trimmed.match(/\[VIDEO_CARD\|(.*?)\|(.*?)\|(.*?)\]/);
                if (videoMatch) {
                    return (
                        <div key={i} className="flex gap-3 mb-3 bg-white p-2 rounded-lg shadow-sm border border-slate-100">
                            <div className="w-32 aspect-video bg-slate-800 rounded-md flex items-center justify-center text-white shrink-0 relative">
                                <span className="text-xl">▶</span>
                                <div className="absolute bottom-1 right-1 text-[8px] bg-black/60 px-1 rounded">12:34</div>
                            </div>
                            <div className="flex-1 flex flex-col justify-between py-1">
                                <div className="text-sm text-slate-800 line-clamp-2 leading-tight">{videoMatch[1]}</div>
                                <div className="text-[10px] text-slate-400 flex flex-col gap-0.5">
                                    <span className="flex items-center gap-1">UP <span className="text-slate-500">{videoMatch[2]}</span></span>
                                    <span>▶ {videoMatch[3]}</span>
                                </div>
                            </div>
                        </div>
                    );
                }

                // Links (Simulated style)
                if (trimmed.startsWith('- [') || trimmed.startsWith('* [')) {
                    // Extract Link text and url part (roughly)
                    const match = trimmed.match(/\[(.*?)\]\((.*?)\)/);
                    if (match) {
                        return (
                            <div key={i} className="py-3 px-3 bg-white rounded-lg border border-slate-100 shadow-sm mb-2 hover:shadow-md transition-shadow">
                                <div className="text-blue-600 font-medium cursor-pointer hover:underline text-sm mb-1">{match[1]}</div>
                                <div className="text-green-700 text-[10px] truncate opacity-60 mb-1">{match[2]}</div>
                                <div className="text-slate-500 text-xs line-clamp-2 leading-normal">{trimmed.replace(match[0], '').replace(/^[-*]\s*/, '')}</div>
                            </div>
                        );
                    }
                }

                // List Items
                if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
                    return <div key={i} className="flex gap-2 pl-2"><span className="text-slate-400">•</span><span>{trimmed.slice(2)}</span></div>;
                }

                // Images (Markdown)
                const imgMatch = trimmed.match(/!\[(.*?)\]\((.*?)\)/);
                if (imgMatch) {
                    return (
                        <div key={i} className="my-4 bg-slate-100 rounded-lg overflow-hidden border border-slate-200">
                            {/* Placeholder for images since AI can't generate real URLs reliably without tool use */}
                            <div className="h-40 flex items-center justify-center bg-slate-200 text-slate-400 gap-2 flex-col">
                                <ImageSquare size={28} />
                                <span className="text-xs text-slate-500">{imgMatch[1] || 'External Image'}</span>
                            </div>
                        </div>
                    );
                }

                // Separator
                if (trimmed === '---') return <hr key={i} className="border-t border-slate-200 my-4" />;

                return <p key={i}>{trimmed}</p>;
            })}
        </div>
    );
};

const BrowserApp: React.FC = () => {
    const { closeApp, apiConfig, addToast } = useOS();
    
    // Browser State
    const [urlInput, setUrlInput] = useState('');
    const [currentUrl, setCurrentUrl] = useState('home://start');
    const [pageTitle, setPageTitle] = useState('New Tab');
    const [content, setContent] = useState('');
    const [searchResults, setSearchResults] = useState<any[] | null>(null); // New: Store raw search results
    const [isLoading, setIsLoading] = useState(false);
    const [history, setHistory] = useState<string[]>(['home://start']);
    const [historyIndex, setHistoryIndex] = useState(0);
    const [isRealNet, setIsRealNet] = useState(false); // Status indicator
    
    // Settings State
    const [showSettings, setShowSettings] = useState(false);
    const [braveKey, setBraveKey] = useState(localStorage.getItem('browser_brave_key') || '');
    const [useRealSearch, setUseRealSearch] = useState(localStorage.getItem('browser_use_real_search') === 'true');

    // Refs
    const scrollRef = useRef<HTMLDivElement>(null);

    // Initial Load
    useEffect(() => {
        if (currentUrl === 'home://start') {
            setContent(""); 
            setSearchResults(null);
            setPageTitle("New Tab");
            setIsRealNet(false);
        }
    }, [currentUrl]);

    const handleSaveSettings = () => {
        localStorage.setItem('browser_brave_key', braveKey);
        localStorage.setItem('browser_use_real_search', String(useRealSearch));
        setShowSettings(false);
        addToast('浏览器设置已保存', 'success');
    };

    // --- Navigation Logic ---

    const navigate = (url: string, newEntry: boolean = true) => {
        let targetUrl = url;
        
        // Smart URL handling
        if (!targetUrl.includes('.') && !targetUrl.includes('://')) {
            // Treat as search
            targetUrl = `https://www.google.com/search?q=${encodeURIComponent(targetUrl)}`;
        } else if (!targetUrl.startsWith('http') && !targetUrl.startsWith('home://')) {
            targetUrl = `https://${targetUrl}`;
        }

        setCurrentUrl(targetUrl);
        setUrlInput(targetUrl);
        
        if (newEntry) {
            const newHistory = history.slice(0, historyIndex + 1);
            newHistory.push(targetUrl);
            setHistory(newHistory);
            setHistoryIndex(newHistory.length - 1);
        }

        if (targetUrl === 'home://start') {
            setPageTitle("New Tab");
            setContent("");
            setSearchResults(null);
            return;
        }

        loadPageContent(targetUrl);
    };

    const handleBack = () => {
        if (historyIndex > 0) {
            const prevIndex = historyIndex - 1;
            setHistoryIndex(prevIndex);
            const prevUrl = history[prevIndex];
            setCurrentUrl(prevUrl);
            setUrlInput(prevUrl);
            if (prevUrl === 'home://start') {
                setPageTitle("New Tab");
                setContent("");
                setSearchResults(null);
            } else {
                loadPageContent(prevUrl);
            }
        }
    };

    const handleForward = () => {
        if (historyIndex < history.length - 1) {
            const nextIndex = historyIndex + 1;
            setHistoryIndex(nextIndex);
            const nextUrl = history[nextIndex];
            setCurrentUrl(nextUrl);
            setUrlInput(nextUrl);
            loadPageContent(nextUrl);
        }
    };

    const handleRefresh = () => {
        loadPageContent(currentUrl);
    };

    // --- Content Loader ---

    const loadPageContent = async (url: string) => {
        if (!apiConfig.apiKey) {
            addToast('请先在设置中配置 API Key', 'error');
            return;
        }

        setIsLoading(true);
        setIsRealNet(false); 
        setSearchResults(null); // Clear previous results
        setContent(''); // Clear previous content
        
        // Scroll to top
        if (scrollRef.current) scrollRef.current.scrollTop = 0;

        try {
            const isSearch = url.includes('search?q=');
            
            // Experimental: Real Search (Skip AI Brain)
            if (isSearch && useRealSearch && braveKey) {
                const query = decodeURIComponent(url.split('q=')[1] || '');
                try {
                    // Attempt to fetch from Brave Search
                    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${query}&count=10`, {
                        headers: {
                            'Accept': 'application/json',
                            'X-Subscription-Token': braveKey
                        }
                    });
                    
                    if (res.ok) {
                        const data = await safeResponseJson(res);
                        const results = data.web?.results || [];
                        
                        setSearchResults(results); // RAW RESULTS
                        setIsRealNet(true);
                        setPageTitle(`${query} - 搜索`);
                        setIsLoading(false);
                        return; // STOP HERE! NO AI.
                    }
                } catch (e) {
                    console.warn("Real search failed, falling back to AI simulation", e);
                }
            }

            // Fallback / AI Simulation for Pages
            // Determine Context for AI
            const isXiaohongshu = url.includes('xiaohongshu') || url.includes('小红书');
            const isBilibili = url.includes('bilibili') || url.includes('哔哩哔哩');
            
            let systemPrompt = `You are a text-based web browser simulator. 
Your task is to generate the content of the webpage the user is visiting based on the URL.
Current URL: "${url}"`;

            // Special Styling Instructions
            if (isXiaohongshu) {
                systemPrompt += `\n\n### Special Mode: Xiaohongshu (Little Red Book)
You are simulating a social media feed. 
Use a specialized format for posts: \`[NOTE_CARD|Title|Author Name|Likes Count]\`.
Generate 6-8 varied, realistic lifestyle posts (fashion, food, travel, tech) relevant to the context.`;
            } else if (isBilibili) {
                systemPrompt += `\n\n### Special Mode: Bilibili (Video Site)
You are simulating a video platform feed.
Use a specialized format for videos: \`[VIDEO_CARD|Video Title|Uploader Name|View Count]\`.
Generate 5-6 realistic video entries (anime, tech, gaming, daily).`;
            }

            systemPrompt += `\n\n### Rules
1. **Format**: Use Markdown.
2. **Links**: Include links \`[Link Text](URL)\`.
3. **Tone**: Match the website's tone.
4. **Language**: Match the language of the query/URL (Chinese default for .cn/Chinese queries).
`;

            let userPrompt = "";
            if (isSearch) {
                userPrompt = `Simulate a search result page for: "${decodeURIComponent(url.split('q=')[1] || '')}". 
Generate realistic results linking to hypothetical URLs.`;
            } else {
                userPrompt = `Simulate the full webpage content for: "${url}". Make it detailed and realistic.`;
            }

            const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({
                    model: apiConfig.model,
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: userPrompt }
                    ],
                    temperature: 0.6,
                    max_tokens: 4000
                }),
                __sullyMeta: { appId: 'browser', appName: '浏览器', purpose: '生成虚拟网页' },
            } as RequestInit);

            if (!response.ok) throw new Error('Network Error');
            
            const data = await safeResponseJson(response);
            const raw = data.choices[0].message.content;
            
            // Parse Title and Content
            const parts = raw.split('\n');
            let title = url;
            let body = raw;

            // Simple title extraction if AI followed implicit structure
            if (parts[0].startsWith('# ')) {
                title = parts[0].replace('# ', '').trim();
            }

            setPageTitle(title);
            setContent(body);

        } catch (e: any) {
            setContent(`# 无法访问此网站\n\n**错误信息**: ${e.message}\n\n请检查网络连接或 API 设置。`);
            setPageTitle("Error");
        } finally {
            setIsLoading(false);
        }
    };

    // --- Renderers ---

    const renderSearchResults = () => {
        if (!searchResults) return null;
        return (
            <div className="space-y-4 animate-fade-in pb-10">
                {searchResults.map((item: any, idx: number) => {
                    const hostname = new URL(item.url).hostname;
                    return (
                        <div 
                            key={idx} 
                            onClick={() => navigate(item.url)} 
                            className="bg-white p-4 rounded-xl shadow-sm border border-slate-100 cursor-pointer active:scale-[0.98] transition-all hover:shadow-md"
                        >
                            <div className="flex items-center gap-2 text-[10px] text-slate-500 mb-1.5">
                                {item.profile?.img ? (
                                    <img src={item.profile.img} className="w-4 h-4 rounded-full object-cover"/>
                                ) : (
                                    <div className="w-4 h-4 rounded-full bg-slate-100 flex items-center justify-center font-bold text-slate-400 text-[8px]">
                                        {hostname[0].toUpperCase()}
                                    </div>
                                )}
                                <span className="font-medium text-slate-700">{item.profile?.name || hostname}</span>
                                <span className="text-slate-300">•</span>
                                <span className="truncate max-w-[150px] opacity-70">{item.url}</span>
                            </div>
                            
                            <div className="flex gap-4">
                                <div className="flex-1 min-w-0">
                                    <h3 className="text-sm font-bold text-blue-600 mb-1.5 leading-snug line-clamp-2 hover:underline">{item.title}</h3>
                                    <p className="text-xs text-slate-600 leading-relaxed line-clamp-3">
                                        {item.age && <span className="text-slate-400 mr-1">{item.age} —</span>}
                                        {/* Use raw HTML description from Brave to keep bolding tags */}
                                        <span dangerouslySetInnerHTML={{ __html: item.description }} />
                                    </p>
                                </div>
                                {item.thumbnail?.src && (
                                    <img src={item.thumbnail.src} className="w-24 h-24 object-cover rounded-lg bg-slate-50 shrink-0 border border-slate-100" loading="lazy" />
                                )}
                            </div>
                        </div>
                    );
                })}
                <div className="text-center text-[10px] text-slate-300 pt-4 pb-8">
                    Results provided by Brave Search
                </div>
            </div>
        );
    };

    const renderStartPage = () => (
        <div className="flex flex-col items-center justify-center h-full pb-20 p-4 animate-fade-in">
            <div className="text-5xl font-bold text-slate-300 mb-8 flex flex-col items-center gap-2">
                <GlobeSimple size={48} className="text-slate-300" />
                <span className="text-2xl tracking-widest uppercase">Sully Browser</span>
            </div>
            
            <div className="w-full max-w-sm">
                <form 
                    onSubmit={(e) => { e.preventDefault(); navigate(urlInput); }}
                    className="relative group"
                >
                    <input 
                        value={urlInput}
                        onChange={(e) => setUrlInput(e.target.value)}
                        placeholder="Search or type URL"
                        className="w-full bg-slate-100 border border-slate-200 rounded-full py-4 pl-12 pr-4 shadow-sm focus:shadow-md focus:bg-white focus:border-blue-300 outline-none transition-all text-slate-700"
                        autoFocus
                    />
                    <div className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" /></svg>
                    </div>
                </form>
            </div>

            <div className="grid grid-cols-4 gap-6 mt-12 w-full max-w-sm px-4">
                {[
                    { name: 'Google', icon: twemojiUrl('1f50d'), url: 'google.com' },
                    { name: 'Bilibili', icon: twemojiUrl('1f4fa'), url: 'bilibili.com' },
                    { name: 'RedBook', icon: twemojiUrl('1f4d5'), url: 'xiaohongshu.com' },
                    { name: 'Sully', icon: twemojiUrl('1f431'), url: 'sully.personal.blog' },
                ].map((site) => (
                    <button
                        key={site.name}
                        onClick={() => navigate(site.url)}
                        className="flex flex-col items-center gap-2 group"
                    >
                        <div className="w-12 h-12 bg-slate-50 rounded-2xl flex items-center justify-center shadow-sm border border-slate-100 group-hover:scale-110 transition-transform group-active:scale-95">
                            <img src={site.icon} alt={site.name} className="w-6 h-6" />
                        </div>
                        <span className="text-[10px] text-slate-500 font-medium">{site.name}</span>
                    </button>
                ))}
            </div>
            
            <div className="mt-12 text-center">
                <button 
                    onClick={() => setShowSettings(true)}
                    className="text-xs text-slate-400 flex items-center gap-1 hover:text-blue-500 transition-colors"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3"><path fillRule="evenodd" d="M7.84 1.804A1 1 0 0 1 8.82 1h2.36a1 1 0 0 1 .98.804l.331 1.652a6.993 6.993 0 0 1 1.929 1.115l1.598-.54a1 1 0 0 1 1.186.447l1.18 2.044a1 1 0 0 1-.205 1.251l-1.267 1.113a7.047 7.047 0 0 1 0 2.228l1.267 1.113a1 1 0 0 1 .206 1.25l-1.18 2.045a1 1 0 0 1-1.187.447l-1.598-.54a6.993 6.993 0 0 1-1.929 1.115l-.33 1.652a1 1 0 0 1-.98.804H8.82a1 1 0 0 1-.98-.804l-.331-1.652a6.993 6.993 0 0 1-1.929-1.115l-1.598.54a1 1 0 0 1-1.186-.447l-1.18-2.044a1 1 0 0 1 .205-1.251l1.267-1.114a7.05 7.05 0 0 1 0-2.227L1.821 7.773a1 1 0 0 1-.206-1.25l1.18-2.045a1 1 0 0 1 1.187-.447l1.598.54A6.992 6.992 0 0 1 7.51 3.456l.33-1.652ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" clipRule="evenodd" /></svg>
                    配置真实搜索引擎 (Brave API)
                </button>
            </div>
        </div>
    );

    return (
        <div className="h-full w-full bg-white flex flex-col font-sans relative">
            {/* Top Bar (Address) */}
            <div className="bg-slate-50 border-b border-slate-200 shrink-0 z-20 sticky top-0 shadow-sm" style={{ paddingTop: 'var(--safe-top)' }}>
              <div className="flex flex-col px-4 pt-2 pb-3">
                {/* Controls Row */}
                <div className="flex justify-between items-center mb-2">
                    <button onClick={closeApp} className="text-slate-400 hover:text-slate-600 text-xs font-bold px-2">Close</button>
                    
                    <div className="flex items-center gap-1.5 overflow-hidden">
                        {/* Status Indicator */}
                        <div className={`w-2 h-2 rounded-full ${isRealNet ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]' : 'bg-slate-300'}`}></div>
                        <div className="text-xs font-bold text-slate-800 truncate max-w-[150px]">{pageTitle}</div>
                    </div>
                    
                    <div className="flex items-center gap-2">
                        <button onClick={() => setShowSettings(true)} className="text-slate-400 hover:text-slate-600 p-1 rounded-full bg-slate-200/50">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M10.34 15.84c-.688-.06-1.386-.09-2.09-.09H7.5a4.5 4.5 0 1 1 0-9h.75c.704 0 1.402-.03 2.09-.09m0 9.18c.253.962.584 1.892.985 2.783.247.55.06 1.21-.463 1.511l-.657.38c-.551.318-1.26.117-1.527-.461a20.845 20.845 0 0 1-1.44-4.282m3.102.069a18.03 18.03 0 0 1-.59-4.59c0-1.586.205-3.124.59-4.59m0 9.18a23.848 23.848 0 0 1 8.835 2.535M10.34 6.66a23.847 23.847 0 0 0 8.835-2.535m0 0A23.74 23.74 0 0 0 18.795 3m.38 1.125a23.91 23.91 0 0 1 1.014 5.795 23.92 23.92 0 0 1-1.012 5.795m0-11.589a23.849 23.849 0 0 1-4.92 8.192m4.92-8.192a23.856 23.856 0 0 1 4.92 8.192m0 0a23.856 23.856 0 0 1-4.92 8.192m4.92-8.192a23.91 23.91 0 0 1-1.014 5.795m0-11.589A23.849 23.849 0 0 1 18.795 21M6.75 12h.75" /></svg>
                        </button>
                        <button onClick={handleRefresh} className={`text-slate-400 hover:text-slate-600 p-1 rounded-full ${isLoading ? 'animate-spin text-blue-500' : ''}`}>
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" /></svg>
                        </button>
                    </div>
                </div>
                
                {/* Address Input */}
                <form 
                    onSubmit={(e) => { e.preventDefault(); navigate(urlInput); }}
                    className="flex items-center gap-2 bg-slate-200/50 rounded-xl px-3 py-2 transition-all focus-within:bg-white focus-within:ring-2 focus-within:ring-blue-100 focus-within:shadow-sm"
                >
                    <div className="text-slate-400">
                        {currentUrl.startsWith('https') ? 
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={`w-3 h-3 ${isRealNet ? 'text-green-600' : 'text-slate-400'}`}><path fillRule="evenodd" d="M10 2a.75.75 0 0 1 .75.75v.506a5.001 5.001 0 0 1 .533.025c.947.1 1.95.217 2.883.534.364.124.699.27.995.45.353.214.673.475.775.833.08.277.086.598-.037.84a2.532 2.532 0 0 1-.397.643c-.456.602-1.393.896-1.921 1.018a9.497 9.497 0 0 1-1.077.177 10.37 10.37 0 0 1-1.753.072V17.25h1.75a.75.75 0 0 1 0 1.5h-5a.75.75 0 0 1 0-1.5h1.75v-9.39a10.37 10.37 0 0 1-1.754-.073 9.497 9.497 0 0 1-1.076-.176c-.528-.122-1.465-.416-1.92-.1.018a2.532 2.532 0 0 1-.398-.644c-.122-.242-.116-.563-.036-.84.102-.358.422-.619.775-.833.296-.18.63-.326.995-.45.933-.317 1.936-.434 2.883-.534A5.001 5.001 0 0 1 9.25 3.256V2.75A.75.75 0 0 1 10 2Z" clipRule="evenodd" /></svg> 
                            : <MagnifyingGlass size={12} weight="bold" />
                        }
                    </div>
                    <input 
                        className="flex-1 bg-transparent text-sm outline-none text-slate-700 placeholder:text-slate-400"
                        value={urlInput}
                        onChange={(e) => setUrlInput(e.target.value)}
                        onFocus={() => { if(currentUrl === 'home://start') setUrlInput(''); }}
                        placeholder="Search or enter website name"
                    />
                </form>
              </div>
            </div>

            {/* Main Content */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto no-scrollbar relative bg-white">
                {isLoading && (
                    <div className="absolute top-0 left-0 w-full h-1 bg-blue-100 overflow-hidden z-20">
                        <div className="h-full bg-blue-500 animate-progress origin-left"></div>
                    </div>
                )}
                
                {currentUrl === 'home://start' ? renderStartPage() : (
                    <div className="p-4 pb-24 min-h-full">
                        {isRealNet && !searchResults && <div className="text-[10px] text-green-600 font-bold bg-green-50 p-2 rounded mb-4 flex items-center gap-2 border border-green-100"><Lightning size={12} weight="fill" /> 已连接 Brave Search 实时网络</div>}
                        
                        {searchResults ? renderSearchResults() : (
                            <WebRenderer content={content} />
                        )}
                    </div>
                )}
            </div>

            {/* Bottom Toolbar */}
            <div className="h-12 bg-slate-50 border-t border-slate-200 flex justify-between items-center px-6 pb-safe shrink-0 z-20">
                <button onClick={handleBack} disabled={historyIndex <= 0} className="p-2 text-slate-500 disabled:opacity-30 active:scale-90 transition-transform"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg></button>
                <button onClick={handleForward} disabled={historyIndex >= history.length - 1} className="p-2 text-slate-500 disabled:opacity-30 active:scale-90 transition-transform rotate-180"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg></button>
                <button className="p-2 text-slate-500 active:scale-90 transition-transform"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" /></svg></button>
                <button onClick={() => navigate('home://start')} className="p-2 text-slate-500 active:scale-90 transition-transform"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="m2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125-1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" /></svg></button>
                <button className="p-2 text-slate-500 active:scale-90 transition-transform"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M16.5 3.75V16.5L12 14.25 7.5 16.5V3.75m9 0H18A2.25 2.25 0 0 1 20.25 6v12A2.25 2.25 0 0 1 18 20.25H6A2.25 2.25 0 0 1 3.75 18V6A2.25 2.25 0 0 1 6 3.75h1.5m9 0h-9" /></svg></button>
            </div>

            {/* Settings Modal */}
            <Modal 
                isOpen={showSettings} 
                title="网络设置" 
                onClose={() => setShowSettings(false)}
                footer={<button onClick={handleSaveSettings} className="w-full py-3 bg-blue-500 text-white font-bold rounded-2xl">保存配置</button>}
            >
                <div className="space-y-4">
                    <div>
                        <label className="text-xs font-bold text-slate-400 uppercase mb-2 block">Brave Search API Key</label>
                        <input 
                            value={braveKey} 
                            onChange={e => setBraveKey(e.target.value)} 
                            placeholder="BSA-..." 
                            className="w-full bg-slate-100 rounded-xl px-4 py-3 text-sm focus:outline-blue-500 font-mono" 
                        />
                        <p className="text-[10px] text-slate-400 mt-2 leading-relaxed bg-slate-50 p-2 rounded">
                            <span className="font-bold">注意：</span> 配置 Key 后可搜索现实世界的内容（如B站、小红书）。<br/>
                            但页面由 AI 重新排版呈现，可能和原网站不一样。
                        </p>
                    </div>
                    <div className="flex items-center gap-3 bg-slate-50 p-3 rounded-xl border border-slate-100">
                        <input 
                            type="checkbox" 
                            checked={useRealSearch} 
                            onChange={e => setUseRealSearch(e.target.checked)}
                            className="w-5 h-5 accent-blue-500 rounded"
                        />
                        <div className="flex-1">
                            <span className="text-sm font-bold text-slate-700 block">启用真实搜索 (Experimental)</span>
                            <span className="text-[10px] text-slate-400 block">搜真实网络内容；搜不到时改由 AI 模拟生成。</span>
                        </div>
                    </div>
                </div>
            </Modal>
        </div>
    );
};

export default BrowserApp;
