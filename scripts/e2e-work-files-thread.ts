import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FilesListing, FilesPlaces } from '../src/shared/contract-work-files'
import type { OutboxItem } from '../src/shared/contract-work-outbox'
import { PREFIX, Run, sleep, textOf } from './e2e-work-lib'

/**
 * The Files place, the agents' side, in a real instance (docs/agents/work-files.md "Agents"): a Work thread
 * changes files with the `files_*` tools, called as its bridge calls them.
 *
 *  1. In his own place (the workspace's folder) a change runs at once: the thread makes a text file, the file is
 *     on the disk, marked as made by the thread, and `files_undo` takes it back to Trash.
 *  2. In a place others can open (a dummy Teams library under the run's own HOME) nothing is written: a rename is
 *     held as a `file.act` whose one sentence says the file, the new name and who can open it. The file is as it
 *     was until the owner presses; his press renames it.
 *  3. A held act gone stale: the file changes after the act was held, the press does nothing and says so.
 *  4. The wire takes no thread's change: only the tools reach the door.
 *
 * No model runs and no LifeOS is signed in: the workspace has a dummy sector and every file is the run's own.
 * Run after `electron-vite build`: env -u ELECTRON_RUN_AS_NODE bun scripts/e2e-work-files-thread.ts
 */
const run = new Run('files-thread')
try {
  await run.start()
  // A library as OneDrive lays a team's channel out on a Mac, under the instance's own HOME: dummy files only.
  const library = join(run.home, 'Library', 'CloudStorage', 'OneDrive-dummy.edu-Esports-Staff')
  mkdirSync(join(library, 'General'), { recursive: true })
  mkdirSync(join(run.home, 'Library', 'CloudStorage', 'OneDrive-dummy.edu'), { recursive: true })
  writeFileSync(join(library, 'General', 'Plan.txt'), 'The plan, as the team wrote it.\n')
  writeFileSync(join(library, 'General', 'Budget.txt'), 'The budget, as the team wrote it.\n')

  const ws = await run.call<{ id: string; path: string }>('workspace.create', { kind: 'work', name: `${PREFIX} files`, sector: 'dummy' })
  run.later('delete the workspace', () => run.call('workspace.delete', { workspaceId: ws.id }))
  const thread = await run.thread(ws.id, `${PREFIX} files thread`)

  // What the thread may name: his folder, and the team's library with who else can open it.
  const places = await run.tool(thread, 'files_places', {})
  const listed = (places.structuredContent as { places?: { place: string; name: string; who?: string }[] } | undefined)?.places ?? []
  const team = listed.find((p) => /General/.test(p.name))
  run.check('files_places names the workspace\'s folder as his alone', listed.some((p) => p.place === 'folder' && /Only the owner/.test(p.who ?? '')), textOf(places).slice(0, 300))
  run.check('and the team\'s library with who else can open it', !!team && /can open it/.test(team.who ?? ''), JSON.stringify(team))

  // 1. His own place: it runs at once, with an Undo.
  const made = await run.tool(thread, 'files_make', { place: 'folder', kind: 'text', name: 'Notes from the thread' })
  const madePath = join(ws.path, 'Notes from the thread.md')
  run.check('a file made in the workspace\'s folder is made at once', !made.isError && existsSync(madePath), textOf(made).slice(0, 300))
  const op = (made.structuredContent as { undo?: { op?: string } } | undefined)?.undo?.op
  const madeBy = await run.call<FilesListing>('work.files.list', { workspaceId: ws.id, at: { at: 'place', id: 'made' } })
  run.check('it is listed under Made by threads until he opens it', madeBy.entries.some((e) => e.name === 'Notes from the thread.md' && e.fresh === true), madeBy.entries.map((e) => e.name).join(', '))
  if (run.check('the answer names its Undo', !!op, textOf(made).slice(0, 300))) {
    const undone = await run.tool(thread, 'files_undo', { op })
    run.check('files_undo takes the made file to Trash', !undone.isError && !existsSync(madePath), textOf(undone).slice(0, 200))
  }

  // 2. A place others can open: held for his press, nothing written.
  const held = await run.tool(thread, 'files_move', { place: team?.place ?? '', paths: ['Plan.txt'], name: 'Plan v2.txt' })
  run.check('a rename in the team\'s library is held, not run', !held.isError && /Held as item/.test(textOf(held)), textOf(held).slice(0, 300))
  run.check('the file is as it was', existsSync(join(library, 'General', 'Plan.txt')) && !existsSync(join(library, 'General', 'Plan v2.txt')))
  let act: OutboxItem | undefined
  run.check('the act waits in the Outbox', await run.until('held', 30_000, async () => !!(act = (await run.call<{ items: OutboxItem[] }>('work.outbox.list', {})).items.find((i) => i.kind === 'file.act' && i.state === 'held'))))
  run.check('its one sentence says the file, the new name and who can open it', /Rename Plan\.txt to Plan v2\.txt/.test(act?.summary ?? '') && /can open it/.test(act?.summary ?? ''), act?.summary ?? '')

  // The window: the Outbox's own view of the act, in both themes.
  await run.show(thread)
  await run.page(`(() => { const el = [...document.querySelectorAll('button, a, [role=button]')].find((e) => /^Outbox\\d*$/.test(e.textContent.trim())); el?.click() })()`)
  await run.until('row', 20_000, () => run.has('Plan v2.txt'))
  await sleep(1200)
  await run.shot('01-file-act-held')

  const sent = await run.call<OutboxItem>('work.outbox.send', { ref: act!.ref })
  run.check('his press renames it', sent.state === 'sent', `${sent.state} ${sent.error ?? ''}`)
  run.check('the file has its new name, with its words', await run.until('renamed', 20_000, () => existsSync(join(library, 'General', 'Plan v2.txt'))) && readFileSync(join(library, 'General', 'Plan v2.txt'), 'utf8').startsWith('The plan'))

  // 3. A held act gone stale before the press.
  const second = await run.tool(thread, 'files_move', { place: team?.place ?? '', paths: ['Budget.txt'], name: 'Budget final.txt' })
  run.check('a second rename is held', !second.isError && /Held as item/.test(textOf(second)), textOf(second).slice(0, 200))
  let stale: OutboxItem | undefined
  await run.until('held again', 30_000, async () => !!(stale = (await run.call<{ items: OutboxItem[] }>('work.outbox.list', {})).items.find((i) => i.kind === 'file.act' && i.state === 'held')))
  // Someone on the team changes the file after the act was held.
  await sleep(1100)
  writeFileSync(join(library, 'General', 'Budget.txt'), 'The budget, changed by someone on the team after the thread asked.\n')
  const pressed = await run.call<OutboxItem>('work.outbox.send', { ref: stale!.ref }).catch((e: Error) => ({ state: 'refused', error: e.message }) as unknown as OutboxItem)
  run.check('the press on a file that changed since does nothing', !existsSync(join(library, 'General', 'Budget final.txt')) && existsSync(join(library, 'General', 'Budget.txt')), JSON.stringify(pressed).slice(0, 300))
  run.check('and the act reads as stale, with why', (pressed.state === 'stale' || pressed.state === 'failed') && !!pressed.error, `${pressed.state} ${pressed.error ?? ''}`)

  // 4. The wire takes no thread's change (asked here as the owner's seat would relay a thread's own token).
  const viaTool = await run.tool(thread, 'files_trash', { place: team?.place ?? '', paths: ['Plan v2.txt'] })
  run.check('a delete in the team\'s library is refused in the place\'s own words, not held', !!viaTool.isError || /Delete it in Teams/.test(textOf(viaTool)), textOf(viaTool).slice(0, 200))
  run.check('and the file is still there', existsSync(join(library, 'General', 'Plan v2.txt')))

  const after = await run.call<FilesPlaces>('work.files.places', { workspaceId: ws.id })
  run.check('the place still lists as it did', after.places.some((p) => p.kind === 'teams'), after.places.map((p) => p.kind).join(', '))
} catch (err) {
  await run.finish(err)
}
await run.finish()
