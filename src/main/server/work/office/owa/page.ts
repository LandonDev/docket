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

/** Where the carrier opens Outlook: Microsoft serves it here now and sends the older addresses on to it (seen live 2026-11-20). */
export const OWA_URL = 'https://outlook.cloud.microsoft/mail/'
/** Outlook on the web's own origins, exact and https: the page may land on any of them, and calls go only to the one it is on. */
export const OUTLOOK_ORIGINS: readonly string[] = ['https://outlook.cloud.microsoft', 'https://outlook.office.com', 'https://outlook.office365.com']
const SIGN_IN = /(^|\.)(login\.microsoftonline\.com|login\.live\.com|login\.microsoft\.com|account\.live\.com)$/i
/** the headers of the page's own calls that sign a call; not its action, body or ids */
const SIGNING = /^(authorization|x-owa-canary|x-anchormailbox|x-req-source|x-owa-hosted-ux|prefer|x-ms-appname|x-owa-sessionid)$/i

export const NEEDS_SIGN_IN = "Outlook on the web is not signed in on the box. Bring his sign-in from the Mac (export it there) or ask him to sign in once in the box's browser."

/** What a call may ask of the transport: `afterReload` runs once the page was opened again for a lost session, before the request is retried; a throw there sends nothing. */
export interface CallOptions {
  afterReload?: () => Promise<void>
}

export interface OwaTransport {
  call<T>(action: string, body: unknown, opts?: CallOptions): Promise<T>
  close(): void
}

export interface OwaPageOptions {
  endpoint: () => Promise<string>
  /** makes the carrier's page (the box browser's stage puts a headed one off the captured screen); absent: a plain tab */
  open?: (url: string) => Promise<string>
  /** marks the browser in use for the length of a call, so it is not stopped under one */
  use?: () => () => void
  url?: string
  /** Outlook's own origins (`OUTLOOK_ORIGINS`); a test's stand-in names its own */
  origins?: readonly string[]
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
  private get origins(): readonly string[] {
    return this.o.origins ?? OUTLOOK_ORIGINS
  }
  private outlooks(url: string): boolean {
    try {
      return this.origins.includes(new URL(url).origin)
    } catch {
      return false
    }
  }

  async call<T>(action: string, body: unknown, opts?: CallOptions): Promise<T> {
    const done = this.o.use?.()
    try {
      return await this.attempt<T>(action, body, opts)
    } finally {
      done?.()
    }
  }

  private async attempt<T>(action: string, body: unknown, opts?: CallOptions): Promise<T> {
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
        // The page may have signed in again as someone else: a send checks who before it goes again.
        await opts?.afterReload?.()
        continue
      }
      // Still off Outlook: a sign-in page wants him; any other host is no Outlook of his, and nothing went there.
      if (r.status === -1 && !SIGN_IN.test(r.text)) throw new OfficeError(`Outlook on the web landed on ${r.text || 'a page'}, which is not Outlook's own; nothing was sent`, 'not-running')
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
        // only Outlook's own calls sign ours
        if (sid !== this.sid || !/\/service\.svc\b/i.test(req.url) || !this.outlooks(req.url)) return
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
      const targetId = this.o.open ? await this.o.open(RESERVED_URL) : (await cdp.send<{ targetId: string }>('Target.createTarget', { url: RESERVED_URL })).targetId
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
    // The page made no call yet: its canary cookie alone signs a call in the classic page, on Outlook's own origin only.
    const origin = await this.eval<string>('location.origin').catch(() => '')
    const canary = !this.origins.includes(origin) ? '' : await this.eval<string>("(document.cookie.match(/(?:^|; )X-OWA-CANARY=([^;]+)/) || [])[1] || ''").catch(() => '')
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
   * One call from inside the page, to the Outlook origin it landed on and to
   * no other: a page on a sign-in host or anywhere else answers -1 with its
   * host and nothing is sent, so his mail and its signing headers never go
   * to another host.
   */
  private fetch(action: string, body: unknown): Promise<{ status: number; text: string }> {
    const headers = { ...this.headers, action, 'content-type': 'application/json; charset=utf-8' }
    const path = `/owa/service.svc?action=${encodeURIComponent(action)}&app=Mail`
    const call = `(async () => { if (!${JSON.stringify(this.origins)}.includes(location.origin)) return { status: -1, text: location.hostname }; const r = await fetch(location.origin + ${JSON.stringify(path)}, { method: 'POST', credentials: 'include', headers: ${JSON.stringify(headers)}, body: ${JSON.stringify(JSON.stringify(body))} }); return { status: r.status, text: await r.text() } })()`
    return this.eval<{ status: number; text: string }>(call)
  }
}
