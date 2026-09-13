import type { CharacterProfile } from '../../types';
import { DB } from '../../utils/db';
import { loadCharacterContextRange } from '../../utils/chatContextRange';
import type { CollaborationChatContextChoice, CollaborationMessage, CollaborationTransferMessage } from './types';

/** Always read storage at send time; never borrow Chat's paginated UI snapshot. */
export const loadCollaborationChatHistory = async (character: CharacterProfile, choice: CollaborationChatContextChoice) => {
  const current = await DB.getCharacter(character.id) || character;
  if (choice === 0) return { character: current, messages: [] };
  const range = await loadCharacterContextRange(current);
  const privateMessages = range.messages.filter(message => message.charId === current.id && !message.groupId);
  return { character: current, messages: choice === 'configured' ? privateMessages : privateMessages.slice(-choice) };
};

export const selectCollaborationTransfer = (
  messages: CollaborationMessage[], sessionId: string, selectedIds: Set<string>,
): CollaborationTransferMessage[] => messages
  .filter(message => message.sessionId === sessionId && selectedIds.has(message.id) && (message.role === 'user' || message.role === 'assistant'))
  .map(message => ({
    role: message.role as 'user' | 'assistant',
    type: 'text' as const,
    content: [message.content, ...(message.attachments || []).map(attachment =>
      `[文件：${attachment.name}]${attachment.extractedText ? `\n${attachment.extractedText}` : ''}`,
    )].filter(Boolean).join('\n\n'),
    timestamp: message.createdAt,
  }))
  .filter(message => !!message.content.trim());
