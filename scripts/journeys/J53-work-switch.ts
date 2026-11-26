import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { journey, step, type Context } from './lib/record'
import { DIALOG, enterField, settings } from './lib/settings'
import type { Window } from './lib/window'

const SWITCH = '[role="switch"][aria-label="Work"]'
const GIVEN_LINE = 'Work for box is changed from a computer that manages it'
const ADDED = 'Dummy folder'
const NEW = 'Dummy switch workspace'

async function view(context: Context): Promise<Window> {
  if (context.shape === 'A') return context.pair.page
  const page = await context.pair.deviceWindow()
  context.evidencePage = page
  return page
}

const read = (pair: Context['pair']) => pair.rpc<{ enabled: boolean }>(pair.box, 'work.get')

export default journey({
  id: 'J53',
  title: 'Use the Work switch, workspace creation and Add folder with both keys',
  tier: 1,
  shapes: ['A', 'K'],
  steps: [
    step('Read Settings → Work and press its switch', async (context) => {
      const { pair, folder, shape } = context
      const page = await view(context)
      await settings(page, 'Work')
      await page.until('Work to be on for box', 20_000, async () =>
        (await read(pair)).enabled && await page.centre(SWITCH + '[aria-checked="true"]'))
      if (shape === 'K') {
        await page.clickOn('button[aria-label^="Turn on for"], [data-slot="page"] button', 'Turn on for This Mac')
        await page.until('Work on for the given computer', 15_000, async () =>
          (await pair.rpc<{ enabled: boolean }>(pair.givenInstance!, 'work.get')).enabled)
      }
      if (shape === 'K') {
        await page.until('the line saying who changes Work for box', 15_000, () =>
          page.eval(`document.body.innerText.includes(${JSON.stringify(GIVEN_LINE)})`))
        await page.eval(`(() => {
          window.__journeyWorkWrites = [];
          window.__journeyUnwatchWork = ['local', ${JSON.stringify(pair.box.host)}].map(id => {
            const link = window.__docket.registry.linkOf(id);
            const request = link.request;
            link.request = function (method, ...args) {
              if (method === 'work.set') window.__journeyWorkWrites.push(id);
              return request.call(this, method, ...args);
            };
            return () => { link.request = request; };
          });
        })()`)
        pair.later(() => page.eval('window.__journeyUnwatchWork.forEach(restore => restore())'))
      }
      await page.clickOn(SWITCH)
      if (shape === 'A') {
        await page.until('Work off on box', 15_000, async () => !(await read(pair)).enabled)
        await page.clickOn(SWITCH)
        await page.until('Work back on for box', 15_000, async () => (await read(pair)).enabled)
      } else {
        await page.until('Work off on the given computer', 15_000, async () =>
          !(await pair.rpc<{ enabled: boolean }>(pair.givenInstance!, 'work.get')).enabled)
        const requests = await page.eval<string[]>('window.__journeyWorkWrites')
        writeFileSync(join(folder, 'switch-requests.json'), JSON.stringify(requests, null, 2))
        if (!requests.includes('local') || requests.includes(pair.box.host) || !(await read(pair)).enabled) {
          throw new Error('The given computer wrote Work to box')
        }
        await page.press('button', 'Turn on for This Mac')
        await page.until('Work back on for the given computer', 15_000, async () =>
          (await pair.rpc<{ enabled: boolean }>(pair.givenInstance!, 'work.get')).enabled)
      }
    }),
    step('Use the Work rail to make a workspace', async (context) => {
      const page = await view(context)
      await page.press('button', 'Back')
      await page.press('button', 'Add Work workspace')
      await page.press('menuitem', 'Without a sector…')
      await enterField(page, DIALOG + ' input', NEW + ' ' + context.shape)
      await page.press('button', 'Create')
      await page.until('the new workspace in the rail or a refusal that names who can', 18_000, async () =>
        await page.centre('nav [data-rail-path] button', NEW + ' ' + context.shape) ||
        await page.eval(`/manages|only.*can/i.test(document.querySelector('[role="dialog"] [role="alert"]')?.textContent ?? '')`))
    }),
    step('end: Add folder persists on its own host or names who can add it', async (context) => {
      const { pair, shape } = context
      const page = await view(context)
      const host = shape === 'K' ? pair.givenInstance! : pair.win
      const folder = join(host.home, ADDED)
      mkdirSync(folder)
      await settings(page, 'Work')
      await page.until('Add folder or an explicit permission line', 18_000, async () =>
        await page.centre('button', 'Add folder…') || await page.eval(`/folders.*changed from a computer that manages/i.test(document.body.innerText)`))
      if (!await page.centre('button', 'Add folder…')) return
      await page.press('button', 'Add folder…')
      await enterField(page, DIALOG + ' input', folder)
      await page.press('button', 'Add')
      await page.until('the folder in the host’s library roots', 18_000, async () =>
        JSON.stringify(await pair.rpc(host, 'work.office.filesLibraries')).includes(folder))
      const hosts = await Promise.all([host, pair.box].map((inst) => pair.rpc(inst, 'workspace.list')))
      if (!JSON.stringify(hosts).includes(NEW + ' ' + shape) && !await page.eval(`/manages|only.*can/i.test(document.body.innerText)`)) {
        throw new Error('Neither host has the workspace made in the window')
      }
    })
  ]
})
