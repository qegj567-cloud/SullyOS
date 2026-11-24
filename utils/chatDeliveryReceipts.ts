/** No message text is retained. The accepted version may have fewer bubbles, or none. */
export const calibratedDeliveryPrefix = 'chat_calibrated_delivery:';
export const calibratedDeliveryKey = (charId: string, messageId: string) =>
    calibratedDeliveryPrefix + JSON.stringify([charId, messageId]);
