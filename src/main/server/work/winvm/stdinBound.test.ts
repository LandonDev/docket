import { describe, expect, it } from 'vitest'
import { TC_OFFICE_CS } from '../office/com/source'
import { helperCheckScript, helperCompileScript, helperHash } from './helperDoor'
import { GUEST_SCREEN_SCRIPT } from './guestScreen'
import { PS_STDIN_MAX, psStdin, runInSessionScript, WINVER_SCRIPT } from './machine/guest'
import { setupScript, startDoorScript } from './setup'
import { scriptFailure } from './sshGuest'

/**
 * Every script the host sends the guest on ssh's stdin stays under PS_STDIN_MAX: this guest's sshd loses the
 * end-of-file of a feed over about 64 KB (F-vm-files.md "The helper door's hang on wake"). Content goes across as a
 * file over scp; a builder that starts carrying it fails here before it reaches a guest.
 */
describe('scripts on stdin', () => {
  const want = helperHash(TC_OFFICE_CS)
  const scripts: Record<string, string> = {
    'the helper check': helperCheckScript(want),
    'the helper compile': helperCompileScript(want),
    setup: setupScript({ token: 'f'.repeat(64) }),
    'the door start': startDoorScript(),
    'the guest screen': GUEST_SCREEN_SCRIPT,
    winver: WINVER_SCRIPT,
    'a run in session': runInSessionScript({ argv: ['notepad.exe', 'C:\\Users\\tcuser\\Documents\\a long name.txt'], wait: true, timeoutSec: 60 }, 'tc-run-x')
  }
  it.each(Object.entries(scripts))('%s is under the bound, with room to spare', (_name, script) => {
    expect(Buffer.byteLength(script, 'utf8')).toBeLessThan(PS_STDIN_MAX / 2)
    expect(() => psStdin(script)).not.toThrow()
  })
  it("no script carries the helper's source, which alone is past the bound", () => {
    expect(Buffer.byteLength(TC_OFFICE_CS)).toBeGreaterThan(PS_STDIN_MAX)
    const b64 = Buffer.from(TC_OFFICE_CS.slice(0, 200)).toString('base64').slice(0, 64)
    for (const script of Object.values(scripts)) {
      expect(script).not.toContain(TC_OFFICE_CS.slice(0, 200))
      expect(script).not.toContain(b64)
    }
  })
  it('a script killed at its timeout says it did not answer, not "exit null"', () => {
    expect(scriptFailure({ code: null, out: '', err: '', timedOut: true }, 15_000)).toBe("the guest's script did not answer within 15 s")
    expect(scriptFailure({ code: 1, out: '', err: 'csc: CS1002' }, 15_000)).toBe("the guest's script failed (exit 1): csc: CS1002")
    expect(scriptFailure({ code: 0, out: 'ready', err: '' }, 15_000)).toBeNull()
  })
})
