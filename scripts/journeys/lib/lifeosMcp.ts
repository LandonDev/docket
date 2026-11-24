// Runs from the copied LifeOS worker package. Only the existing MCP listener starts.
const url = process.env.CONVEX_SELF_HOSTED_URL
const key = process.env.CONVEX_SELF_HOSTED_ADMIN_KEY
if (!url || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url) || !key?.startsWith('journey-')) {
  throw new Error('The LifeOS tools need a sandbox backend')
}
const localFetch = globalThis.fetch
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const target = new URL(input instanceof Request ? input.url : input)
  if (target.origin !== url) throw new Error('The sandbox LifeOS tools can only fetch from their backend')
  return localFetch(input, { ...init, redirect: 'error' })
}, { preconnect: () => undefined })

const { createConvex, createOwnerConvex } = await import('./src/convex')
const { Health } = await import('./src/health')
const { createTokens } = await import('./src/mcp/auth')
const { serveMcp } = await import('./src/mcp/http')
const { buildMcpServer } = await import('./src/mcp/server')
const env = { CONVEX_SELF_HOSTED_URL: url, CONVEX_SELF_HOSTED_ADMIN_KEY: key }
const admin = createConvex(env)!
const server = serveMcp({ WORKER_MCP_PORT: Number(process.argv[2]) }, createTokens({ MCP_TOKEN_NAME: 'Journey' }, admin),
  (caller) => buildMcpServer({ owner: createOwnerConvex(env, caller.ownerId)!, admin, caller }), new Health())
if (!server) throw new Error('LifeOS tools did not listen')
