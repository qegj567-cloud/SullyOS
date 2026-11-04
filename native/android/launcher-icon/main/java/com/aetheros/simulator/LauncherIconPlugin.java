package com.aetheros.simulator;

import android.content.ComponentName;
import android.content.pm.PackageManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;

@CapacitorPlugin(name = "LauncherIcon")
public class LauncherIconPlugin extends Plugin {
    private ComponentName alias(String icon) {
        if (!"jellyfish".equals(icon) && !"classic".equals(icon)) {
            throw new IllegalArgumentException("Unsupported launcher icon");
        }
        return new ComponentName(getContext(), getContext().getPackageName()
                + ("classic".equals(icon) ? ".LauncherClassic" : ".LauncherJellyfish"));
    }

    private final LauncherIconController.Backend backend = new LauncherIconController.Backend() {
        public boolean enabled(String icon) {
            int state = getContext().getPackageManager().getComponentEnabledSetting(alias(icon));
            return state == PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                    || (state == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT && "jellyfish".equals(icon));
        }

        public void setEnabled(String icon, boolean enabled) {
            getContext().getPackageManager().setComponentEnabledSetting(alias(icon),
                    enabled ? PackageManager.COMPONENT_ENABLED_STATE_ENABLED : PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                    PackageManager.DONT_KILL_APP);
        }
    };

    private JSObject status() {
        boolean jellyfish = backend.enabled("jellyfish");
        boolean classic = backend.enabled("classic");
        JSObject result = new JSObject();
        result.put("icon", jellyfish == classic ? JSONObject.NULL : classic ? "classic" : "jellyfish");
        return result;
    }

    @PluginMethod
    public synchronized void getIcon(PluginCall call) {
        try { call.resolve(status()); }
        catch (Exception error) { call.reject("无法读取桌面图标，请重试", "ICON_READ_FAILED", error); }
    }

    @PluginMethod
    public synchronized void setIcon(PluginCall call) {
        String icon = call.getString("icon");
        if (!"jellyfish".equals(icon) && !"classic".equals(icon)) {
            call.reject("只支持水母或经典图标", "INVALID_ICON");
            return;
        }
        try {
            LauncherIconController.select(icon, backend);
            call.resolve(status());
        } catch (Exception error) { call.reject("图标切换未完成，请重试", "ICON_CHANGE_FAILED", error); }
    }
}
