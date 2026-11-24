import type { Message } from '../types';

// When a format-only repair clears the whole reply, keep just the cloud delivery IDs.
export const emptyDeliveryKey = (charId: string) => `chat_empty_deliveries:${charId}`;
export function deliveryReceipts(meta: Message['metadata']): string[] {
    return [...new Set<string>([meta?.activeMsg2?.messageId, ...(Array.isArray(meta?.calibratedDeliveryIds) ? meta.calibratedDeliveryIds : [])]
        .filter(id => typeof id === 'string' && id.length > 0))];
}
