import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { instancePids, type Pair } from './shape'
import { Window } from './window'

const KEYS = String.raw`
from ctypes import CDLL, c_char_p, c_int, c_uint, c_ulong, c_void_p

x11 = CDLL("libX11.so.6")
xtst = CDLL("libXtst.so.6")
x11.XOpenDisplay.argtypes = [c_char_p]
x11.XOpenDisplay.restype = c_void_p
x11.XStringToKeysym.argtypes = [c_char_p]
x11.XStringToKeysym.restype = c_ulong
x11.XKeysymToKeycode.argtypes = [c_void_p, c_ulong]
xtst.XTestFakeKeyEvent.argtypes = [c_void_p, c_uint, c_int, c_ulong]
x11.XSync.argtypes = [c_void_p, c_int]
x11.XCloseDisplay.argtypes = [c_void_p]
display = x11.XOpenDisplay(None)
if not display:
    raise SystemExit("Cannot reach win's isolated X display")
try:
    keys = [x11.XKeysymToKeycode(display, x11.XStringToKeysym(key)) for key in (b"Alt_L", b"Shift_L", b"space")]
    if not all(keys):
        raise SystemExit("The capture chord is missing from this X display")
    for key in keys:
        xtst.XTestFakeKeyEvent(display, key, 1, 0)
    for key in reversed(keys):
        xtst.XTestFakeKeyEvent(display, key, 0, 0)
    x11.XSync(display, 0)
finally:
    x11.XCloseDisplay(display)
`

export function ownedDisplay(entries: string[], data: string, tmp: string): NodeJS.ProcessEnv | null {
  if (!entries.includes('TEMP_CODE_USER_DATA=' + data)) return null
  const display = entries.find(entry => /^DISPLAY=:\d+$/.test(entry))?.slice('DISPLAY='.length)
  const authority = entries.find(entry => entry.startsWith('XAUTHORITY=' + tmp + '/xvfb-run.') && entry.endsWith('/Xauthority'))
    ?.slice('XAUTHORITY='.length)
  return display && authority ? { DISPLAY: display, XAUTHORITY: authority } : null
}

/** Capture only registers a global key on Linux. Send it to this win's own Xvfb, then use CDP for the window. */
export async function openCapture(pair: Pair): Promise<Window> {
  const { win, page } = pair
  await page.until('win to hold the Capture shortcut', 15_000, () => page.eval(
    `window.api.captureKey.get().then(({ key, held }) => held && key === 'Alt+Shift+Space')`))
  let screen: NodeJS.ProcessEnv | null = null
  for (const pid of instancePids(win.data)) {
    try {
      screen = ownedDisplay(readFileSync('/proc/' + pid + '/environ', 'utf8').split('\0'), win.data, win.tmp)
    } catch {
      continue
    }
    if (screen) break
  }
  if (!screen) throw new Error('Capture has no menu command and win’s isolated X display could not be found')
  execFileSync('/usr/bin/python3', ['-c', KEYS], { env: screen, timeout: 5000 })
  const capture = await Window.attach(win.debug!, pair.abort.signal, url => /\/capture\.html\?place=work$/.test(url), 675, 225, 15_000)
  pair.later(async () => { capture.close() })
  await capture.until('the Capture text field', 10_000, () => capture.centre('textarea', 'Capture'))
  return capture
}
