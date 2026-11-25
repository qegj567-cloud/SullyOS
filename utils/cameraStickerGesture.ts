export interface StickerTransform { x: number; y: number; size: number; angle: number }
export interface CameraPoint { x: number; y: number }
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
export const stickerAngle = (angle: number) => ((angle + 180) % 360 + 360) % 360 - 180;

/** Transform a pivot in frame pixels around the midpoint of two fingers. */
export function transformAroundFingers(before: CameraPoint[], after: CameraPoint[], pivot: CameraPoint, size: number, angle: number, minSize: number, maxSize: number) {
    const dx = before[1].x - before[0].x, dy = before[1].y - before[0].y;
    const nextDx = after[1].x - after[0].x, nextDy = after[1].y - after[0].y;
    const distance = Math.hypot(dx, dy), nextDistance = Math.hypot(nextDx, nextDy);
    if (distance < 2 || nextDistance < 2) return null;
    const nextSize = clamp(size * nextDistance / distance, minSize, maxSize);
    const ratio = nextSize / size;
    const turn = Math.atan2(nextDy, nextDx) - Math.atan2(dy, dx);
    const px = pivot.x - (before[0].x + before[1].x) / 2, py = pivot.y - (before[0].y + before[1].y) / 2;
    return {
        x: (after[0].x + after[1].x) / 2 + ratio * (px * Math.cos(turn) - py * Math.sin(turn)),
        y: (after[0].y + after[1].y) / 2 + ratio * (px * Math.sin(turn) + py * Math.cos(turn)),
        size: nextSize, angle: stickerAngle(angle + turn * 180 / Math.PI),
    };
}

/** Points are in photo pixels, after removing the frame's paper margins. */
export class CameraStickerGesture {
    private points = new Map<number, CameraPoint>();
    private baseline: { transform: StickerTransform; points: CameraPoint[] };
    current: StickerTransform;
    constructor(readonly id: number, transform: StickerTransform, private width: number, private height: number, private maxSize: number) {
        this.current = {...transform}; this.baseline = {transform:this.current,points:[]};
    }
    get count() {return this.points.size;}
    has(pointerId: number) {return this.points.has(pointerId);}
    private rebase() {this.baseline = {transform:{...this.current},points:[...this.points.values()]};}
    add(pointerId: number, point: CameraPoint) {
        if (this.points.size >= 2 || this.points.has(pointerId)) return false;
        this.points.set(pointerId,point); this.rebase(); return true;
    }
    move(pointerId: number, point: CameraPoint): StickerTransform | null {
        if (!this.points.has(pointerId)) return null;
        this.points.set(pointerId,point);
        const before=this.baseline.points, after=[...this.points.values()], original=this.baseline.transform;
        let x=original.x*this.width, y=original.y*this.height, size=original.size, angle=original.angle;
        if (after.length === 1) {x += after[0].x-before[0].x; y += after[0].y-before[0].y;}
        else {
            const result = transformAroundFingers(before, after, {x, y}, size, angle, 0.08, this.maxSize);
            if (!result) { this.rebase(); return this.current; }
            ({x, y, size, angle} = result);
        }
        this.current={x:clamp(x/this.width,0.05,0.95),y:clamp(y/this.height,0.05,0.95),size,angle};
        return this.current;
    }
    remove(pointerId: number) {
        if (!this.points.delete(pointerId)) return false;
        // Continue dragging with the remaining finger without jumping back.
        this.rebase(); return true;
    }
}
