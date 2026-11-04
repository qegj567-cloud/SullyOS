/** Five decimals keep the max weight error at 0.000005. See the reproducible
 * simulation in scripts/audit-memory-link-precision.mjs. Only weights change:
 * IDs, endpoints, types, and even unknown legacy fields survive unchanged. */
export function compactMemoryLink<T extends { strength: number }>(link: T): T {
    if (!Number.isFinite(link.strength) || link.strength < 0 || link.strength > 1) return link;
    const strength = Number(link.strength.toFixed(5));
    return strength === link.strength ? link : { ...link, strength };
}
