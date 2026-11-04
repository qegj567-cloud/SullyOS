# 协同工作外观

入口：ChatApp → ＋ → 协同工作 → 右上角「协同设置」。

## 官方主题与自定义 CSS

保留原有六套浅色风格，另外提供「炭黑」「暖灰夜读」「午夜蓝」三套深色风格。深色同时适配输入区、设置、历史窗口、文件库、制作面板和操作弹窗；作品预览本身保留作品的配色。

点击主题可以预览，点保存后才持久化；返回放弃未保存的修改。外观是整个协同工作共用的设置，不按角色或协同模式分开。

「自定义 CSS」叠加在所选主题之后。清空后保存即可恢复所选主题。打开设置时暂不注入自定义 CSS，方便编辑和恢复；CSS 保存后才应用。

```css
.collab-ui-root {
  --collab-accent: #9fc8b1;
}
.collab-ui-root .collab-message-bubble-user {
  border-radius: 14px !important;
}
```

可覆盖的颜色变量：`--collab-bg`（窗口底色）、`--collab-panel`（顶栏等面板）、`--collab-panel-solid`（卡片/输入框）、`--collab-ink`（正文）、`--collab-muted`（辅助文字）、`--collab-line`（边框）、`--collab-accent`（强调色）、`--collab-user` / `--collab-user-ink`（用户气泡）。深色还提供 `--collab-accent-ink`（强调色按钮上的文字）。浅色「角色气泡」仍沿用 ChatApp 的背景和基础气泡样式。

常用选择器均加 `.collab-ui-root` 前缀：`.collab-ui-header`、`.collab-ui-composer`、`.collab-message-bubble-user`、`.collab-message-bubble-assistant`、`.collab-settings-panel`、`.collab-file-library`。直接改零件属性时，已有强制样式可用 `!important` 覆盖；改颜色变量通常无需添加。

编辑器复用 `CssCodeEditor`；校验复用 `validateScopedCss`，要求选择器只指向协同根或其子元素，不允许根的相邻/后续兄弟元素。条件规则支持 `@media`、`@supports`、`@container`，不开放全局导入、字体或动画声明。旧 ChatApp 的选择器需要改成协同对应选择器，不能直接照搬。

## 存储与验证

主题元数据、外观解析和 CSS 校验位于 `features/collaboration/appearance.ts`，深色配色和子页面样式位于同目录 `appearance.css`。内置样式降低选择器优先级，确保用户 CSS 能按示例覆盖。自定义 CSS 不进入模型上下文或统计属性。

`CollaborationSettings.uiTheme` 和 `customCss` 沿用现有 IndexedDB settings 与协同备份，不增数据库版本。旧备份缺字段时使用原风格与空 CSS，未知主题回退到「角色气泡」，校验不通过的备份 CSS 不注入。

- `pnpm vitest run utils/collaboration*.test.ts`：协同回归，含外观校验、备份还原和旧配置回退。
- 浏览器预览：先生成测试样式，再启动 Vite，打开 `/test/fixtures/collaboration-appearance.html`。该页面仅使用虚构角色与本地记录，不发送模型请求；设置可保存以便刷新验证，也可用页脚按钮重置。

```sh
pnpm exec tailwindcss -i test/fixtures/collaboration-appearance.css -o output/playwright/collaboration.css --content './features/collaboration/CollaborationWindow.tsx,./components/chat/CssCodeEditor.tsx' --minify
```

预览生成的 CSS 位于忽略的 output 目录。
