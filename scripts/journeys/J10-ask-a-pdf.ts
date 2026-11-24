import { join } from 'node:path'
import { fixtures, openRow } from './lib/files'
import { journey, step } from './lib/record'

const QUESTION = 'What does page 3 say?'
const DOCK = '[data-files-dock]'
const INPUT = `${DOCK} [data-composer-input]`
const pdfName = (name: string): string => name + ' Practice plan.pdf'

export default journey({
  id: 'J10',
  title: 'Ask a question beside a PDF',
  tier: 1,
  shapes: ['A', 'B1'],
  steps: [
    step('Open the PDF and wait for the first page', async ({ pair, shape, workspace }) => {
      const page = pair.page
      const place = shape === 'A' ? workspace.path : join(pair.l1, workspace.name)
      fixtures(pair.repo, place, workspace.name + ' Practice plan')
      // A chat left docked by the walk before folds Files' sidebar (under 900px of view), and the library's row with it.
      await page.eval(`document.querySelector('[data-files-dock] button[aria-label="Close chat"]')?.click()`)
      await page.clickOn('button, a, [role="link"], [role="treeitem"], div', workspace.name)
      await page.clickOn('button, a, [role="link"], div', 'Files')
      if (shape === 'B1') {
        await page.clickOn('button, a, [role="link"], div', 'Journey Teams L1')
        await openRow(page, 'General')
        await openRow(page, workspace.name)
      }
      await openRow(page, pdfName(workspace.name))
      await page.until('the first PDF page to draw', 60_000, () => page.eval(`!!document.querySelector('[data-pdf-page="1"] canvas')?.width`))
    }),
    step('Press Ask', async ({ pair, workspace }) => {
      const page = pair.page
      await page.clickOn('[data-files-header] button', 'Ask')
      await page.until('the PDF chat and its file chip', 20_000, () => page.eval(`(() => {
        const dock = document.querySelector(${JSON.stringify(DOCK)});
        return dock?.querySelector('[data-composer-input]') && dock.innerText.includes(${JSON.stringify(pdfName(workspace.name))});
      })()`))
    }),
    step('Type the page 3 question and send', async ({ pair }) => {
      const page = pair.page
      await page.clickOn(INPUT)
      await page.typeKeys(QUESTION)
      await page.until('the question in the dock', 10_000, () => page.eval(`document.querySelector(${JSON.stringify(INPUT)})?.textContent.trim() === ${JSON.stringify(QUESTION)}`))
      await page.clickOn(`${DOCK} button`, 'Send')
    }),
    step('end: box keeps the Work chat with its file and the PDF stays beside it', async ({ pair, workspace }) => {
      const { Database } = await import('bun:sqlite')
      const db = new Database(join(pair.box.data, 'temp-code.db'), { readonly: true })
      const failures: string[] = []
      try {
        const sessions = db.query<{ id: string; scope: string; permission: string }, [string]>(
          'SELECT id, scope, permission FROM sessions WHERE workspace_id = ?'
        )
        const attached = db.query<{ id: string }, [string, string]>(
          "SELECT id FROM work_canvas_items WHERE session_id = ? AND title = ? AND kind = 'pdf' AND state = 'open'"
        )
        const events = db.query<{ payload: string }, [string]>('SELECT payload FROM events WHERE session_id = ?')
        const name = pdfName(workspace.name)
        await pair.page.until('the Work chat with the PDF on box', 8000, () =>
          sessions.all(workspace.id).some((row) => row.scope === 'work' && row.permission === 'auto' &&
            attached.get(row.id, name) && events.all(row.id).some(({ payload }) => {
              const event = JSON.parse(payload) as { type?: string; text?: string }
              return event.type === 'user-text' && event.text?.includes(QUESTION) &&
                event.text.split('\n').some((line) => line.startsWith('About this file: ') && line.includes(name))
            }))
        ).catch((error) => {
          const rows = sessions.all(workspace.id)
          failures.push(rows.length ? `Box has ${rows.length} session row(s), but none has Work scope, Full access, the attached PDF and the sent question` : 'Box has no session for this workspace')
          if (!(error instanceof Error) || !error.message.startsWith('Timed out')) throw error
        })
      } finally {
        db.close()
      }
      const beside = await pair.page.eval(`(() => {
        // The page, not its canvas: the page's text layer lies over the canvas and takes the point.
        const pdf = document.querySelector('[data-pdf-page="1"]');
        const dock = document.querySelector('[data-files-dock-seat="beside"]');
        if (!pdf?.querySelector('canvas')?.width || !dock) return false;
        const page = pdf.getBoundingClientRect();
        const chat = dock.getBoundingClientRect();
        return page.width > 0 && chat.width > 0 && page.right <= chat.left + 1 && pdf.contains(document.elementFromPoint(page.x + page.width / 2, page.y + 30));
      })()`)
      if (!beside) failures.push('The PDF is no longer visible beside the chat')
      if (failures.length) throw new Error(failures.join('. '))
    })
  ]
})
