export type CameraZoom = { min: number; max: number; step: number; value: number; hardware: boolean };
export function cameraZoomRange(track: MediaStreamTrack): CameraZoom {
    try {
        const caps = track.getCapabilities?.() as MediaTrackCapabilities & { zoom?: { min: number; max: number; step?: number } };
        const range = caps?.zoom;
        if (range && Number.isFinite(range.min) && Number.isFinite(range.max) && range.min > 0 && range.max > range.min && track.applyConstraints) {
            return { min: range.min, max: range.max, step: range.step || 0.1, value: Math.max(range.min, Math.min(range.max, 1)), hardware: true };
        }
    } catch {}
    return { min: 1, max: 3, step: 0.1, value: 1, hardware: false };
}
export async function applyCameraZoom(track: MediaStreamTrack, value: number) {
    await track.applyConstraints({ ...track.getConstraints?.(), advanced: [{ zoom: value } as MediaTrackConstraintSet] });
}
