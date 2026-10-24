import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import { bakeVoiceMiddleware } from './server/bake-voice-middleware';
import { staticCachePlugin } from './scripts/static-cache-build';
import { startupRecoveryPlugin } from './scripts/startup-recovery-plugin';
import { APP_VERSION_TAG } from './utils/appVersion';

// MiniMax 国服 / 海外是两套域名，前端每个请求都带 X-MiniMax-Region 头说明走哪边。
// Vite 的开发代理底层是 http-proxy，不认 router 选项，所以在 configure 里包一层 proxy.web，
// 按请求头给每个请求单独指定 target。
const minimaxTargetFor = (headers: Record<string, string | string[] | undefined>): string => {
  const region = String(headers['x-minimax-region'] || '').toLowerCase();
  return region === 'overseas' ? 'https://api.minimax.io' : 'https://api.minimaxi.com';
};
const routeMinimaxByRegion: ProxyOptions['configure'] = (proxy) => {
  const forward = proxy.web.bind(proxy);
  // callback 为空时不能往下传 undefined：http-proxy 按参数位置认 options，多一个空位会把 options 挤掉
  proxy.web = (req, res, options, callback) => {
    const routed = { ...options, target: minimaxTargetFor(req.headers) };
    return callback ? forward(req, res, routed, callback) : forward(req, res, routed);
  };
};

// 构建时抓 git 分支 + short commit + UTC+8 构建时间，注入到版本信息显示。
// 非 git 环境（容器、tarball 部署）退化成 'unknown'，不影响构建。
//
// 显示规则：
//   - 默认在 main / master 上隐藏（视为正式发布），其他分支显示
//   - CI detached HEAD 优先读 GITHUB_REF_NAME / VERCEL_GIT_COMMIT_REF / CF_PAGES_BRANCH / BRANCH(Netlify)
//   - VITE_HIDE_BUILD_BADGE=1 强制隐藏（覆盖默认）
//   - VITE_SHOW_BUILD_BADGE=1 强制显示（在 master 本地调试用）
const RELEASE_BRANCHES = new Set(['main', 'master']);
const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000;

function formatBuildTimeUtc8(date = new Date()): string {
  const utc8Date = new Date(date.getTime() + UTC8_OFFSET_MS);
  return `${utc8Date.toISOString().slice(0, 19).replace('T', ' ')} UTC+8`;
}

function readBranch(): string {
  if (process.env.GITHUB_REF_NAME) return process.env.GITHUB_REF_NAME;
  if (process.env.VERCEL_GIT_COMMIT_REF) return process.env.VERCEL_GIT_COMMIT_REF;
  if (process.env.CF_PAGES_BRANCH) return process.env.CF_PAGES_BRANCH;
  if (process.env.BRANCH) return process.env.BRANCH;
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}
function readCommit(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7);
  if (process.env.CF_PAGES_COMMIT_SHA) return process.env.CF_PAGES_COMMIT_SHA.slice(0, 7);
  if (process.env.COMMIT_REF) return process.env.COMMIT_REF.slice(0, 7);
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}

const gitInfo = { branch: readBranch(), commit: readCommit() };
const buildTime = formatBuildTimeUtc8();
// 开头是构建时间（36 进制），网页更新靠它比较两个版本谁新谁旧，别改掉这个前缀。
const appBuildId = `${Date.now().toString(36)}-${gitInfo.commit}`;
const isReleaseBranch = RELEASE_BRANCHES.has(gitInfo.branch);
let showBuildBadge = !isReleaseBranch;
if (process.env.VITE_HIDE_BUILD_BADGE === '1') showBuildBadge = false;
if (process.env.VITE_SHOW_BUILD_BADGE === '1') showBuildBadge = true;

export default defineConfig({
  resolve: {
    // Live2D subclasses Pixi containers, so both the renderer and the engine
    // must share the same Pixi prototype/extension registry in dev and builds.
    dedupe: [
      'react',
      'react-dom',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'pixi.js',
      '@pixi/sound',
    ],
  },
  plugins: [
    startupRecoveryPlugin(appBuildId),
    react(),
    staticCachePlugin({ buildId: appBuildId, appVersion: APP_VERSION_TAG }),
    {
      name: 'bake-voice-middleware',
      configureServer(server) {
        server.middlewares.use('/api/minimax/bake-voice', bakeVoiceMiddleware);
      },
    },
  ],
  define: {
    __BUILD_BRANCH__: JSON.stringify(gitInfo.branch),
    __BUILD_COMMIT__: JSON.stringify(gitInfo.commit),
    __BUILD_TIME__: JSON.stringify(buildTime),
    __BUILD_BADGE_VISIBLE__: JSON.stringify(showBuildBadge),
    __APP_BUILD_ID__: JSON.stringify(appBuildId),
  },
  // GitHub Pages 发布时使用相对路径，避免仓库子路径导致资源 404
  base: process.env.GITHUB_PAGES ? './' : '/',
  esbuild: {
    // 只剥 debugger，保留 console.* —— 部署后按 F12 仍能看到运行时日志，方便排查。
    drop: ['debugger'],
  },
  server: {
    proxy: {
      '/api/minimax/t2a': {
        target: 'https://api.minimaxi.com',
        changeOrigin: true,
        secure: true,
        rewrite: () => '/v1/t2a_v2',
        configure: routeMinimaxByRegion,
      },
      '/api/minimax/stt': {
        target: 'https://api.minimaxi.com',
        changeOrigin: true,
        secure: true,
        rewrite: () => '/v1/speech_to_text',
        configure: routeMinimaxByRegion,
      },
      '/api/minimax/get-voice': {
        target: 'https://api.minimaxi.com',
        changeOrigin: true,
        secure: true,
        rewrite: () => '/v1/get_voice',
        configure: routeMinimaxByRegion,
      },
      '/api/minimax/music': {
        target: 'https://api.minimaxi.com',
        changeOrigin: true,
        secure: true,
        rewrite: () => '/v1/music_generation',
        configure: routeMinimaxByRegion,
      },
      // 鱼声 Fish Audio TTS：转发到 https://api.fish.audio/v1/tts（返回二进制音频）
      '/api/fishaudio/tts': {
        target: 'https://api.fish.audio',
        changeOrigin: true,
        secure: true,
        rewrite: () => '/v1/tts',
      },
      // 鱼声 Fish Audio STT：转发到 https://api.fish.audio/v1/asr
      '/api/fishaudio/stt': {
        target: 'https://api.fish.audio',
        changeOrigin: true,
        secure: true,
        rewrite: () => '/v1/asr',
      },
      // ElevenLabs TTS：开发环境把同源查询参数改写到官方 voice_id 路径。
      '/api/elevenlabs/tts': {
        target: 'https://api.elevenlabs.io',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => {
          const parsed = new URL(path, 'http://localhost');
          const voiceId = parsed.searchParams.get('voice_id') || '';
          const outputFormat = parsed.searchParams.get('output_format') || 'mp3_44100_128';
          const endpoint = parsed.searchParams.get('mode') === 'dialogue' ? 'text-to-dialogue' : `text-to-speech/${encodeURIComponent(voiceId)}`;
          const timing = parsed.searchParams.get('timestamps') === '1' ? '/with-timestamps' : '';
          return `/v1/${endpoint}/stream${timing}?output_format=${encodeURIComponent(outputFormat)}`;
        },
      },
      // ElevenLabs STT (Scribe)：转发到 https://api.elevenlabs.io/v1/speech-to-text
      '/api/elevenlabs/stt': {
        target: 'https://api.elevenlabs.io',
        changeOrigin: true,
        secure: true,
        rewrite: () => '/v1/speech-to-text',
      },
    }
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets/build',
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: { main: 'index.html', wardrobe: 'chibi-wardrobe.html' },
      // 关键修复：将这些包排除在打包之外，让浏览器通过 index.html 的 importmap 加载
      external: ['katex'],
      onwarn(warning, defaultHandler) {
        // 抑制动态导入与静态导入混合的无害警告
        if (warning.message?.includes('dynamic import will not move module into another chunk')) return;
        defaultHandler(warning);
      },
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            // This SDK core is dependency-free. Keep its initialized constants
            // outside vendor-react: memory-palace initializes a store at module
            // scope and can run before that cyclic vendor chunk's var defaults.
            if (/[\\/]@rei-standard[\\/]blob-store[\\/]dist[\\/]index\.mjs$/.test(id)) {
              return 'vendor-blob-store';
            }
            // Only load the image renderer when exporting a beauty preview.
            if (id.includes('html2canvas')) return 'beauty-preview-renderer';
            // Local camera emotion calibration is opt-in. Keep MediaPipe out of
            // the preloaded common vendor so its JS is fetched only after the
            // user explicitly enables their camera.
            if (id.includes('@mediapipe/tasks-vision')) {
              return 'vendor-mediapipe';
            }
            // Optional parsers and UI must stay out of the eagerly loaded common vendor.
            if (/[\\/]node_modules[\\/]animal-island-ui[\\/]/.test(id)) return 'vendor-island';
            if (/[\\/]node_modules[\\/]ag-psd[\\/]/.test(id)) return 'vendor-psd';
            if (/[\\/]node_modules[\\/]pdfjs-dist[\\/]/.test(id)) return 'vendor-pdf';
            // BVH imports Three: leaving it in common vendor pulls the 3D engine
            // back into desktop startup, even when application imports are lazy.
            // VRM/Three 用于按需打开的 3D 小屋及通话。单独成包，避免 3D 引擎
            // 被通用 vendor 首屏加载，普通聊天/桌面用户无需支付这部分体积。
            if (id.includes('@pixiv/three-vrm') || /[\\/]node_modules[\\/](?:three|three-mesh-bvh)[\\/]/.test(id)) {
              return 'vendor-vrm';
            }
            // The Cubism adapter checks window.Live2DCubismCore at module evaluation
            // time. Keep it out of the Pixi chunk: the call page and Live2D desktop
            // theme import Pixi eagerly, while live2dCore.ts must load Cubism Core
            // before dynamically importing this adapter.
            if (id.includes('untitled-pixi-live2d-engine')) {
              return 'vendor-live2d-engine';
            }
            // Filters extend Pixi classes during module evaluation. Keeping them
            // in common vendor creates vendor -> Pixi -> vendor TDZ cycles.
            if (id.includes('pixi-filters') || id.includes('@pixi/') || /[\\/]node_modules[\\/]pixi\.js[\\/]/.test(id)) {
              return 'vendor-live2d';
            }
            if (id.includes('react') || id.includes('react-dom') || id.includes('scheduler')) {
              return 'vendor-react';
            }
            if (id.includes('@phosphor-icons')) {
              return 'vendor-icons';
            }
            if (id.includes('@capacitor')) {
              return 'vendor-capacitor';
            }
            return 'vendor';
          }
          // Let Rollup place application modules by their real dependency graph.
          // Forcing memoryPalace into one chunk also hoists shared contexts and
          // creates application -> React vendor -> application startup cycles.
        }
      }
    }
  }
});
