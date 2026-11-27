package com.aetheros.simulator;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.provider.AlarmClock;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Delegates to the user's clock. No AlarmManager, background service or alarm database. */
@CapacitorPlugin(name = "SystemAlarm")
public class SystemAlarmPlugin extends Plugin {
    @PluginMethod
    public void getStatus(PluginCall call) {
        try {
            JSObject result = new JSObject();
            result.put("available", new Intent(AlarmClock.ACTION_SET_ALARM)
                    .resolveActivity(getContext().getPackageManager()) != null);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("无法读取系统时钟，请重试", "ALARM_STATUS_FAILED", error);
        }
    }

    @PluginMethod
    public void createAlarm(PluginCall call) {
        Integer hour = call.getInt("hour");
        Integer minutes = call.getInt("minutes");
        String message = call.getString("message", "时光契约");
        if (hour == null || minutes == null || hour < 0 || hour > 23 || minutes < 0 || minutes > 59) {
            call.reject("请选择有效的闹钟时间", "INVALID_TIME");
            return;
        }
        if (message == null) message = "时光契约";
        if (message.length() > 160) message = message.substring(0, 160);
        Intent intent = new Intent(AlarmClock.ACTION_SET_ALARM)
                .putExtra(AlarmClock.EXTRA_HOUR, hour.intValue())
                .putExtra(AlarmClock.EXTRA_MINUTES, minutes.intValue())
                .putExtra(AlarmClock.EXTRA_MESSAGE, message)
                .putExtra(AlarmClock.EXTRA_SKIP_UI, false);
        // No EXTRA_DAYS: a calendar date cannot safely be converted to a recurring weekday.
        if (intent.resolveActivity(getContext().getPackageManager()) == null) {
            call.reject("没有可接收创建闹钟请求的时钟应用", "NO_CLOCK_APP");
            return;
        }
        if (getActivity() == null) {
            call.reject("请回到应用前台后重试", "NO_ACTIVITY");
            return;
        }
        getActivity().runOnUiThread(() -> {
            try {
                getActivity().startActivity(intent);
                JSObject result = new JSObject();
                result.put("opened", true);
                call.resolve(result); // Handoff only: clocks do not return a portable saved-alarm result.
            } catch (ActivityNotFoundException error) {
                call.reject("系统时钟暂时不可用", "NO_CLOCK_APP", error);
            } catch (SecurityException error) {
                call.reject("系统拒绝创建闹钟，请更新 APK 或检查系统时钟", "ALARM_PERMISSION", error);
            } catch (Exception error) {
                call.reject("打开系统时钟失败，请重试", "ALARM_OPEN_FAILED", error);
            }
        });
    }
}
