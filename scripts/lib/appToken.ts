import { createHmac } from 'node:crypto'

/**
 * A proof's view of the app bridge's per-thread token (apptools.ts
 * bridgeCallRefusal): every app.* request must carry the calling thread's own
 * `appToken`. A proof gives its isolated instances E2E_APP_TOKEN_SEED as
 * TEMP_CODE_APP_TOKEN_SEED (honoured only with TEMP_CODE_USER_DATA set), and
 * then makes any thread's token here, as MacThreadTokens does in the app.
 */
export const E2E_APP_TOKEN_SEED = '5eed'.repeat(16)

/** A thread's app token under a seed (the app's MacThreadTokens with purpose `app-bridge`). */
export function appTokenFor(sessionId: string, seed = E2E_APP_TOKEN_SEED): string {
  return createHmac('sha256', Buffer.from(seed, 'hex')).update(`app-bridge:${sessionId}`).digest('base64url')
}

/** An app.* request's params with its thread's own token; any other method's params as they were. */
export function withAppToken(method: string, params: unknown, seed = E2E_APP_TOKEN_SEED): unknown {
  if (!method.startsWith('app.') || !params || typeof params !== 'object') return params
  const { sessionId } = params as { sessionId?: unknown }
  return typeof sessionId === 'string' ? { ...params, appToken: appTokenFor(sessionId, seed) } : params
}
