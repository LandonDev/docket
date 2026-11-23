import type { FileDone, FilesListing, FilesOpened, FilesPlaces } from '../src/shared/contract-work-files'
import { PREFIX, Run } from './e2e-work-lib'

/**
 * LifeOS as a place of Files, against the owner's real LifeOS (docs/agents/work-files.md "LifeOS, From mail and
 * Projects"): one document named E2E-49 is made through Files, listed, renamed, opened in a Files tab with no
 * thread, sent to LifeOS's trash, found in the Trash lens, put back, and taken away again at the end (LifeOS
 * removes a trashed document after 30 days). It touches no other row of his. The session is minted for the run
 * and revoked at its end, as every Work proof's is.
 *
 * Run after `electron-vite build`: env -u ELECTRON_RUN_AS_NODE bun scripts/e2e-work-files-lifeos.ts
 */
const run = new Run('files-lifeos')
const op = (word: string): string => `e2e-files-lifeos-${word}-${Date.now()}`
const top = { at: 'place', id: 'lifeos' } as const
try {
  await run.start()
  await run.signIn('files')
  const ws = await run.workspace('life', `${PREFIX} files lifeos`)

  let place: FilesPlaces['places'][number] | undefined
  run.check(
    'LifeOS is a place of the workspace, and answers',
    await run.until('place', 60_000, async () => (place = (await run.call<FilesPlaces>('work.files.places', { workspaceId: ws })).places.find((p) => p.kind === 'lifeos'))?.state.state === 'ok'),
    JSON.stringify(place?.state)
  )
  run.check('its trash answers, so Delete is offered there', !!place?.can.includes('trash'), JSON.stringify(place?.can))

  const name = `${PREFIX} files doc`
  const made = await run.call<FileDone>('work.files.make', { workspaceId: ws, at: top, kind: 'document', name, op: op('make') })
  const entry = made.entries[0]
  const ref = entry?.ref as { at: string; table: string; id: string } | undefined
  run.check('New in LifeOS makes a document there', !!ref && ref.at === 'lifeos' && ref.table === 'docs' && !!ref.id, JSON.stringify(made).slice(0, 300))
  if (!ref) throw new Error('nothing was made')
  // Whatever happens next, the document is taken away at the end.
  run.later('take the E2E document away', () => run.mutation('docs:remove', { id: ref.id }).catch(() => null))
  const names = async (): Promise<string[]> => (await run.call<FilesListing>('work.files.list', { workspaceId: ws, at: top })).entries.map((e) => e.name)
  run.check('the place lists it', await run.until('listed', 30_000, async () => (await names()).includes(name)))

  const renamed = await run.call<FileDone>('work.files.rename', { workspaceId: ws, ref, name: `${name} renamed`, op: op('rename') })
  run.check('Rename renames it in LifeOS', renamed.entries[0]?.name === `${name} renamed` && (await run.query<{ title?: string } | null>('docs:get', { id: ref.id }))?.title === `${name} renamed`, JSON.stringify(renamed).slice(0, 200))

  const before = (await run.call<{ sessions?: unknown[] } | unknown[]>('session.list', {}).catch(() => [])) as unknown
  const count = (list: unknown): number => (Array.isArray(list) ? list.length : ((list as { sessions?: unknown[] }).sessions?.length ?? -1))
  const opened = await run.call<FilesOpened>('work.files.open', { workspaceId: ws, ref, name: `${name} renamed` })
  run.check('it opens in a Files tab as a document, on the Files pane', !!opened.tabId && opened.item?.kind === 'document' && opened.item.sessionId === `filespane_${ws}`, JSON.stringify({ tabId: opened.tabId, kind: opened.item?.kind }))
  run.check('and no thread was made for it', count(await run.call('session.list', {}).catch(() => [])) === count(before))
  await run.call('work.files.tabClose', { workspaceId: ws, tabId: opened.tabId! })

  const gone = await run.call<FileDone>('work.files.trash', { workspaceId: ws, refs: [ref], op: op('trash') })
  run.check('Delete sends it to LifeOS\'s trash', (gone.trashed ?? []).length === 1 && gone.refused.length === 0, JSON.stringify(gone).slice(0, 300))
  run.check('the place no longer lists it', await run.until('unlisted', 30_000, async () => !(await names()).includes(`${name} renamed`)))
  run.check('LifeOS no longer reads it', (await run.query<unknown>('docs:get', { id: ref.id }).catch(() => null)) === null)
  const trash = await run.call<FilesListing>('work.files.list', { workspaceId: ws, at: { at: 'place', id: 'trash' } })
  const row = trash.entries.find((e) => e.key === `trash:lifeos:docs:${ref.id}`)
  run.check('the Trash lens lists it, by its name', row?.name === `${name} renamed`, trash.entries.map((e) => e.key).join(', ').slice(0, 300))

  const back = await run.call<FileDone>('work.files.restore', { workspaceId: ws, ids: [`lifeos:docs:${ref.id}`], op: op('restore') })
  run.check('Put Back restores it', back.refused.length === 0 && back.entries.some((e) => e.name === `${name} renamed`), JSON.stringify(back).slice(0, 300))
  run.check('the place lists it again, and LifeOS reads it', (await run.until('relisted', 30_000, async () => (await names()).includes(`${name} renamed`))) && (await run.query<{ title?: string } | null>('docs:get', { id: ref.id }))?.title === `${name} renamed`)

  // The end state: in LifeOS's trash, where its own purge takes it after 30 days.
  const last = await run.call<FileDone>('work.files.trash', { workspaceId: ws, refs: [ref], op: op('trash-again') })
  run.check('and it is taken away again at the end', (last.trashed ?? []).length === 1, JSON.stringify(last).slice(0, 200))
} catch (err) {
  await run.finish(err)
}
await run.finish()
