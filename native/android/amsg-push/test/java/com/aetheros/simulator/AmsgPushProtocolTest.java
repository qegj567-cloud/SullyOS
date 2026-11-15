package com.aetheros.simulator;

import static org.junit.Assert.*;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class AmsgPushProtocolTest {
    private final AmsgPushProtocol.Decoder decoder = value -> Base64.getUrlDecoder().decode(value);
    private JSONObject restore(JSONObject state, JSONObject part, long now) throws Exception {
        return AmsgPushProtocol.restore(state, part, now, decoder);
    }
    private JSONObject part(String id, int index, int total, byte[] bytes) throws Exception {
        return new JSONObject().put("messageKind", "_multipart").put("chunk", Base64.getUrlEncoder().withoutPadding().encodeToString(bytes))
            .put("multipart", new JSONObject().put("id", id).put("version", 1).put("index", index).put("total", total)
                .put("encoding", "json-utf8-base64url").put("ttlMs", 60000));
    }

    @Test public void notificationIntentMatchesMaster() throws Exception {
        for (String kind : new String[]{"content", "result", "emotion_update", "error", "reasoning", "tools"}) {
            JSONObject p = new JSONObject().put("messageKind", kind);
            assertEquals(kind.equals("content") || kind.equals("result"), AmsgPushProtocol.shouldNotify(p, false));
            p.put("notification", new JSONObject().put("show", false));
            assertFalse(AmsgPushProtocol.shouldNotify(p, false));
            p.put("notification", new JSONObject().put("show", "when-hidden"));
            assertTrue(AmsgPushProtocol.shouldNotify(p, false));
            assertFalse(AmsgPushProtocol.shouldNotify(p, true));
            p.put("notification", new JSONObject().put("show", "always"));
            assertTrue(AmsgPushProtocol.shouldNotify(p, true));
        }
        assertTrue(AmsgPushProtocol.shouldNotify(new JSONObject(), false));
        assertTrue(AmsgPushProtocol.shouldNotify(new JSONObject().put("messageKind", JSONObject.NULL), false));
        assertFalse(AmsgPushProtocol.shouldNotify(new JSONObject().put("messageKind", "_multipart"), false));
    }

    @Test public void usesPrivacyPreviewAndNotificationOverrides() throws Exception {
        JSONObject p = new JSONObject().put("body", "private").put("tag", "legacy").put("renotify", true)
            .put("notification", new JSONObject().put("body", "房间里有消息").put("tag", "char-c").put("renotify", false).put("silent", "when-visible"));
        assertEquals("房间里有消息", AmsgPushProtocol.text(p, "body", "fallback"));
        assertEquals("char-c", AmsgPushProtocol.text(p, "tag", "fallback"));
        assertFalse(AmsgPushProtocol.renotify(p));
        assertTrue(AmsgPushProtocol.silent(p, true));
        assertFalse(AmsgPushProtocol.silent(p, false));
        assertEquals("fallback", AmsgPushProtocol.text(p, "title", "fallback"));
        p.put("silent", true);
        p.put("notification", new JSONObject().put("silent", JSONObject.NULL).put("renotify", JSONObject.NULL).put("body", JSONObject.NULL));
        assertTrue(AmsgPushProtocol.silent(p, false));
        assertTrue(AmsgPushProtocol.renotify(p));
        assertEquals("private", AmsgPushProtocol.text(p, "body", "fallback"));
    }

    @Test public void outOfOrderUnicodeRestoresAcrossPersistedSnapshotsOnlyOnce() throws Exception {
        byte[] bytes = new JSONObject().put("messageKind", "content").put("message", "你好🌊").toString().getBytes(StandardCharsets.UTF_8);
        int split = bytes.length - 3; // deliberately splits UTF-8, not Java strings
        JSONObject a = part("id", 1, 2, Arrays.copyOfRange(bytes, 0, split));
        JSONObject b = part("id", 2, 2, Arrays.copyOfRange(bytes, split, bytes.length));
        JSONObject state = new JSONObject();
        assertNull(restore(state, b, 1));
        state = new JSONObject(state.toString());
        assertNull(restore(state, b, 2));
        assertEquals("你好🌊", restore(state, a, 3).getString("message"));
        assertNull(restore(state, a, 4));
    }

    @Test public void expiredAssemblyCannotRestartFromLateChunk() throws Exception {
        JSONObject state = new JSONObject();
        JSONObject a = part("id", 1, 2, "{".getBytes(StandardCharsets.UTF_8));
        JSONObject b = part("id", 2, 2, "}".getBytes(StandardCharsets.UTF_8));
        assertNull(restore(state, a, 0));
        assertNull(restore(state, b, 60001));
        assertNull(restore(state, a, 60002));
    }

    @Test public void conflictingChunkRejectsWholeGroup() throws Exception {
        JSONObject state = new JSONObject();
        assertNull(restore(state, part("id", 1, 2, new byte[]{1}), 0));
        assertThrows(IllegalArgumentException.class, () -> restore(state, part("id", 1, 2, new byte[]{2}), 1));
        assertNull(restore(state, part("id", 2, 2, new byte[]{3}), 2));
    }

    @Test public void rejectsOversizedAndInvalidEnvelopes() throws Exception {
        assertThrows(IllegalArgumentException.class, () -> restore(new JSONObject(), part("id", 1, 129, new byte[]{1}), 0));
        assertThrows(IllegalArgumentException.class, () -> restore(new JSONObject(), part("id", 0, 2, new byte[]{1}), 0));
        assertThrows(IllegalArgumentException.class, () -> restore(new JSONObject(), part("id", 1, 1, new byte[256001]), 0));
        JSONObject wrong = part("id", 1, 1, "{}".getBytes(StandardCharsets.UTF_8));
        wrong.getJSONObject("multipart").put("encoding", "gzip");
        assertThrows(IllegalArgumentException.class, () -> restore(new JSONObject(), wrong, 0));
    }

    @Test public void queueMigratesOldEntriesAndAcknowledgesOnlyOne() throws Exception {
        JSONArray queue = AmsgPushQueue.read("[{\"payload\":\"old\",\"receivedAt\":1}]");
        String oldId = queue.getJSONObject(0).getString("id");
        queue = AmsgPushQueue.read(queue.toString());
        assertEquals(oldId, queue.getJSONObject(0).getString("id"));
        queue = AmsgPushQueue.append(queue, "new", 2);
        assertEquals(2, AmsgPushQueue.acknowledge(queue, "missing").length());
        queue = AmsgPushQueue.acknowledge(queue, oldId);
        assertEquals(1, queue.length());
        assertEquals("new", queue.getJSONObject(0).getString("payload"));
    }

    @Test public void queueRetentionRemainsBounded() throws Exception {
        JSONArray queue = new JSONArray();
        for (int i = 0; i < 105; i++) queue = AmsgPushQueue.append(queue, "msg-" + i, i);
        assertEquals(100, queue.length());
        assertEquals("msg-5", queue.getJSONObject(0).getString("payload"));
        assertEquals("msg-104", queue.getJSONObject(99).getString("payload"));
    }
}
