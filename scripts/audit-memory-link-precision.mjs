// Synthetic, reproducible audit; no user data, database writes or API calls.
// Run: node scripts/audit-memory-link-precision.mjs
import { gzipSync } from 'node:zlib';

let state = 0x51a110;
const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const digits = [3, 4, 5, 6];
const trials = 10000;
const candidates = 200;
const results = digits.map(places => ({ places, changed: 0, overlap: 0, maxScoreLoss: 0 }));
const records = [];

for (let trial = 0; trial < trials; trial++) {
    const original = [];
    const rounded = digits.map(() => []);
    for (let id = 0; id < candidates; id++) {
        let score = 0;
        const quantized = digits.map(() => 0);
        // Same max-over-seeds scoring as spreadActivation; mix automatic emotional
        // links, temporal links and repeated +0.05 co-activation increments.
        for (let seed = 0; seed < 3; seed++) {
            const strength = Math.min(1, (random() < 0.8 ? 0.25 + random() * 0.3 : 0.3)
                + Math.floor(random() * 6) * 0.05);
            const multiplier = (0.2 + random() * 0.8) * [0.2, 0.4, 0.6, 0.8, 1][Math.floor(random() * 5)] * 0.3;
            score = Math.max(score, strength * multiplier);
            digits.forEach((places, i) => {
                quantized[i] = Math.max(quantized[i], Number(strength.toFixed(places)) * multiplier);
            });
            if (records.length < 50000) records.push({
                id: `ml_1792000000000_${String(records.length).padStart(6, '0')}`,
                sourceId: `mem_${trial}_${seed}`, targetId: `mem_${trial}_${id}`,
                type: 'emotional', strength,
            });
        }
        original.push({ id, score });
        rounded.forEach((rows, i) => rows.push({ id, score: quantized[i] }));
    }
    const scores = original.map(row => row.score);
    const top = original.sort((a, b) => b.score - a.score || a.id - b.id).slice(0, 3);
    const ids = new Set(top.map(row => row.id));
    rounded.forEach((rows, i) => {
        const selected = rows.sort((a, b) => b.score - a.score || a.id - b.id).slice(0, 3);
        const overlap = selected.filter(row => ids.has(row.id)).length;
        results[i].overlap += overlap;
        if (overlap < 3) results[i].changed++;
        results[i].maxScoreLoss = Math.max(results[i].maxScoreLoss,
            top.reduce((sum, row) => sum + row.score, 0) - selected.reduce((sum, row) => sum + scores[row.id], 0));
    });
}

const bytes = rows => Buffer.from(JSON.stringify(rows));
const before = bytes(records);
const zippedBefore = gzipSync(before).length;
console.log(JSON.stringify({ trials, candidates, seeds: 3, baselineJSONBytes: before.length, baselineGzipBytes: zippedBefore,
    results: results.map(result => {
        const after = bytes(records.map(row => ({ ...row, strength: Number(row.strength.toFixed(result.places)) })));
        return { decimals: result.places, identicalTop3Percent: 100 * (1 - result.changed / trials),
            top3OverlapPercent: 100 * result.overlap / (trials * 3), maxTop3TotalScoreLoss: result.maxScoreLoss,
            jsonBytes: after.length, jsonReductionPercent: 100 * (1 - after.length / before.length),
            gzipBytes: gzipSync(after).length, gzipReductionPercent: 100 * (1 - gzipSync(after).length / zippedBefore) };
    }),
    limitation: 'Synthetic continuous scores. Near-ties may reorder; this does not measure user-visible answer quality or IndexedDB disk usage.'
}, null, 2));
