import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Workers 运行时自带的虚拟模块，node 上解析不到（不给别名的话，import 到它的
      // 测试文件整个加载失败）。打包侧的对应处理是 build-workers.mjs 里的 external。
      'cloudflare:workers': new URL('./test/stubs/cloudflare-workers.ts', import.meta.url).pathname,
    },
  },
  test: {
    // These inline styles are part of the chat appearance compatibility contract.
    css: { include: [/ChatNoticeCompat\.css/, /chat(?:Runtime|Preview)\.generated\.css/] },
    // Transform the UI library's CSS modules in browser component tests.
    server: { deps: { inline: ['animal-island-ui'] } },
    environment: 'node',
    setupFiles: ['./test-setup.ts'],
    include: [
      'utils/**/*.test.ts',
      'worker/**/*.test.ts',
      'scripts/**/*.test.ts',
    ],
    // 排除 React 组件 / 浏览器集成测 (没装 jsdom)
    exclude: ['node_modules', '**/node_modules/**', '.worktrees', 'dist'],
  },
});
