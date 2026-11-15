package com.aetheros.simulator;

import android.content.Context;
import org.unifiedpush.android.connector.FailedReason;
import org.unifiedpush.android.connector.MessagingReceiver;
import org.unifiedpush.android.connector.data.PushEndpoint;
import org.unifiedpush.android.connector.data.PushMessage;

/**
 * Cold-start-safe UnifiedPush entry point.
 *
 * The connector's default receiver forwards each event through an asynchronous
 * bind to PushService. Some Android variants kill a freshly-created app process
 * after its task is swiped before that second hop completes. Handling the event
 * directly in the manifest receiver keeps decryption, durable queueing and the
 * system notification inside the BroadcastReceiver wake window.
 */
public class AmsgUnifiedPushReceiver extends MessagingReceiver {
    @Override
    public void onNewEndpoint(Context context, PushEndpoint endpoint, String instance) {
        AmsgUnifiedPushService.handleNewEndpoint(context, endpoint);
    }

    @Override
    public void onMessage(Context context, PushMessage message, String instance) {
        AmsgUnifiedPushService.handleMessage(context, message);
    }

    @Override
    public void onRegistrationFailed(Context context, FailedReason reason, String instance) {
        AmsgUnifiedPushService.handleRegistrationFailed(context, reason);
    }

    @Override
    public void onUnregistered(Context context, String instance) {
        AmsgUnifiedPushService.handleUnregistered(context);
    }
}
