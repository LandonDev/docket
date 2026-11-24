import { writeFileSync } from 'node:fs'
import { attach, sleep, type Cdp } from '../../e2e-work-lib'

export async function until(label: string, ms: number, test: () => unknown | Promise<unknown>, signal?: AbortSignal): Promise<void> {
  const end = Date.now() + ms
  do {
    signal?.throwIfAborted()
    if (await test()) return
    await sleep(Math.min(200, Math.max(0, end - Date.now())))
  } while (Date.now() < end)
  throw new Error(`Timed out waiting for ${label}`)
}

type Point = { x: number; y: number }
const ROLES: Record<string, string> = {
  button: 'button, [role="button"]',
  link: 'a[href], [role="link"]',
  tab: '[role="tab"]',
  treeitem: '[role="treeitem"]',
  menuitem: '[role="menuitem"]',
  menuitemcheckbox: '[role="menuitemcheckbox"]'
}
const MODIFIERS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }
const KEYS: Record<string, number> = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35 }

const PUNCTUATION: Record<string, [string, number]> = {
  '.': ['Period', 190],
  ',': ['Comma', 188],
  ';': ['Semicolon', 186], ':': ['Semicolon', 186],
  "'": ['Quote', 222], '"': ['Quote', 222],
  '/': ['Slash', 191], '?': ['Slash', 191],
  '-': ['Minus', 189], '_': ['Minus', 189],
  '=': ['Equal', 187], '+': ['Equal', 187]
}

export class Window {
  readonly hostErrors: string[] = []

  private constructor(private readonly cdp: Cdp, private readonly signal: AbortSignal) {}

  static async attach(port: number, signal: AbortSignal): Promise<Window> {
    const cdp = await attach(port, 120_000, signal)
    const window = new Window(cdp, signal)
    try {
      cdp.onEvent((method, params) => {
        if (method !== 'Network.webSocketFrameReceived') return
        const payload = (params as { response?: { payloadData?: string } }).response?.payloadData
        if (!payload?.startsWith('{')) return
        try {
          const { ok, error } = JSON.parse(payload) as { ok?: boolean; error?: string }
          if (ok === false && typeof error === 'string') window.hostErrors.push(error)
        } catch {
          // A frame from a socket other than the app's request link.
        }
      })
      await cdp.send('Network.enable')
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
      return window
    } catch (error) {
      cdp.close()
      throw error
    }
  }

  eval<T>(expression: string): Promise<T> {
    return this.cdp.eval<T>(expression)
  }

  until(label: string, ms: number, test: () => unknown | Promise<unknown>): Promise<void> {
    return until(label, ms, test, this.signal)
  }

  close(): void {
    this.cdp.close()
  }

  async click({ x, y }: Point, count = 1): Promise<void> {
    this.signal.throwIfAborted()
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    for (let c = 1; c <= count; c++) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await this.cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: c })
      }
    }
  }

  centre(selector: string, text?: string): Promise<Point | null> {
    return this.eval(`(() => {
      for (const el of document.querySelectorAll(${JSON.stringify(selector)})) {
        if (el.closest('[inert], [aria-hidden="true"]') || el.matches(':disabled, [aria-disabled="true"]')) continue;
        const label = el.getAttribute('aria-label') ?? el.querySelector('[data-menu-label]')?.textContent ?? el.textContent;
        if (${text !== undefined} && label.trim() !== ${JSON.stringify(text ?? '')}) continue;
        const r = el.getBoundingClientRect();
        const x = r.x + r.width / 2, y = r.y + r.height / 2;
        if (r.width && r.height && el.contains(document.elementFromPoint(x, y))) return { x, y };
        // Out of view in a list that scrolls (the rail's third workspace at 800px of window): scrolled to, as he would, and found on the next look.
        if (r.width && r.height) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      return null;
    })()`)
  }

  async press(role: string, exactText: string): Promise<void> {
    const selector = ROLES[role]
    if (!selector) throw new Error(`Unknown role ${role}`)
    await this.clickOn(selector, exactText)
  }

  async clickOn(selector: string, text?: string): Promise<void> {
    let at: Point | null = null
    await this.until(text ?? selector, 20_000, async () => (at = await this.centre(selector, text)))
    await this.click(at!)
  }

  async key(chord: string): Promise<void> {
    this.signal.throwIfAborted()
    const parts = chord.length === 1 ? [chord] : chord.split('+')
    const key = parts.pop()!
    const modifiers = parts.reduce((mask, part) => mask | MODIFIERS[part]!, 0)
    const punctuation = PUNCTUATION[key]
    const code = punctuation?.[0] ?? (/^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : key === ' ' ? 'Space' : key.length > 1 ? key : '')
    const keys = { key, code, modifiers, windowsVirtualKeyCode: KEYS[key] ?? punctuation?.[1] ?? key.toUpperCase().charCodeAt(0) }
    const text = modifiers & ~MODIFIERS.Shift! ? undefined : key === 'Enter' ? '\r' : key.length === 1 ? key : undefined
    await this.cdp.send('Input.dispatchKeyEvent', { ...keys, type: 'keyDown', text })
    await this.cdp.send('Input.dispatchKeyEvent', { ...keys, type: 'keyUp' })
  }

  async typeKeys(text: string): Promise<void> {
    for (const char of text) await this.key(char === '\n' ? 'Enter' : char)
  }

  async shot(path: string): Promise<void> {
    const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'png' }) as { data: string }
    writeFileSync(path, Buffer.from(data, 'base64'))
  }

  toasts(): Promise<string[]> {
    return this.eval(`[...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim())`)
  }

  saveLine(): Promise<string | null> {
    return this.eval(`[...document.querySelectorAll('[data-files-save-line]')].find((e) => e.getClientRects().length)?.textContent.trim() ?? null`)
  }

  async catchExports(): Promise<void> {
    await this.eval(`(() => {
      if (window.__journeyExports) return;
      const create = URL.createObjectURL.bind(URL);
      window.__journeyExports = new Map();
      URL.createObjectURL = (blob) => {
        const url = create(blob);
        if (blob instanceof Blob) window.__journeyExports.set(url, blob);
        return url;
      };
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (!this.download || !window.__journeyExports.has(this.href)) click.call(this);
      };
    })()`)
    await this.eval('window.__journeyExports.clear()')
  }

  async exported(mime: string): Promise<Buffer> {
    let bytes: number[] | undefined
    await this.until(mime + ' export bytes', 30_000, async () => {
      bytes = await this.eval(`(async () => {
        const blob = [...window.__journeyExports.values()].find((b) => b.type === ${JSON.stringify(mime)});
        return blob && Array.from(new Uint8Array(await blob.arrayBuffer()));
      })()`)
      return bytes
    })
    return Buffer.from(bytes!)
  }
}
