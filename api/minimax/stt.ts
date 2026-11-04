import { getMinimaxBaseUrl, normalizeMinimaxRegion } from '../../utils/minimaxEndpoint';

export const config = {
    api: {
        bodyParser: false,
    },
};

function readRawBody(req: any): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        if (Buffer.isBuffer(req.body)) {
            resolve(req.body);
            return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (chunk: any) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

export default async function handler(req: any, res: any) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-MiniMax-Region, X-MiniMax-API-Key, language');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const authHeader = req.headers['authorization'] || (req.headers['x-minimax-api-key'] ? `Bearer ${req.headers['x-minimax-api-key']}` : '');
        if (!authHeader) {
            return res.status(401).json({ error: 'Missing Authorization header' });
        }

        const regionHeader = req.headers['x-minimax-region'];
        const queryRegion = req.query?.region;
        const baseUrl = getMinimaxBaseUrl(normalizeMinimaxRegion(regionHeader || queryRegion));
        const targetUrl = `${baseUrl}/v1/speech_to_text`;

        const rawBody = await readRawBody(req);
        const headers: Record<string, string> = {
            Authorization: String(authHeader),
        };
        if (req.headers['content-type']) {
            headers['Content-Type'] = String(req.headers['content-type']);
        }
        if (req.headers['language']) {
            headers['language'] = String(req.headers['language']);
        }

        const response = await fetch(targetUrl, {
            method: 'POST',
            headers,
            body: new Uint8Array(rawBody),
        });

        const text = await response.text();
        res.status(response.status);
        res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
        return res.send(text);
    } catch (error: any) {
        return res.status(500).json({ error: error?.message || 'Internal Server Error' });
    }
}
