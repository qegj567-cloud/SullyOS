package com.aetheros.simulator;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;

/** Mirrors amsg-shared 0.5.0-next.0 notification intent and multipart v1. No Android UI. */
public final class AmsgPushProtocol {
    public interface Decoder { byte[] decode(String value); }
    public static final int MAX_BYTES = 256000;
    public static final int MAX_CHUNKS = 128;
    public static final long TTL_MS = 60000;

    public static boolean shouldNotify(JSONObject payload, boolean visible) {
        String kind = payload.isNull("messageKind") ? "content" : payload.optString("messageKind", "content");
        if ("_multipart".equals(kind)) return false;
        JSONObject n = payload.optJSONObject("notification");
        Object show = n == null ? null : n.opt("show");
        if (Boolean.FALSE.equals(show)) return false;
        if ("always".equals(show)) return true;
        if ("when-hidden".equals(show)) return !visible;
        return "content".equals(kind) || "result".equals(kind);
    }

    public static boolean silent(JSONObject payload, boolean visible) {
        JSONObject n = payload.optJSONObject("notification");
        Object value = n != null && !n.isNull("silent") ? n.opt("silent") : payload.opt("silent");
        return "when-visible".equals(value) ? visible : Boolean.TRUE.equals(value);
    }

    public static String text(JSONObject payload, String field, String fallback) {
        JSONObject n = payload.optJSONObject("notification");
        String value = n == null || n.isNull(field) ? "" : n.optString(field, "");
        if (value.trim().isEmpty()) value = payload.isNull(field) ? "" : payload.optString(field, "");
        return value.trim().isEmpty() ? fallback : value;
    }

    public static boolean renotify(JSONObject payload) {
        JSONObject n = payload.optJSONObject("notification");
        return n != null && !n.isNull("renotify") ? n.optBoolean("renotify") : payload.optBoolean("renotify");
    }

    /** Persist state after EVERY accepted chunk, including incomplete/rejected groups. */
    public static JSONObject restore(JSONObject state, JSONObject payload, long now, Decoder decoder) throws Exception {
        if (!"_multipart".equals(payload.optString("messageKind"))) return payload;
        JSONArray keys = state.names();
        if (keys != null) for (int i = 0; i < keys.length(); i++) {
            String key = keys.getString(i);
            JSONObject previous = state.optJSONObject(key);
            if (previous == null) state.remove(key);
            else if (previous.optLong("expiresAt") <= now) {
                if (previous.optBoolean("done")) state.remove(key);
                else { previous.put("done", true).put("expiresAt", now + TTL_MS).remove("chunks"); }
            }
        }
        JSONObject m = payload.getJSONObject("multipart");
        String id = m.getString("id");
        int total = m.getInt("total"), index = m.getInt("index");
        if (id.isEmpty() || id.length() > 256 || m.optInt("version") != 1
            || !"json-utf8-base64url".equals(m.optString("encoding"))
            || total < 1 || total > MAX_CHUNKS || index < 1 || index > total
            || m.getDouble("total") != total || m.getDouble("index") != index) throw new IllegalArgumentException("Invalid multipart envelope");
        JSONObject group = state.optJSONObject(id);
        if (group == null) {
            if (state.length() >= 16) throw new IllegalArgumentException("Too many multipart groups");
            group = new JSONObject().put("total", total).put("expiresAt", now + Math.min(TTL_MS, Math.max(1, m.optLong("ttlMs", TTL_MS))))
                .put("chunks", new JSONObject());
            state.put(id, group);
        }
        if (group.optBoolean("done")) return null;
        if (group.getInt("total") != total) { group.put("done", true).remove("chunks"); throw new IllegalArgumentException("Multipart mismatch"); }
        String chunk = payload.getString("chunk");
        JSONObject chunks = group.getJSONObject("chunks");
        String slot = Integer.toString(index);
        if (chunks.has(slot) && !chunks.getString(slot).equals(chunk)) {
            group.put("done", true).remove("chunks"); throw new IllegalArgumentException("Multipart conflict");
        }
        if (chunk.length() > MAX_BYTES * 2) { group.put("done", true).remove("chunks"); throw new IllegalArgumentException("Chunk too large"); }
        chunks.put(slot, chunk);
        int size = 0;
        try {
            for (int i = 1; i <= total; i++) if (chunks.has(Integer.toString(i))) size += decoder.decode(chunks.getString(Integer.toString(i))).length;
        } catch (RuntimeException error) { group.put("done", true).remove("chunks"); throw error; }
        if (size > MAX_BYTES) { group.put("done", true).remove("chunks"); throw new IllegalArgumentException("Multipart too large"); }
        if (chunks.length() < total) return null;
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(size);
        for (int i = 1; i <= total; i++) bytes.write(decoder.decode(chunks.getString(Integer.toString(i))));
        JSONObject restored = new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
        if ("_multipart".equals(restored.optString("messageKind"))) throw new IllegalArgumentException("Nested multipart");
        group.put("done", true).remove("chunks");
        return restored;
    }
}
