import type { Env } from '../../post-office/src/index';
import { LEGACY_POST_OFFICE_BASE, SIGNAL_ARCHIVE_REVISION as revision } from '../../../utils/vrWorld/bifangConfig';

const RETRY_MS = 60 * 60_000;
const reply = (body: object, status = 200) => new Response(JSON.stringify({ revision, ...body }), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
});
interface Recovery { completed: number; retry_at: number; token: string | null; }
interface Line { poem_id: string; seq: number; content: string; device: string; }

/** Only the fixed legacy backend can attest ownership. Never accept client-submitted claims. */
export async function recoverOwnership(request: Request, env: Env): Promise<Response> {
    if (!env.DB) return reply({ ok: false, error: 'database unavailable' }, 503);
    let device = '';
    let token = '';
    let stage = 'database';
    let legacyStatus: number | undefined;
    try {
        const raw = await request.text();
        if (raw.length > 1024) return reply({ ok: false, error: 'bad request' }, 400);
        const body = JSON.parse(raw);
        device = typeof body.device === 'string' ? body.device : '';
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(device) || ['signal-seed', 'dev-anonymous'].includes(device)) {
            return reply({ ok: false, error: 'invalid identity' }, 400);
        }
    } catch { return reply({ ok: false, error: 'bad request' }, 400); }

    try {
        const now = Date.now();
        const existing = await env.DB.prepare('SELECT completed, retry_at, token FROM po_archive_recovery WHERE device = ? AND revision = ?').bind(device, revision).first<Recovery>();
        if (existing?.completed) return reply({ ok: true, completed: true });
        if (existing && existing.retry_at > now) return reply({ ok: true, completed: false, retryAfterMs: existing.retry_at - now }, 202);
        const manifest = await env.DB.prepare('SELECT poem_count, line_count FROM po_archive_manifest WHERE revision = ?').bind(revision).first<{ poem_count: number; line_count: number }>();
        if (!manifest || manifest.poem_count < 1) return reply({ ok: false, error: 'archive not ready', retryAfterMs: RETRY_MS }, 503);

        // Bound attempts from newly minted identities without storing raw IP addresses.
        const ip = request.headers.get('CF-Connecting-IP');
        if (ip) {
            const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${env.PO_IP_SALT || 'bifang'}:${ip}`));
            const bucket = 'archive:' + [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join('');
            const count = await env.DB.prepare(`INSERT INTO po_ratelimit (bucket, count, reset_at) VALUES (?, 1, ?)
                ON CONFLICT(bucket) DO UPDATE SET count = CASE WHEN reset_at <= ? THEN 1 ELSE count + 1 END,
                reset_at = CASE WHEN reset_at <= ? THEN ? ELSE reset_at END RETURNING count`)
                .bind(bucket, now + 60_000, now, now, now + 60_000).first<{ count: number }>();
            if ((count?.count || 0) > 20) return reply({ ok: false, error: 'rate limited', retryAfterMs: 60_000 }, 429);
        }

        token = crypto.randomUUID();
        const lease = await env.DB.prepare(`INSERT INTO po_archive_recovery (device, revision, token, retry_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(device, revision) DO UPDATE SET token = excluded.token, retry_at = excluded.retry_at
            WHERE completed = 0 AND retry_at <= ? RETURNING token`)
            .bind(device, revision, token, now + 60_000, now).first<{ token: string }>();
        if (lease?.token !== token) return reply({ ok: true, completed: false, retryAfterMs: 60_000 }, 202);

        const url = new URL(`${LEGACY_POST_OFFICE_BASE}/poem/feed`);
        url.search = new URLSearchParams({ device, mine: '1', limit: '100' }).toString();
        stage = 'legacy-request';
        // Workers rejects redirect:'error' before making a request; manual preserves the same boundary.
        const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
        legacyStatus = response.status;
        if (response.status >= 300 && response.status < 400) throw new Error('legacy redirect refused');
        stage = 'legacy-json';
        const data: any = await response.json();
        stage = 'legacy-response';
        if (!response.ok || data?.ok !== true || !Array.isArray(data.poems) || data.poems.length >= 100) throw new Error('incomplete legacy response');
        const rows = (await env.DB.prepare('SELECT poem_id, seq, content, device FROM po_poem_lines').all<Line>()).results || [];
        const local = new Map(rows.map(line => [`${line.poem_id}:${line.seq}`, line]));
        stage = 'validate-claims';
        const claims: { poemId: string; seq: number; content: string }[] = [];
        const seen = new Set<string>();
        for (const poem of data.poems) {
            if (typeof poem.id !== 'string' || !Array.isArray(poem.lines) || !Number.isInteger(poem.mineCount)) throw new Error('invalid legacy poem');
            let mineCount = 0;
            for (const line of poem.lines) {
                if (!Number.isInteger(line.seq) || typeof line.content !== 'string' || typeof line.mine !== 'boolean') throw new Error('invalid legacy line');
                if (!line.mine) continue;
                mineCount++;
                const key = `${poem.id}:${line.seq}`;
                const saved = local.get(key);
                if (!saved) continue; // Ignore poems outside this archive and local admin deletions.
                if (saved.content !== line.content || (saved.device && saved.device !== device)) throw new Error('archive ownership conflict');
                if (!seen.has(key)) claims.push({ poemId: poem.id, seq: line.seq, content: line.content });
                seen.add(key);
            }
            if (mineCount !== poem.mineCount) throw new Error('incomplete ownership flags');
        }
        // One transactional batch, independent of the number of lines. Never overwrite another owner.
        stage = 'save-ownership';
        await env.DB.batch([
            env.DB.prepare(`UPDATE po_poem_lines SET device = ? WHERE (device = '' OR device = ?)
                AND EXISTS (SELECT 1 FROM json_each(?) claim WHERE json_extract(claim.value, '$.poemId') = po_poem_lines.poem_id
                    AND json_extract(claim.value, '$.seq') = po_poem_lines.seq AND json_extract(claim.value, '$.content') = po_poem_lines.content)
                AND EXISTS (SELECT 1 FROM po_archive_recovery WHERE device = ? AND revision = ? AND token = ?)`)
                .bind(device, device, JSON.stringify(claims), device, revision, token),
            env.DB.prepare('UPDATE po_archive_recovery SET completed = 1, token = NULL, retry_at = 0 WHERE device = ? AND revision = ? AND token = ?')
                .bind(device, revision, token),
        ]);
        const result = await env.DB.prepare('SELECT completed FROM po_archive_recovery WHERE device = ? AND revision = ?').bind(device, revision).first<Recovery>();
        return reply({ ok: true, completed: !!result?.completed, retryAfterMs: result?.completed ? 0 : 60_000 });
    } catch {
        if (token) await env.DB.prepare('UPDATE po_archive_recovery SET token = NULL, retry_at = ? WHERE device = ? AND revision = ? AND token = ?')
            .bind(Date.now() + RETRY_MS, device, revision, token).run().catch(() => {});
        // Do not log identity codes, legacy request URLs, or returned poems.
        return reply({ ok: false, error: 'ownership recovery unavailable', stage, legacyStatus, retryAfterMs: RETRY_MS }, 503);
    }
}
