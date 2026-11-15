package com.aetheros.simulator;

import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Pure queue operations; the service commits the returned snapshot before emitting events. */
public final class AmsgPushQueue {
    public static JSONArray read(String raw) throws JSONException {
        JSONArray items = new JSONArray(raw);
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.getJSONObject(i);
            if (item.optString("id").isEmpty()) item.put("id", UUID.randomUUID().toString());
        }
        return items;
    }

    public static JSONArray append(JSONArray old, String payload, long now) throws JSONException {
        JSONArray next = new JSONArray();
        // Same bounded retention as the old bridge (100 messages), with per-item ACK.
        for (int i = Math.max(0, old.length() - 99); i < old.length(); i++) next.put(old.get(i));
        next.put(new JSONObject().put("id", UUID.randomUUID().toString())
            .put("payload", payload).put("receivedAt", now));
        return next;
    }

    public static JSONArray acknowledge(JSONArray old, String id) throws JSONException {
        JSONArray next = new JSONArray();
        for (int i = 0; i < old.length(); i++) {
            JSONObject item = old.getJSONObject(i);
            if (!id.equals(item.optString("id"))) next.put(item);
        }
        return next;
    }
}
