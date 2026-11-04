import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
execFileSync(process.execPath,[require.resolve('tailwindcss/lib/cli.js'),'-c','scripts/chat-preview.tailwind.cjs','-i','scripts/chat-preview.input.css','-o','components/chat/chatPreview.generated.css','--minify'],{cwd:fileURLToPath(new URL('..',import.meta.url)),stdio:'inherit'});
// Chat layout must be ready before its first paint, rather than waiting for browser JIT.
execFileSync(process.execPath,[require.resolve('tailwindcss/lib/cli.js'),'-c','scripts/chat-runtime.tailwind.cjs','-i','scripts/chat-runtime.input.css','-o','components/chat/chatRuntime.generated.css','--minify'],{cwd:fileURLToPath(new URL('..',import.meta.url)),stdio:'inherit'});
