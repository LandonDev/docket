/**
 * The Work perf proof's own seeds (docs/IOS-DESIGN.md "The Work perf proof", `TC_PROOF_SET=work-perf`): the `editor`
 * run's document, a `.tcdoc` open as a `document` item in a Purdue thread of its own, so the reader route opens the
 * hosted editor where the host can serve it. The list runs need no seed: their fixture list is the app's own.
 */
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { socket, type WorkSeedReady } from './ios-work-seeds'

export const EDITOR_THREAD_TITLE = 'Perf editor'
export const EDITOR_ITEM_TITLE = 'Perf poster'

/** The editor run's thread and document; each line says what was seeded or why it was not. */
export async function seedWorkPerfEditor(ready: WorkSeedReady & { environmentId: string }, purdue: string): Promise<string[]> {
  const s = await socket(ready)
  const lines: string[] = []
  try {
    const workspaces = await s.call<{ id: string; path: string }[]>('workspace.list', {})
    const dir = `${workspaces.find((w) => w.id === purdue)!.path}/Perf`
    mkdirSync(dir, { recursive: true })
    const path = `${dir}/${EDITOR_ITEM_TITLE}.tcdoc`
    try {
      // work-kit has no exports map; the server reaches it through its path alias, this script by file.
      const kit = resolve(import.meta.dir, '../../node_modules/work-kit/src/formats')
      const { readMarkdown } = (await import(`${kit}/markdown/index.ts`)) as { readMarkdown: (text: string) => unknown }
      const { writeImportedTcdoc } = (await import(`${kit}/tcdoc/index.ts`)) as { writeImportedTcdoc: (path: string, imported: unknown) => Promise<unknown> }
      const body = Array.from({ length: 40 }, (_, i) => `## Part ${i + 1}\n\nThe arena opens at nine. Teams check in at the front desk and take their table numbers.`).join('\n\n')
      await writeImportedTcdoc(path, readMarkdown(`# Spring LAN\n\n${body}`))
    } catch (err) {
      lines.push(`NOT RUN editor: could not write the .tcdoc (${String(err)})`)
      return lines
    }
    const thread = await s.call<{ id: string }>('session.create', { scope: 'work', workspaceId: purdue, threadType: 'chat', provider: 'claude', model: 'claude-opus-5-5', title: EDITOR_THREAD_TITLE })
    await s.call('work.canvas.open', { sessionId: thread.id, kind: 'document', title: EDITOR_ITEM_TITLE, source: { at: 'file', host: ready.environmentId, path } })
    lines.push(`OK editor: "${EDITOR_ITEM_TITLE}" open in "${EDITOR_THREAD_TITLE}"`)
  } catch (err) {
    lines.push(`NOT RUN editor: ${String(err)}`)
  } finally {
    s.close()
  }
  return lines
}
