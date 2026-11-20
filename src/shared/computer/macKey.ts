/**
 * The key a box thread's session goes by on the Mac, with no zod in it: the
 * renderer's first paint reads it, and contract-maccomputer.ts (zod, with
 * contract-computer.ts behind it) must not come with it.
 */

const ENV_ID = /^env_[A-Za-z0-9_-]{22}$/

export const macComputerKey = (envId: string, threadId: string): string => `${envId}:${threadId}`

export function parseMacComputerKey(key: string): { envId: string; threadId: string } | null {
  const at = key.indexOf(':')
  if (at < 0) return null
  const envId = key.slice(0, at)
  const threadId = key.slice(at + 1)
  return ENV_ID.test(envId) && threadId.length > 0 ? { envId, threadId } : null
}
