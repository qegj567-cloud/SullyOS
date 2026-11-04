import type {IncomingMessage, ServerResponse} from 'node:http';
// @ts-expect-error Shared runtime entry is JavaScript.
import {handleTikHub} from '../worker/index.js';

/** Dev uses exactly the same allowlist/timeout/redaction as the production Worker. */
export async function tikhubMiddleware(req: IncomingMessage, res: ServerResponse) {
    const controller = new AbortController();
    const abort = () => {if (!res.writableEnded) controller.abort();};
    res.on('close', abort);
    try {
        const response: Response = await handleTikHub(new Request(`http://localhost/tikhub${new URL(req.url || '/', 'http://localhost').search}`, {
            method: req.method, signal: controller.signal, headers: {Authorization: req.headers.authorization || ''},
        }));
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        res.end(await response.text());
    } catch {res.writeHead(502, {'Content-Type': 'application/json'}); res.end('{"error":"TikHub unavailable"}');}
    finally {res.off('close', abort);}
}
