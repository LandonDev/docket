import type { CodeBoot } from './codeChoice'

/**
 * What boot.ts picked for this launch (codeChoice.ts), as it left it on
 * `globalThis.__tempcodeCode`: null in a process boot.js did not start (a
 * test, a utility process, a script). The type alone is imported: the boot
 * code runs from the bundle and shares no module with the rest of the app.
 */
export function codeBoot(): CodeBoot | null {
  return (globalThis as { __tempcodeCode?: CodeBoot }).__tempcodeCode ?? null
}
