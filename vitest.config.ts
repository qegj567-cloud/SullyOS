import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // These inline styles are part of the chat appearance compatibility contract.
    css: { include: [/ChatNoticeCompat\.css/, /ChatCharacterProfile\.css/, /chat(?:Runtime|Preview)\.generated\.css/, /silver-halo\.css/, /lavender-card-palette\.css/] },
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
