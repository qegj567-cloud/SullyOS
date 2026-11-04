import * as T from 'three';
import { defaultDinoPaint } from '../../../utils/vrWorld/dinosaurCatalog';

/** A gentle dark-purple tyrannosaurus with devil wings and a gold-banded witch hat. */
export function dressHalloweenDinosaur(root: T.Group) {
    const from = new T.Color(defaultDinoPaint('tyrannosaurus').body), to = new T.Color(defaultDinoPaint('halloween-dinosaur').body);
    const fromAccent = new T.Color(defaultDinoPaint('tyrannosaurus').accent), toAccent = new T.Color(defaultDinoPaint('halloween-dinosaur').accent);
    const delta = { r: to.r - from.r, g: to.g - from.g, b: to.b - from.b };
    const accentDelta = { r: toAccent.r - fromAccent.r, g: toAccent.g - fromAccent.g, b: toAccent.b - fromAccent.b };
    root.traverse(object => {
        if (!(object instanceof T.Mesh)) return;
        const colors = object.geometry.getAttribute('color'), uv = object.geometry.getAttribute('uv');
        for (let i = 0; i < colors.count; i++) {
            const weight = uv?.getX(i) || 0;
            // The source blends a fixed cream belly into body vertices; give
            // that blend the holiday accent too, while keeping eyes untouched.
            const accent = weight > 0 ? 1 - weight : uv?.getY(i) || 0;
            if (weight > 0) uv?.setY(i, accent);
            colors.setXYZ(i, T.MathUtils.clamp(colors.getX(i) + delta.r * weight + accentDelta.r * accent, 0, 1), T.MathUtils.clamp(colors.getY(i) + delta.g * weight + accentDelta.g * accent, 0, 1), T.MathUtils.clamp(colors.getZ(i) + delta.b * weight + accentDelta.b * accent, 0, 1));
        }
        colors.needsUpdate = true;
    });
    const add = (geometry: T.BufferGeometry, color: string, name = 'halloween-devil-wing') => {
        const count = geometry.getAttribute('position').count, shade = new T.Color(color), colors = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) shade.toArray(colors, i * 3);
        geometry.setAttribute('color', new T.BufferAttribute(colors, 3));
        // Wings keep their own colors when the dinosaur's body is repainted.
        geometry.setAttribute('uv', new T.BufferAttribute(new Float32Array(count * 2), 2));
        const mesh = new T.Mesh(geometry, new T.MeshStandardMaterial({ vertexColors: true, roughness: .95, side: T.DoubleSide }));
        mesh.name = name; root.add(mesh);
    };
    const wing = new T.Shape();
    wing.moveTo(0, -.08);
    wing.quadraticCurveTo(.08, .45, .36, .66);
    wing.quadraticCurveTo(.7, .88, 1.15, .84);
    wing.quadraticCurveTo(.98, .65, 1.2, .24);
    wing.quadraticCurveTo(.85, .48, .78, -.04);
    wing.quadraticCurveTo(.49, .25, .36, -.22);
    wing.quadraticCurveTo(.19, .03, 0, -.08);
    for (const side of [-1, 1]) {
        const matrix = new T.Matrix4().set(-.2, 0, 1, -.28, 0, 1, 0, 1.35, side, 0, 0, side * .36, 0, 0, 0, 1);
        add(new T.ExtrudeGeometry(wing, { depth: .035, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: .025, bevelThickness: .025, curveSegments: 12 }).applyMatrix4(matrix), '#564364');
        for (const points of [
            [[0,0],[.13,.42],[.36,.66],[1.15,.84]],
            [[0,0],[.29,.37],[.55,.31],[.78,-.04]],
            [[.36,.66],[.7,.62],[1.02,.52],[1.2,.24]],
        ]) {
            const curve = new T.CatmullRomCurve3(points.map(([x,y]) => new T.Vector3(x,y,.065).applyMatrix4(matrix)));
            add(new T.TubeGeometry(curve, 16, .023, 6, false), '#302637');
        }
    }
    // Bake the placement into the geometry so the hat follows the head's nod.
    add(new T.CylinderGeometry(.73, .73, .09, 32).scale(1, 1, .85).translate(.65, 2.34, 0), '#302637', 'halloween-hat-brim');
    add(new T.ConeGeometry(.49, 1.02, 32).translate(.65, 2.87, 0), '#423449', 'halloween-hat');
    add(new T.CylinderGeometry(.41, .48, .15, 32).translate(.65, 2.46, 0), '#dfb756', 'halloween-hat-band');
    add(new T.BoxGeometry(.19, .17, .055).translate(.65, 2.46, .45), '#f4d780', 'halloween-hat-buckle');
    add(new T.BoxGeometry(.10, .09, .06).translate(.65, 2.46, .48), '#8a6236', 'halloween-hat-buckle-center');
}
