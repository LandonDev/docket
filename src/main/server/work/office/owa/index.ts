import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { boxBrowser, useBoxBrowser } from '../../browser/box'
import { findChromium } from '../../browser/box/chromium'
import { OwaCarrier } from './carrier'
import { OwaPage } from './page'

/**
 * This host's Outlook on the web carrier: on Linux where a Chromium is, over
 * the box's browser once it is wired at boot (work/browser/box). The page is
 * made on first use and kept; `TEMP_CODE_OWA_URL` points it at a stand-in
 * for a proof.
 */
export function owaCarrier(env: NodeJS.ProcessEnv = process.env): OwaCarrier | null {
  if (process.platform !== 'linux' || !findChromium(env)) return null
  let page: OwaPage | null = null
  return new OwaCarrier({
    page: () => {
      const host = boxBrowser()
      if (!host) return null
      // its page is never on the captured screen and never raised: the stage keeps a headed one off it
      page ??= new OwaPage({ endpoint: () => host.browser.endpoint(), open: (url) => host.stage.open(url, 'carrier'), use: useBoxBrowser, ...(env.TEMP_CODE_OWA_URL ? { url: env.TEMP_CODE_OWA_URL } : {}) })
      return page
    },
    marker: () => {
      const host = boxBrowser()
      return host ? join(host.root, 'owa.json') : null
    },
    running: () => !!boxBrowser()?.browser.running,
    hasSignIn: () => {
      const host = boxBrowser()
      return !!host && profileHasSignIn(join(host.browser.profile, 'Default', 'Cookies'))
    }
  })
}

/** Whether Chromium's cookie store holds a Microsoft sign-in, read without the browser. */
export function profileHasSignIn(cookies: string): boolean {
  try {
    const db = new DatabaseSync(cookies, { readOnly: true })
    try {
      return !!db.prepare("SELECT 1 FROM cookies WHERE host_key LIKE '%login.microsoftonline.com' OR host_key LIKE '%login.live.com' OR host_key LIKE '%outlook.office.com' OR host_key LIKE '%outlook.cloud.microsoft' LIMIT 1").get()
    } finally {
      db.close()
    }
  } catch {
    return false
  }
}
