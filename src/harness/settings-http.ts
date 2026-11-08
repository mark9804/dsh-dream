import { SettingsFailure } from '../settings/contracts.js';
interface FetchRoutes { register(route: { path: string; methods: string[]; requestBody: 'buffered'; fetch(request: Request): Promise<Response> }): unknown }
export interface SettingsHttpContext { connection: { fetch: FetchRoutes }; get(name: string): unknown; logger?: { error(error: unknown): void } }
const MAX_REQUEST_BYTES = 262144;
/** Exact /api Fetch routes inherit Connection authentication, origin and owner
 * checks (rc.1). Not exposed as tools; no custom credential/token handling. */
export function registerSettingsHttp(ctx: SettingsHttpContext, operations: Record<string, (input: unknown, signal: AbortSignal) => Promise<unknown>>) {
  for (const [method, operation] of Object.entries(operations)) {
    ctx.connection.fetch.register({ path: `/api/dsh-dream/${method}`, methods: ['POST'], requestBody: 'buffered', async fetch(request) {
      const headers = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' };
      try {
        if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new SettingsFailure('INVALID_REQUEST', 'Expected JSON content');
        const length = Number(request.headers.get('content-length') ?? 0);
        if (!Number.isSafeInteger(length) || length < 0 || length > MAX_REQUEST_BYTES) throw new SettingsFailure('REQUEST_TOO_LARGE', 'Settings request exceeds 256 KiB');
        const content = await request.text();
        if (Buffer.byteLength(content) > MAX_REQUEST_BYTES) throw new SettingsFailure('REQUEST_TOO_LARGE', 'Settings request exceeds 256 KiB');
        let payload: unknown;
        try { payload = JSON.parse(content); } catch { throw new SettingsFailure('INVALID_REQUEST', 'Invalid JSON content'); }
        request.signal.throwIfAborted();
        const value = await operation(payload, request.signal);
        return new Response(JSON.stringify({ ok: true, value }), { status: 200, headers });
      } catch (error) {
        const known = error instanceof SettingsFailure;
        const code = known ? error.code : error instanceof TypeError || error instanceof RangeError ? 'INVALID_CONFIGURATION' : 'UNAVAILABLE';
        const message = error instanceof Error ? error.message : String(error);
        if (!known && code === 'UNAVAILABLE') ctx.logger?.error(error);
        return new Response(JSON.stringify({ ok: false, error: { code, message, ...(known && error.details !== undefined ? { details: error.details } : {}) } }), {
          status: code === 'SETTINGS_CONFLICT' ? 409 : code === 'UNAVAILABLE' ? 503 : code === 'REQUEST_TOO_LARGE' ? 413 : 400, headers,
        });
      }
    } });
  }
}
