import { DB } from './db';
import { ActiveMsgStore } from './activeMsgStore';

let initialized = false;

const flushInboxToChat = async () => {
  const pendingMessages = await ActiveMsgStore.consumeInboxMessages();
  for (const message of pendingMessages) {
    const messageTimestamp = message.sentAt || message.receivedAt || Date.now();
    await DB.saveMessage({
      charId: message.charId,
      role: 'assistant',
      type: 'text',
      content: message.body,
      timestamp: messageTimestamp,
      metadata: {
        source: 'active_msg_2',
        activeMsg2: {
          messageId: message.messageId,
          taskId: message.taskId,
          messageType: message.messageType,
          messageSubtype: message.messageSubtype,
          avatarUrl: message.avatarUrl,
          sentAt: message.sentAt,
          receivedAt: message.receivedAt,
        },
        ...(message.metadata || {}),
      },
    });

    window.dispatchEvent(new CustomEvent('active-msg-received', {
      detail: {
        charId: message.charId,
        charName: message.charName,
        body: message.body,
        avatarUrl: message.avatarUrl,
        sentAt: messageTimestamp,
      },
    }));
  }
};

const handleDeepLink = () => {
  const currentUrl = new URL(window.location.href);
  const charId = currentUrl.searchParams.get('activeMsgCharId');
  const openApp = currentUrl.searchParams.get('openApp');

  if (openApp === 'chat' && charId) {
    window.dispatchEvent(new CustomEvent('active-msg-open', {
      detail: { charId },
    }));
    currentUrl.searchParams.delete('openApp');
    currentUrl.searchParams.delete('activeMsgCharId');
    window.history.replaceState({}, '', currentUrl.toString());
  }
};

export const ActiveMsgRuntime = {
  async init() {
    if (initialized) return;
    initialized = true;

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (event) => {
        const type = event.data?.type;
        if (type === 'active-msg-received') {
          void flushInboxToChat();
          return;
        }

        if (type === 'active-msg-open') {
          void flushInboxToChat().then(() => {
            window.dispatchEvent(new CustomEvent('active-msg-open', {
              detail: { charId: event.data?.charId },
            }));
          });
        }
      });
    }

    await flushInboxToChat();
    handleDeepLink();
  },
};
