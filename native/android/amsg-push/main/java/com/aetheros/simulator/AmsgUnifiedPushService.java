package com.aetheros.simulator;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Base64;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.unifiedpush.android.connector.FailedReason;
import org.unifiedpush.android.connector.PushService;
import org.unifiedpush.android.connector.UnifiedPush;
import org.unifiedpush.android.connector.data.PublicKeySet;
import org.unifiedpush.android.connector.data.PushEndpoint;
import org.unifiedpush.android.connector.data.PushMessage;

public class AmsgUnifiedPushService extends PushService {
    static final String PREFS = "amsg_unified_push";
    static final String KEY_ENDPOINT = "endpoint";
    static final String KEY_P256DH = "p256dh";
    static final String KEY_AUTH = "auth";
    static final String KEY_TEMPORARY = "temporary";
    static final String KEY_DISTRIBUTOR = "distributor";
    static final String KEY_REQUESTED_VAPID = "requested_vapid";
    static final String KEY_ENDPOINT_VAPID = "endpoint_vapid";
    static final String KEY_LAST_ERROR = "last_error";
    static final String KEY_PENDING = "pending_messages";
    static final String KEY_REVISION = "registration_revision";
    static final String KEY_ACK_REVISION = "acknowledged_registration";
    private static final String KEY_MULTIPART = "multipart_v1";
    private static final String KEY_RECENT = "recent_message_ids";
    private static final String KEY_PUSH_ERROR = "last_push_error";
    static final String EXTRA_PUSH_PAYLOAD = "amsg_unified_push_payload";
    private static final String CHANNEL_ID = "amsg2";

    static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static JSObject readSubscription(Context context) {
        SharedPreferences prefs = preferences(context);
        String endpoint = prefs.getString(KEY_ENDPOINT, null);
        String p256dh = prefs.getString(KEY_P256DH, null);
        String auth = prefs.getString(KEY_AUTH, null);
        if (endpoint == null || p256dh == null || auth == null) return null;

        JSObject keys = new JSObject();
        keys.put("p256dh", p256dh);
        keys.put("auth", auth);
        JSObject result = new JSObject();
        result.put("endpoint", endpoint);
        result.put("keys", keys);
        result.put("temporary", prefs.getBoolean(KEY_TEMPORARY, false));
        result.put("distributor", prefs.getString(KEY_DISTRIBUTOR, ""));
        result.put("vapidPublicKey", prefs.getString(KEY_ENDPOINT_VAPID, prefs.getString(KEY_REQUESTED_VAPID, "")));
        return result;
    }

    static synchronized void clearSubscription(Context context) {
        preferences(context).edit()
            .remove(KEY_ENDPOINT)
            .remove(KEY_P256DH)
            .remove(KEY_AUTH)
            .remove(KEY_TEMPORARY)
            .remove(KEY_DISTRIBUTOR)
            .remove(KEY_ENDPOINT_VAPID)
            .apply();
    }

    static synchronized JSONArray peekPending(Context context) throws JSONException {
        SharedPreferences prefs = preferences(context);
        JSONArray pending = AmsgPushQueue.read(prefs.getString(KEY_PENDING, "[]"));
        if (!prefs.edit().putString(KEY_PENDING, pending.toString()).commit()) throw new IllegalStateException("Queue commit failed");
        return pending;
    }

    static synchronized void acknowledge(Context context, String id) throws JSONException {
        SharedPreferences prefs = preferences(context);
        JSONArray next = AmsgPushQueue.acknowledge(AmsgPushQueue.read(prefs.getString(KEY_PENDING, "[]")), id);
        if (!prefs.edit().putString(KEY_PENDING, next.toString()).commit()) throw new IllegalStateException("Queue commit failed");
    }

    @Override
    public void onNewEndpoint(PushEndpoint endpoint, String instance) {
        handleNewEndpoint(this, endpoint);
    }

    static synchronized void handleNewEndpoint(Context context, PushEndpoint endpoint) {
        PublicKeySet keys = endpoint.getPubKeySet();
        if (keys == null) {
            preferences(context).edit().putString(KEY_LAST_ERROR, "Distributor 没有返回 Web Push 加密密钥").apply();
            AmsgUnifiedPushPlugin.emitRegistrationChanged();
            return;
        }
        String distributor = UnifiedPush.getAckDistributor(context);
        SharedPreferences prefs = preferences(context);
        boolean changed = !endpoint.getUrl().equals(prefs.getString(KEY_ENDPOINT, ""))
            || !keys.getPubKey().equals(prefs.getString(KEY_P256DH, ""))
            || !keys.getAuth().equals(prefs.getString(KEY_AUTH, ""))
            || !prefs.getString(KEY_REQUESTED_VAPID, "").equals(prefs.getString(KEY_ENDPOINT_VAPID, ""));
        SharedPreferences.Editor edit = prefs.edit();
        if (changed || !prefs.contains(KEY_REVISION)) edit.putString(KEY_REVISION, UUID.randomUUID().toString());
        edit
            .putString(KEY_ENDPOINT, endpoint.getUrl())
            .putString(KEY_P256DH, keys.getPubKey())
            .putString(KEY_AUTH, keys.getAuth())
            .putString(KEY_ENDPOINT_VAPID, prefs.getString(KEY_REQUESTED_VAPID, ""))
            .putBoolean(KEY_TEMPORARY, endpoint.getTemporary())
            .putString(KEY_DISTRIBUTOR, distributor == null ? "" : distributor)
            .remove(KEY_LAST_ERROR)
            .commit();
        AmsgUnifiedPushPlugin.emitRegistrationChanged();
    }

    @Override
    public void onMessage(PushMessage message, String instance) {
        handleMessage(this, message);
    }

    static synchronized void handleMessage(Context context, PushMessage message) {
        SharedPreferences prefs = preferences(context);
        JSONObject state = new JSONObject();
        try {
            if (message.getContent().length > AmsgPushProtocol.MAX_BYTES) throw new IllegalArgumentException("Push too large");
            state = new JSONObject(prefs.getString(KEY_MULTIPART, "{}"));
            JSONObject incoming = new JSONObject(new String(message.getContent(), StandardCharsets.UTF_8));
            JSONObject payload;
            try {
                payload = AmsgPushProtocol.restore(state, incoming, System.currentTimeMillis(),
                    value -> Base64.decode(value, Base64.URL_SAFE | Base64.NO_WRAP));
            } catch (Exception error) {
                prefs.edit().putString(KEY_MULTIPART, state.toString()).commit();
                throw error;
            }
            if (payload == null) {
                if (!prefs.edit().putString(KEY_MULTIPART, state.toString()).commit()) throw new IllegalStateException("Multipart commit failed");
                return;
            }
            String id = payload.optString("messageId", "");
            if (id.isEmpty()) { id = UUID.randomUUID().toString(); payload.put("messageId", id); }
            JSONArray recent = new JSONArray(prefs.getString(KEY_RECENT, "[]"));
            for (int i = 0; !id.isEmpty() && i < recent.length(); i++) {
                if (id.equals(recent.optString(i))) {
                    prefs.edit().putString(KEY_MULTIPART, state.toString()).commit();
                    return;
                }
            }
            String raw = payload.toString();
            JSONArray pending = AmsgPushQueue.append(AmsgPushQueue.read(prefs.getString(KEY_PENDING, "[]")), raw, System.currentTimeMillis());
            JSONArray nextRecent = new JSONArray();
            for (int i = Math.max(0, recent.length() - 99); i < recent.length(); i++) nextRecent.put(recent.get(i));
            if (!id.isEmpty()) nextRecent.put(id);
            // Assembly completion, duplicate marker and queue entry are ONE durable commit.
            if (!prefs.edit().putString(KEY_PENDING, pending.toString()).putString(KEY_MULTIPART, state.toString())
                .putString(KEY_RECENT, nextRecent.toString()).remove(KEY_PUSH_ERROR).commit()) throw new IllegalStateException("Push commit failed");
            String outcome;
            try { outcome = showNotification(context, raw); }
            catch (Exception error) { outcome = "failed"; }
            pending.getJSONObject(pending.length() - 1).put("notificationOutcome", outcome)
                .put("notificationAt", System.currentTimeMillis());
            // Queue was already durable before notify(). If killed between the two commits,
            // retain receipt evidence but never invent a successful notification outcome.
            if (!prefs.edit().putString(KEY_PENDING, pending.toString()).commit()) throw new IllegalStateException("Receipt commit failed");
            AmsgUnifiedPushPlugin.emitPush(raw);
        } catch (Exception error) {
            // No payload, endpoint, token or private chat content in diagnostics.
            prefs.edit().putString(KEY_PUSH_ERROR, "原生推送接收失败（" + error.getClass().getSimpleName() + "）").commit();
        }
    }

    @Override
    public void onRegistrationFailed(FailedReason reason, String instance) {
        handleRegistrationFailed(this, reason);
    }

    static void handleRegistrationFailed(Context context, FailedReason reason) {
        preferences(context).edit().putString(KEY_LAST_ERROR, reason.name()).apply();
        AmsgUnifiedPushPlugin.emitRegistrationChanged();
    }

    @Override
    public void onUnregistered(String instance) {
        handleUnregistered(this);
    }

    static void handleUnregistered(Context context) {
        clearSubscription(context);
        AmsgUnifiedPushPlugin.emitRegistrationChanged();
    }

    private static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "主动消息",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("角色主动消息与定时消息");
        manager.createNotificationChannel(channel);
    }

    static String showNotification(Context context, String rawPayload) {
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return "permission-denied";

        String title = "主动消息";
        String body = "收到一条新消息";
        String messageId = String.valueOf(System.currentTimeMillis());
        String tag;
        boolean silent;
        boolean renotify;
        try {
            JSONObject payload = new JSONObject(rawPayload);
            if (!AmsgPushProtocol.shouldNotify(payload, AmsgUnifiedPushPlugin.isVisible())) return "policy-skipped";
            String charName = payload.optString("contactName", payload.optJSONObject("metadata") == null
                ? "主动消息"
                : payload.optJSONObject("metadata").optString("charName", "主动消息"));
            title = AmsgPushProtocol.text(payload, "title", charName);
            body = AmsgPushProtocol.text(payload, "body", payload.optString("message", body));
            messageId = payload.optString("messageId", messageId);
            tag = AmsgPushProtocol.text(payload, "tag", messageId);
            silent = AmsgPushProtocol.silent(payload, AmsgUnifiedPushPlugin.isVisible());
            renotify = AmsgPushProtocol.renotify(payload);
        } catch (JSONException ignored) { return "invalid"; }

        ensureChannel(context);
        Intent openIntent = new Intent(context, MainActivity.class);
        openIntent.setAction("amsg2.open." + messageId);
        openIntent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        openIntent.putExtra(EXTRA_PUSH_PAYLOAD, rawPayload);
        int requestCode = messageId.hashCode() & 0x7fffffff;
        PendingIntent pendingIntent = PendingIntent.getActivity(
            context,
            requestCode,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        NotificationCompat.Builder notification = new NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setSilent(silent)
            .setOnlyAlertOnce(!renotify)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent);
        NotificationManagerCompat.from(context).notify(tag, 0, notification.build());
        return "requested";
    }
}
