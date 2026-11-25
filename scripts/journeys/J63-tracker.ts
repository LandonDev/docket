import { join } from 'node:path'
import type { ThreadRecord } from '../../src/shared/work/threadRecord'
import { addon, evidence, see, sendPrompt } from './lib/lifeosJourney'
import { SECTOR } from './lib/lifeosSeed'
import { journey, step, type Context } from './lib/record'

/** The seeded Spring LAN project (lib/lifeosSeed.ts) and a second job's project made here. */
const PROJECT = 'Spring LAN'
const OTHER = { name: 'Referee', sector: 'ref', project: 'December assignments' }
const PLACE = '[data-work-place="projects"]'
const threads = new WeakMap<Context, string>()

export default journey({
  id: 'J63',
  title: 'The tracker lists two jobs, a held thread reads 1 mail to send, and a row opens its project',
  tier: 2,
  shapes: ['S'],
  steps: [
    step('A second job with a project, and a thread in the Spring LAN mirror that holds a mail', async (context) => {
      const { pair, workspace } = context
      const sandbox = pair.sandbox!
      await pair.workspace(OTHER.name, OTHER.sector)
      await sandbox.mutate('projects:create', { sector: OTHER.sector, name: OTHER.project, status: 'active' })
      const lan = (await sandbox.query<{ _id: string; name: string }[]>('projects:list', { sector: SECTOR })).find((p) => p.name === PROJECT)
      if (!lan) throw new Error('The sandbox has no Spring LAN project')
      const mirror = await pair.rpc<{ id: string }>(pair.box, 'work.project.open', { workspaceId: workspace.id, lifeosProjectId: lan._id, name: PROJECT })
      const session = await pair.rpc<{ id: string }>(pair.box, 'session.create', { workspaceId: workspace.id, projectId: mirror.id, title: 'Ask Dana for switches', provider: 'claude', permission: 'auto', threadType: 'chat', scope: 'work' })
      threads.set(context, session.id)
      await pair.page.eval(`window.__monocode.open(${JSON.stringify(session.id)})`)
      await sendPrompt(pair.page, 'Ask Dana for two switches for the LAN.')
      const accounts = await sandbox.query<{ _id: string; address: string }[]>('mail:accounts')
      const account = accounts.find(({ address }) => address === 'spring-lan@example.org')
      if (!account) throw new Error('The sandbox has no Spring LAN mailbox')
      await addon(context, session.id, 'draft_mail', {
        account_id: account._id, to: [{ name: 'Dana Lee', address: 'dana@example.com' }],
        subject: 'Spring LAN switches', body: 'Could we borrow two switches for the spring LAN?', reason: 'Ready for the owner to check'
      })
      let got: ThreadRecord | undefined
      await pair.page.until('the thread’s outcome to say the held mail', 15_000, async () => {
        got = await pair.rpc<ThreadRecord>(pair.box, 'work.threads.record', { sessionId: session.id })
        return got.outcome?.words === '1 mail to send'
      })
      evidence(context, 'record', got)
    }),
    step('The Projects place lists both jobs, and Spring LAN’s Threads cell reads 1 mail to send', async (context) => {
      const { page } = context.pair
      if (!await page.centre(PLACE)) await page.clickOn('nav button', 'Projects')
      await see(page, `${PLACE} section[data-job="${SECTOR}"]`, PROJECT)
      await see(page, `${PLACE} section[data-job="${OTHER.sector}"]`, OTHER.project)
      await see(page, `${PLACE} section[data-job="${SECTOR}"] [data-part=threads]`, '1 mail to send')
      const thread = await page.eval<string | null>(`document.querySelector('${PLACE} [data-part=threads] [data-thread]')?.getAttribute('data-thread') ?? null`)
      if (thread !== threads.get(context)) throw new Error('The Threads cell names another thread: ' + thread)
      await page.shot(join(context.folder, 'tracker.png'))
    }),
    step('end: the row opens Spring LAN’s page in its job', async (context) => {
      const { page } = context.pair
      await page.clickOn(`${PLACE} [data-project] button`, PROJECT)
      await page.until('the project’s page', 12_000, () => page.eval(`!!document.querySelector('.tc-projects section[aria-label="Plan"]') && !document.querySelector(${JSON.stringify(PLACE)})`))
      evidence(context, 'opened', { project: PROJECT })
    })
  ]
})
