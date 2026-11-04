package com.aetheros.simulator;

/** Only launcher aliases are switched; MainActivity must always remain enabled. */
public final class LauncherIconController {
    public interface Backend {
        boolean enabled(String icon);
        void setEnabled(String icon, boolean enabled);
    }

    public static void select(String icon, Backend backend) {
        if (!"jellyfish".equals(icon) && !"classic".equals(icon)) {
            throw new IllegalArgumentException("Unsupported launcher icon");
        }
        String other = "classic".equals(icon) ? "jellyfish" : "classic";
        boolean wasTargetEnabled = backend.enabled(icon);
        boolean wasOtherEnabled = backend.enabled(other);
        if (wasTargetEnabled && !wasOtherEnabled) return;
        // Enable first: even if the launcher restarts us, an entry remains usable.
        backend.setEnabled(icon, true);
        try {
            backend.setEnabled(other, false);
        } catch (RuntimeException failure) {
            try {
                if (wasOtherEnabled) backend.setEnabled(other, true);
                if (!wasTargetEnabled && backend.enabled(other)) backend.setEnabled(icon, false);
            } catch (RuntimeException rollbackFailure) {
                failure.addSuppressed(rollbackFailure);
            }
            throw failure;
        }
    }
}
