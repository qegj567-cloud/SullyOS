// Cloudflare requires the previously migrated class to stay exported while its namespace exists.
export class ModelRelayBudget {
  fetch(): Response {
    return new Response(null, { status: 410 });
  }
}

/** Assets-first routing serves real files directly; only missing paths reach this worker. */
export default {
  fetch(): Response {
    return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  },
};
