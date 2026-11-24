import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { OfficeLiveOf } from '../../src/shared/contract-work-office'
import { openRow } from './lib/files'
import { fileAt, showPlace } from './lib/place'
import { journey, step, type Context } from './lib/record'

const NAME = 'Practice agenda.docx'
const CONTROL = '[data-office-live-control]'
const WEB = 'https://journey-dummy.sharepoint.com/sites/Practice/Shared%20Documents'

async function mode({ pair, workspace }: Context): Promise<OfficeLiveOf> {
  const tabId = await pair.page.eval<string>(`document.querySelector('[data-files-tab][data-tab-kind="file"][aria-selected="true"]')?.getAttribute('data-files-tab')`)
  if (!tabId) throw new Error('The Word tab has no id')
  return pair.rpc(pair.box, 'work.office.live.of', { workspaceId: workspace.id, tabId })
}

export default journey({
  id: 'J21',
  title: 'Read where a shared Word file opens live and check its TempCode tab',
  tier: 1,
  shapes: ['B2'],
  steps: [
    step('Give the dummy library a web address and open a Word file from desk', async (context) => {
      const { pair, folder } = context
      const file = fileAt(context, NAME)
      copyFileSync(join(pair.repo, 'resources/work-templates/any/Meeting notes.docx'), file)
      copyFileSync(file, join(folder, 'before.docx'))
      await pair.rpc(pair.desk!, 'work.office.filesSetRoots', { roots: [{ folder: dirname(pair.l2!), web: WEB }] })
      await showPlace(context)
      await openRow(pair.page, NAME)
    }),
    step('Open the editor switch and record the address it offers for Live in Word', async (context) => {
      const { pair, folder, workspace } = context
      await pair.page.clickOn(CONTROL, 'Edit here')
      await pair.page.until('the Live in Word choice', 10_000, () => pair.page.centre('[role^="menuitem"]', 'Live in Word'))
      const of = await mode(context)
      writeFileSync(join(folder, 'office-address.json'), JSON.stringify(of, null, 2))
      const address = of.address ? new URL(of.address) : null
      if (address?.hostname !== 'journey-dummy.sharepoint.com' ||
        ![...address.searchParams.values(), decodeURIComponent(address.pathname)].some((value) => decodeURIComponent(value).includes(workspace.name + '/' + NAME))) {
        throw new Error('The host did not offer the dummy Word address: ' + (of.why ?? of.address ?? 'no address'))
      }
      await pair.page.shot(join(folder, 'editor-switch.png'))
      // The switch test stubs the peer and exporter. The built Office webview only admits public Microsoft origins.
      await pair.page.key('Escape')
    }),
    step('end: TempCode still names its editor and the holder’s Word file is unchanged', async (context) => {
      const { pair, folder } = context
      if (!readFileSync(fileAt(context, NAME)).equals(readFileSync(join(folder, 'before.docx')))) throw new Error('The holder’s Word file changed')
      if ((await mode(context)).mode !== 'here') throw new Error('The host does not say the Word tab is in TempCode')
      await pair.page.until('Edit here on the Word tab', 10_000, () => pair.page.centre(CONTROL, 'Edit here'))
    })
  ]
})
