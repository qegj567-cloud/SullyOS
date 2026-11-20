package com.aetheros.simulator;

import static org.unifiedpush.android.connector.ConstantsKt.INSTANCE_DEFAULT;

import android.content.Intent;
import android.content.SharedPreferences;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.unifiedpush.android.connector.UnifiedPush;

@CapacitorPlugin(name = "AmsgUnifiedPush")
public class AmsgUnifiedPushPlugin extends Plugin {
    private static volatile AmsgUnifiedPushPlugin activeInstance;
    private static volatile boolean visible;

    static boolean isVisible() { return visible; }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        visible = true;
        notifyListeners("foreground", new JSObject(), true);
    }

    @Override
    protected void handleOnPause() {
        visible = false;
        super.handleOnPause();
    }

    @Override
    protected void handleOnDestroy() {
        if (activeInstance == this) { activeInstance = null; visible = false; }
        super.handleOnDestroy();
    }

    @Override
    public void load() {
        activeInstance = this;
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        String payload = intent == null ? null : intent.getStringExtra(AmsgUnifiedPushService.EXTRA_PUSH_PAYLOAD);
        if (payload == null || payload.isEmpty()) return;
        intent.removeExtra(AmsgUnifiedPushService.EXTRA_PUSH_PAYLOAD);
        JSObject event = new JSObject();
        event.put("payload", payload);
        notifyListeners("notificationTapped", event, true);
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        List<String> distributors = UnifiedPush.getDistributors(getContext());
        String distributor = UnifiedPush.getAckDistributor(getContext());
        JSObject result = new JSObject();
        result.put("native", true);
        result.put("bridgeVersion", 2);
        SharedPreferences prefs = AmsgUnifiedPushService.preferences(getContext());
        result.put("registrationRevision", prefs.getString(AmsgUnifiedPushService.KEY_REVISION, ""));
        result.put("acknowledgedRegistration", prefs.getString(AmsgUnifiedPushService.KEY_ACK_REVISION, ""));
        result.put("distributors", new JSArray(distributors));
        result.put("distributor", distributor == null ? JSONObject.NULL : distributor);
        JSObject subscription = AmsgUnifiedPushService.readSubscription(getContext());
        result.put("subscription", subscription == null ? JSONObject.NULL : subscription);
        String error = AmsgUnifiedPushService.preferences(getContext()).getString(AmsgUnifiedPushService.KEY_LAST_ERROR, null);
        result.put("lastError", error == null ? JSONObject.NULL : error);
        call.resolve(result);
    }

    @PluginMethod
    public void register(PluginCall call) {
        String vapidPublicKey = call.getString("vapidPublicKey", "").trim();
        if (vapidPublicKey.isEmpty()) {
            call.reject("Worker VAPID 公钥为空");
            return;
        }

        List<String> distributors = UnifiedPush.getDistributors(getContext());
        String distributor = UnifiedPush.getAckDistributor(getContext());
        if (distributor == null) {
            if (distributors.isEmpty()) {
                call.reject("没有安装 UnifiedPush 服务；请先安装 ntfy");
                return;
            }
            // ntfy 是 SullyOS 推荐的无 GMS 通道；有多个 distributor 时优先它，
            // 否则选择系统返回的第一个。设置页可在后续版本补完整切换器。
            distributor = distributors.get(0);
            for (String candidate : distributors) {
                if (candidate.toLowerCase().contains("ntfy")) {
                    distributor = candidate;
                    break;
                }
            }
            UnifiedPush.saveDistributor(getContext(), distributor);
        }

        SharedPreferences prefs = AmsgUnifiedPushService.preferences(getContext());
        SharedPreferences.Editor edit = prefs.edit();
        // Migrate the VAPID attached to the EXISTING endpoint before changing the request.
        // Otherwise ensureUnifiedPushSubscription could mistake old keys for a new registration.
        if (!prefs.contains(AmsgUnifiedPushService.KEY_ENDPOINT_VAPID) && prefs.contains(AmsgUnifiedPushService.KEY_ENDPOINT)) {
            edit.putString(AmsgUnifiedPushService.KEY_ENDPOINT_VAPID,
                prefs.getString(AmsgUnifiedPushService.KEY_REQUESTED_VAPID, ""));
        }
        edit
            .putString(AmsgUnifiedPushService.KEY_REQUESTED_VAPID, vapidPublicKey)
            .remove(AmsgUnifiedPushService.KEY_LAST_ERROR)
            .apply();
        UnifiedPush.register(getContext(), INSTANCE_DEFAULT, "SullyOS 主动消息 2.0", vapidPublicKey);

        JSObject result = new JSObject();
        result.put("pending", true);
        call.resolve(result);
    }

    @PluginMethod
    public void unregister(PluginCall call) {
        UnifiedPush.unregister(getContext(), INSTANCE_DEFAULT);
        AmsgUnifiedPushService.clearSubscription(getContext());
        call.resolve();
    }

    @PluginMethod
    public void drainPendingPushes(PluginCall call) {
        // Legacy name retained; bridge v2 never clears unread messages in bulk.
        peekPendingPushes(call);
    }

    @PluginMethod
    public void acknowledgePush(PluginCall call) {
        String id = call.getString("id", "");
        if (id.isEmpty()) { call.reject("Queue ID missing"); return; }
        try {
            AmsgUnifiedPushService.acknowledge(getContext(), id);
            call.resolve();
        } catch (Exception error) { call.reject("Queue acknowledgement failed"); }
    }

    @PluginMethod
    public void acknowledgeRegistration(PluginCall call) {
        String revision = call.getString("revision", "");
        if (revision.isEmpty()) { call.reject("Registration revision missing"); return; }
        // Store the revision actually sent, NOT the possibly newer current endpoint's revision.
        if (AmsgUnifiedPushService.preferences(getContext()).edit()
            .putString(AmsgUnifiedPushService.KEY_ACK_REVISION, revision).commit()) call.resolve();
        else call.reject("Registration acknowledgement failed");
    }

    @PluginMethod
    public void peekPendingPushes(PluginCall call) {
        JSObject result = new JSObject();
        JSONArray pending;
        try { pending = AmsgUnifiedPushService.peekPending(getContext()); }
        catch (Exception error) { call.reject("Queue read failed"); return; }
        result.put("messages", JSArray.from(pending));

        Intent intent = getActivity().getIntent();
        String launchPayload = intent == null ? null : intent.getStringExtra(AmsgUnifiedPushService.EXTRA_PUSH_PAYLOAD);
        if (launchPayload != null && !launchPayload.isEmpty()) {
            result.put("launchPayload", launchPayload);
            intent.removeExtra(AmsgUnifiedPushService.EXTRA_PUSH_PAYLOAD);
        }
        call.resolve(result);
    }

    static void emitPush(String payload) {
        AmsgUnifiedPushPlugin plugin = activeInstance;
        if (plugin == null) return;
        JSObject event = new JSObject();
        event.put("payload", payload);
        plugin.notifyListeners("pushReceived", event, true);
    }

    static void emitRegistrationChanged() {
        AmsgUnifiedPushPlugin plugin = activeInstance;
        if (plugin == null) return;
        plugin.notifyListeners("registrationChanged", new JSObject(), true);
    }
}
