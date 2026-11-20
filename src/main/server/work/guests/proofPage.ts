import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/*
 * A small CDP client for the guests pillar's live proofs (live.proof.test.ts,
 * projectLinks.live.proof.test.ts): one page of a headless Chromium, driven as
 * a person would, with every request carrying a CF-Connecting-IP as the
 * tunnel's would. Shots go to `Page.shots` when it names a folder.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class Page {
  /** where `shot` writes; '' for nowhere */
  static shots = ''

  private n = 0
  private readonly waiting = new Map<number, (v: { result?: unknown; error?: { message: string } }) => void>()
  readonly logs: string[] = []
  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown> }
      if (m.id !== undefined) this.waiting.get(m.id)?.(m)
      else if (m.method === 'Runtime.consoleAPICalled') this.logs.push(JSON.stringify((m.params as { args: { value?: unknown }[] }).args.map((a) => a.value)))
      else if (m.method === 'Runtime.exceptionThrown') this.logs.push(`exception: ${String((m.params as { exceptionDetails: { exception?: { description?: string } } }).exceptionDetails.exception?.description ?? JSON.stringify(m.params)).slice(0, 600)}`)
    }
  }
  static async open(debugPort: number): Promise<Page> {
    const t = (await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json()) as { webSocketDebuggerUrl: string }
    const ws = new WebSocket(t.webSocketDebuggerUrl)
    await new Promise((r) => (ws.onopen = r))
    const p = new Page(ws)
    await p.send('Runtime.enable')
    await p.send('Page.enable')
    await p.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 760, deviceScaleFactor: 1, mobile: false })
    return p
  }
  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.n
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) =>
      this.waiting.set(id, (m) => {
        this.waiting.delete(id)
        if (m.error) reject(new Error(`${method}: ${m.error.message}`))
        else resolve(m.result as T)
      })
    )
  }
  async eval<T>(expr: string): Promise<T> {
    const got = await this.send<{ result: { value?: T }; exceptionDetails?: unknown }>('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (got.exceptionDetails) throw new Error(`eval failed: ${JSON.stringify(got.exceptionDetails).slice(0, 300)}`)
    return got.result.value as T
  }
  async until(what: string, expr: string, ms = 15_000): Promise<void> {
    const end = Date.now() + ms
    while (!(await this.eval<boolean>(expr).catch(() => false))) {
      if (Date.now() > end) throw new Error(`timed out: ${what}; page said ${this.logs.slice(-5).join(' | ')}`)
      await sleep(100)
    }
  }
  async go(url: string, scheme: 'light' | 'dark' = 'light'): Promise<void> {
    await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] })
    await this.send('Network.enable')
    await this.send('Network.setExtraHTTPHeaders', { headers: { 'CF-Connecting-IP': '203.0.113.50' } })
    await this.send('Page.navigate', { url })
  }
  async click(x: number, y: number): Promise<void> {
    for (const type of ['mousePressed', 'mouseReleased']) await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
  }
  async type(text: string): Promise<void> {
    await this.send('Input.insertText', { text })
  }
  async key(key: string, code: string, keyCode: number): Promise<void> {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode })
  }
  async shot(name: string): Promise<void> {
    if (!Page.shots) return
    const { data } = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(Page.shots, `${name}.png`), Buffer.from(data, 'base64'))
  }
  close(): void {
    this.ws.close()
  }
}
