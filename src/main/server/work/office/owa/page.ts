import { OfficeError } from '../carrier'
import { Cdp } from '../../browser/box/cdp'
import { RESERVED_TARGETS, RESERVED_URL } from '../../browser/box/service'

/**
 * The carrier's own tab of Outlook on the web in the box's browser
 * (docs/agents/work-office.md "Outlook on the web"). It is kept from the
 * agents' box browser tools (`RESERVED_TARGETS`): no thread reads his
 * mailbox through it. Calls go to the page's own `service.svc` from inside
 * the page, with the headers the page itself last sent there (its token and
 * canary), so nothing of his sign-in ever leaves the browser.
 */

export const OWA_URL = 'https://outlook.office.com/mail/'
const SIGN_IN = /(^|\.)(login\.microsoftonline\.com|login\.live\.com|login\.microsoft\.com|account\.live\.com)$/i
/** the headers of the page's own calls that sign a call; not its action, body or ids */
const SIGNING = /^(authorization|x-owa-canary|x-anchormailbox|x-req-source|x-owa-hosted-ux|prefer|x-ms-appname|x-owa-sessionid)$/i

export const NEEDS_SIGN_IN = "Outlook on the web is not signed in on the box. Bring his sign-in from the Mac (export it there) or ask him to sign in once in the box's browser."

export interface OwaTransport {
  call<T>(action: string, body: unknown): Promise<T>
  close(): void
}

export interface OwaPageOptions {
  endpoint: () => Promise<string>
  /** marks the browser in use for the length of a call, so it is not stopped under one */
  use?: () => () => void
  url?: string
  /** how long the page has to load and make its first call */
  waitMs?: number
  log?: (line: string) => void
}

export class OwaPage implements OwaTransport {
  private cdp: Cdp | null = null
  private sid: string | null = null
  private target: string | null = null
  private headers: Record<string, string> | null = null
  private opening: Promise<void> | null = null

  constructor(private readonly o: OwaPageOptions) {}

  private get url(): string {
    return this.o.url ?? OWA_URL
  }

  async call<T>(action: string, body: unknown): Promise<T> {
    const done = this.o.use?.()
    try {
      return await this.attempt<T>(action, body)
    } finally {
      done?.()
    }
  }

  private async attempt<T>(action: string, body: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      // Anything that fails before the request goes out is a plain refusal: nothing was sent, and the route fails the row.
      try {
        await this.open()
      } catch (err) {
        if (err instanceof OfficeError) throw err
        throw new OfficeError(`Outlook on the web could not be opened on the box: ${(err as Error).message}`, 'not-running')
      }
      const r = await this.fetch(action, body)
      // His token ran out, the session ended, or the page left Outlook: it is opened again once, and signs in again by itself if it can.
      const lost = r.status === -1 || r.status === 401 || r.status === 440
      if (lost && attempt === 0) {
        await this.reload().catch((err) => {
          throw err instanceof OfficeError ? err : new OfficeError(`Outlook on the web could not be opened on the box: ${(err as Error).message}`, 'not-running')
        })
        continue
      }
      if (lost) throw new OfficeError(NEEDS_SIGN_IN, 'needs-consent')
      if (r.status < 200 || r.status >= 300) throw new OfficeError(`Outlook on the web answered ${r.status} to ${action}`, 'failed')
      try {
        return JSON.parse(r.text) as T
      } catch {
        throw new OfficeError(`Outlook on the web answered ${action} with something that is not JSON`, 'failed')
      }
    }
  }

  close(): void {
    if (this.target) {
      RESERVED_TARGETS.delete(this.target)
      void this.cdp?.send('Target.closeTarget', { targetId: this.target }).catch(() => {})
    }
    this.cdp?.close()
    this.cdp = this.sid = this.target = this.headers = null
  }

  private open(): Promise<void> {
    if (this.cdp?.alive && this.sid && this.headers) return Promise.resolve()
    this.opening ??= this.start().finally(() => (this.opening = null))
    return this.opening
  }

  private async start(): Promise<void> {
    if (!this.cdp?.alive) {
      this.cdp = await Cdp.open(await this.o.endpoint())
      this.sid = this.target = null
      this.cdp.on('Network.requestWillBeSent', (p, sid) => {
        const req = p.request as { url: string; headers: Record<string, string> }
        if (sid !== this.sid || !/\/service\.svc\b/i.test(req.url)) return
        const kept = Object.fromEntries(Object.entries(req.headers).filter(([k]) => SIGNING.test(k)))
        if (Object.keys(kept).length) this.headers = kept
      })
      this.cdp.on('Target.targetDestroyed', (p) => {
        if (p.targetId === this.target) {
          RESERVED_TARGETS.delete(this.target!)
          this.sid = this.target = this.headers = null
        }
      })
    }
    const cdp = this.cdp
    if (!this.target) {
      const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: RESERVED_URL })
      RESERVED_TARGETS.add(targetId)
      this.target = targetId
      this.sid = (await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })).sessionId
      await Promise.all(['Network.enable', 'Page.enable', 'Runtime.enable'].map((m) => cdp.send(m, {}, this.sid!)))
      await cdp.send('Page.navigate', { url: this.url }, this.sid!)
    }
    await this.signed()
  }

  private async reload(): Promise<void> {
    this.headers = null
    if (this.cdp && this.sid) await this.cdp.send('Page.navigate', { url: this.url }, this.sid).catch(() => {})
    await this.open()
  }

  /** Waits for the page to be signed in and to have made a call of its own; a sign-in page means he is needed. */
  private async signed(): Promise<void> {
    const until = Date.now() + (this.o.waitMs ?? 30_000)
    let host = ''
    while (Date.now() < until) {
      host = await this.eval<string>('location.hostname').catch(() => '')
      if (SIGN_IN.test(host)) throw new OfficeError(NEEDS_SIGN_IN, 'needs-consent')
      if (this.headers) return
      await new Promise((r) => setTimeout(r, 250))
    }
    // The page made no call yet: its canary cookie alone signs a call in the classic page.
    const canary = await this.eval<string>("(document.cookie.match(/(?:^|; )X-OWA-CANARY=([^;]+)/) || [])[1] || ''").catch(() => '')
    if (canary) {
      this.headers = { 'x-owa-canary': canary }
      return
    }
    throw new OfficeError(host ? `Outlook on the web did not finish opening on the box (${host})` : NEEDS_SIGN_IN, host ? 'not-running' : 'needs-consent')
  }

  private async eval<T>(expression: string): Promise<T> {
    const r = await this.cdp!.send<{ result: { value?: T }; exceptionDetails?: { text: string } }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, this.sid!, 60_000)
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result.value as T
  }

  /**
   * One call from inside the page, to Outlook's own origin only: a page that
   * moved to a sign-in host (or anywhere else) answers -1 and nothing is
   * sent, so his mail and its signing headers never go to another host.
   */
  private fetch(action: string, body: unknown): Promise<{ status: number; text: string }> {
    const origin = new URL(this.url).origin
    const headers = { ...this.headers, action, 'content-type': 'application/json; charset=utf-8' }
    const call = `(async () => { if (location.origin !== ${JSON.stringify(origin)}) return { status: -1, text: '' }; const r = await fetch(${JSON.stringify(`${origin}/owa/service.svc?action=${encodeURIComponent(action)}&app=Mail`)}, { method: 'POST', credentials: 'include', headers: ${JSON.stringify(headers)}, body: ${JSON.stringify(JSON.stringify(body))} }); return { status: r.status, text: await r.text() } })()`
    return this.eval<{ status: number; text: string }>(call)
  }
}
