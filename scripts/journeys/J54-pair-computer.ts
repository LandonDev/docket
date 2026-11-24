import QRCode from 'qrcode'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { journey, step, type Context } from './lib/record'
import { DIALOG, dialogWords, enterField, settings } from './lib/settings'

const CLIENT = 'Practice second computer'
const reachProblem = new WeakMap<Context, string>()

async function device(context: Context) {
  const page = await context.pair.deviceWindow()
  context.evidencePage = page
  return page
}

export default journey({
  id: 'J54',
  title: 'Check the pairing link and QR, or its reach warning, and revoke the pairing',
  tier: 1,
  shapes: ['K'],
  steps: [
    step('Open the given computer’s Hosts settings and ask to pair a device', async (context) => {
      const page = await device(context)
      await settings(page, 'Hosts')
      await page.press('button', 'Add…')
      await page.press('menuitem', 'Pair a device…')
      await enterField(page, DIALOG + ' input[placeholder="iPhone"]', CLIENT)
      writeFileSync(join(context.folder, 'dialog-before.txt'), await dialogWords(page))
      await page.press('button', 'Create code')
    }),
    step('Read the link and QR or the reason there is no reachable address', async (context) => {
      const page = await device(context)
      await page.until('the pairing code', 15_000, () => page.centre('[data-pairing-code]'))
      const { link, qr } = await page.eval<{ link?: string; qr?: string }>(`(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const nodes = [...dialog.querySelectorAll('input, code, a, span')];
        return { link: nodes.map(e => e.value ?? e.href ?? e.textContent.trim()).find(s => /^https?:\\/\\/\\S+\\/pair#\\S+$/.test(s)),
          qr: dialog.querySelector('img[alt="Pairing QR code"]')?.getAttribute('src') };
      })()`)
      const words = await dialogWords(page)
      const origin = link && new URL(link).origin
      const loopback = origin && /localhost|127\.0\.0\.1|\[::1\]/.test(origin)
      writeFileSync(join(context.folder, 'pairing-reach.json'), JSON.stringify({ origin, qr: !!qr, words: words.replace(/[A-Z0-9]{5}-[A-Z0-9]{5}/g, '<code>') }, null, 2))
      if (link && !loopback) {
        const expected = await QRCode.toDataURL(link, { margin: 1, width: 192, color: { dark: '#000000', light: '#ffffff' } })
        if (qr !== expected) reachProblem.set(context, 'The QR does not encode the pairing link')
      } else if (link || qr) {
        reachProblem.set(context, 'The pairing dialog offered a loopback link')
      } else if (!/cannot reach|no public address|opens only there/i.test(
        readFileSync(join(context.folder, 'dialog-before.txt'), 'utf8') + '\n' + words
      )) {
        reachProblem.set(context, 'The dialog offers no reachable link and does not say why')
      }
      if (reachProblem.has(context)) await page.shot(join(context.folder, 'pairing-dialog.png'))
      await page.press('button', 'Done')
    }),
    step('end: the pairing is revoked and the dialog offered a usable link or explained its absence', async (context) => {
      const { pair } = context
      const page = await device(context)
      const get = () => pair.rpc<{ id: string; name: string }[]>(pair.givenInstance!, 'remote.pairings.list')
      const item = (await get()).find(({ name }) => name === CLIENT)
      if (!item) throw new Error('The host did not record the pairing')
      await page.clickOn('[data-client-pairing=' + JSON.stringify(item.id) + '] button', 'Cancel')
      await page.until('the pairing is revoked on the host', 15_000, async () => !(await get()).some(({ id }) => id === item.id))
      const problem = reachProblem.get(context)
      if (problem) throw new Error(problem)
    })
  ]
})
