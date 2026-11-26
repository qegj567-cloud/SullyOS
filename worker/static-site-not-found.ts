/** Assets-first routing serves real files directly; only missing paths reach this worker. */
export default {
  fetch(): Response {
    return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  },
};
