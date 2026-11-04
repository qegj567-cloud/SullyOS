package com.aetheros.simulator;

import org.junit.Test;
import static org.junit.Assert.*;
import java.util.*;

public class LauncherIconControllerTest {
    static class Backend implements LauncherIconController.Backend {
        final Map<String, Boolean> values = new HashMap<>();
        final List<String> calls = new ArrayList<>();
        String failOnce;
        Backend(boolean jellyfish, boolean classic) { values.put("jellyfish", jellyfish); values.put("classic", classic); }
        public boolean enabled(String icon) { return Boolean.TRUE.equals(values.get(icon)); }
        public void setEnabled(String icon, boolean enabled) {
            String action = icon + ":" + enabled;
            calls.add(action);
            if (action.equals(failOnce)) { failOnce = null; throw new IllegalStateException("simulated failure"); }
            values.put(icon, enabled);
            assertTrue("At least one launcher entry remains enabled", enabled("jellyfish") || enabled("classic"));
        }
    }
    @Test public void switchesBothDirectionsEnableFirst() {
        Backend backend = new Backend(true, false);
        LauncherIconController.select("classic", backend);
        assertEquals(Arrays.asList("classic:true", "jellyfish:false"), backend.calls);
        backend.calls.clear();
        LauncherIconController.select("jellyfish", backend);
        assertEquals(Arrays.asList("jellyfish:true", "classic:false"), backend.calls);
    }
    @Test public void sameSelectionDoesNothing() {
        Backend backend = new Backend(false, true);
        LauncherIconController.select("classic", backend);
        assertTrue(backend.calls.isEmpty());
    }
    @Test public void unsupportedNameCannotDisableAnyComponent() {
        Backend backend = new Backend(true, false);
        try { LauncherIconController.select("MainActivity", backend); fail(); }
        catch (IllegalArgumentException expected) { assertTrue(backend.calls.isEmpty()); }
    }
    @Test public void failedEnablePreservesOriginal() {
        Backend backend = new Backend(true, false); backend.failOnce = "classic:true";
        try { LauncherIconController.select("classic", backend); fail(); }
        catch (IllegalStateException expected) { assertTrue(backend.enabled("jellyfish")); assertFalse(backend.enabled("classic")); }
    }
    @Test public void failedDisableRestoresOriginal() {
        Backend backend = new Backend(true, false); backend.failOnce = "jellyfish:false";
        try { LauncherIconController.select("classic", backend); fail(); }
        catch (IllegalStateException expected) { assertTrue(backend.enabled("jellyfish")); assertFalse(backend.enabled("classic")); }
    }
    @Test public void repairsDuplicateEntries() {
        Backend backend = new Backend(true, true);
        LauncherIconController.select("classic", backend);
        assertTrue(backend.enabled("classic")); assertFalse(backend.enabled("jellyfish"));
    }
    @Test public void repairsMissingEntry() {
        Backend backend = new Backend(false, false);
        LauncherIconController.select("jellyfish", backend);
        assertTrue(backend.enabled("jellyfish")); assertFalse(backend.enabled("classic"));
    }
}
