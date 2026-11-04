const preview = require('./chat-preview.tailwind.cjs');
module.exports = {
  ...preview,
  // Loaded with the chat modules; no global preflight/reset and no boot dependency.
  content: ['./apps/Chat.tsx', './apps/GroupChat.tsx', './components/chat/**/*.{ts,tsx}'],
};
