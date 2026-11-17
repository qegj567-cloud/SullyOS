import postOffice, { type Env } from '../../post-office/src/index';
import { recoverOwnership } from './recoverOwnership';
import { SIGNAL_ARCHIVE_REVISION } from '../../../utils/vrWorld/bifangConfig';

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const path = new URL(request.url).pathname.replace(/\/+$/, '');
        if (request.method === 'POST' && ['/poem/recover-ownership', '/po/poem/recover-ownership'].includes(path)) {
            return recoverOwnership(request, env);
        }
        // Keep postal behavior and the ended-event write gate in the shared implementation.
        const response = await postOffice.fetch(request, env);
        if (request.method === 'GET' && ['/health', '/po/health'].includes(path) && response.ok) {
            return new Response(JSON.stringify({ ...await response.json() as object, service: 'bifang', archiveRevision: SIGNAL_ARCHIVE_REVISION }), {
                status: response.status, headers: response.headers,
            });
        }
        return response;
    },
};
