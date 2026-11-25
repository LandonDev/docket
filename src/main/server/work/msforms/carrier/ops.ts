import type { Screen } from '@shared/computer/outward'
import type { ComputerAction } from '@shared/computer/protocol'
import { builderOf, diffQuestions, formIdOf, isFormsUrl, isOther, MSFORM_NEW_SETTINGS, respondOf, type MsAnyQuestion, type MsChange, type MsFormSettings, type MsQuestion } from '@shared/work/msforms'
import { ACCEPT_RESPONSES, countOf, formOf, formTitleButton, linkOf, questionInEdit, questionsOf, savingOf, settingsOf, SETTINGS_CLOSE, titleOf } from './read'
import { click, first, isOn, one, Page, tab, typeInto, type FormsComputer } from './steps'
import { RESPONSES_VIEW_MS } from './pull'
import { CarrierBusy, CarrierRefused, CarrierSignIn, CarrierStop, checkAuth, makePayload, pullPayload, readPayload, settingsPayload, type CarrierAuth, type CarrierOp, type FormRead, type MakeAsk, type MsCarrier, type PullAsk } from './types'

/**
 * The carrier's operations on the box browser (docs/agents/work-msforms.md
 * "The carrier"): each a fixed program, each checking its authorization
 * before its first step and every step guarded for its operation
 * (guard.ts). Before a step that changes settings, who can answer or
 * collecting, it reads the form fresh and stops on any drift, saying what it
 * had done.
 */

const BUTTON = ['button', 'link', 'menu button']
const ITEM = ['menu item', 'button', 'link', 'option']
/** The library's New menu item that makes a form, with or without the file type SharePoint puts before it. */
export const FORMS_SURVEY = /^(?:xlsx\s+)?Forms survey$/i
const TOGGLE = ['checkbox', 'switch']
/** A new option's own name, as Forms draws an empty field: "Option 3". */
const PLACEHOLDER = /^Option \d+$/
const TYPE_BUTTON: Record<MsQuestion['type'], RegExp> = { choice: /^Choice$/, text: /^Text$/, rating: /^Rating$/, date: /^Date$/, section: /^Section$/ }

/**
 * What the host's own rows say a form is, read inside the queue (review 15): the job and rev a grant must name, and
 * where its answers workbook must be. Never taken from the grant or the call.
 */
export interface RowFacts {
  workspaceId: string
  rev: number
  /** the folder the workbook must sit in and the workbook as the row names it; null where its library is not reached */
  pull: { siteUrl: string; folderServerPath: string; uniqueId: string | null; name: string } | null
}

export interface OpsDeps {
  computer: FormsComputer
  host: string
  /** runs one operation with the box browser held: the queue, `useBoxBrowser`, his driving (session.ts) */
  exclusive<T>(fn: () => Promise<T>): Promise<T>
  /** the form's row as it stands, one row a form id; null when this host keeps none (or two) */
  rowOf(formId: string): RowFacts | null
  /** the folder's SharePoint page, made by the host from the library it reaches, for a job of this host; null when there is none */
  folderOf(workspaceId: string, folder: { libraryId: string; path: string }): { url: string } | null
  /** what the page needs before its controls show (a test's page answers at once) */
  patience?: { mount?: number; made?: number }
}

const short = (title: string): string => (title.length > 60 ? `${title.slice(0, 59)}…` : title)

/** A question's title as Forms reads back its at-rest name, for the check after an add. */
const sameTitle = (a: string, b: string): boolean => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()

export function opsCarrier(deps: OpsDeps): MsCarrier {
  const { computer } = deps
  const mount = deps.patience?.mount ?? 10_000
  const madeWait = deps.patience?.made ?? 30_000

  const refuse = (why: string): never => {
    throw new CarrierRefused(`The carrier refused: ${why}. Nothing was done in Forms.`)
  }

  /**
   * The authorization for a form, checked against the host's own rows: the job and the rev expected are the form's row
   * as it stands now (review 15), never the grant's own; the payload is the call that runs.
   */
  const authorized = (auth: CarrierAuth, op: CarrierOp, formId: string, payload: unknown): RowFacts => {
    const row = deps.rowOf(formId)
    if (!row) return refuse('that form is not one this computer keeps')
    checkAuth(auth, { host: deps.host, workspaceId: row.workspaceId, target: { formId }, op, payload, rev: row.rev })
    return row
  }
  /** Runs `fn` in the queue with the grant checked there, against the row as it stands in its turn. */
  const checked = <T>(auth: CarrierAuth, op: CarrierOp, formId: string, payload: unknown, fn: (row: RowFacts) => Promise<T>): Promise<T> => {
    // checked once before waiting (a refusal says so at once), and again in its turn: a row that moved meanwhile refuses
    authorized(auth, op, formId, payload)
    return deps.exclusive(() => fn(authorized(auth, op, formId, payload)))
  }

  /** Opens the form's builder in a window of its own, read once its title shows. */
  const openBuilder = async (formId: string, op: CarrierOp, suffix = ''): Promise<Page> => {
    const window = await computer.open(`${builderOf(formId)}${suffix}`)
    // Every read of the page checks its live form id against `formId` (steps.ts `Page.read`): a page with none is refused too.
    const page = new Page(computer, window, op, formId)
    const { got } = await page.until((s) => titleOf(s) !== '' || countOf(s) !== null, mount)
    if (!got) page.stop('the form did not open in Forms')
    return page
  }

  const closing = async <T>(page: Page | null, fn: () => Promise<T>): Promise<T> => {
    try {
      const out = await fn()
      // A change Forms is still saving is lost when its window closes (P1: a made form's title came back "Untitled form").
      if (page) {
        const { got } = await page.until((s) => !savingOf(s), mount)
        if (!got) page.stop('Forms did not finish saving the last change')
      }
      return out
    } finally {
      if (page) await computer.close(page.window).catch(() => {})
    }
  }

  /** The Settings panel, open. */
  const openSettings = async (page: Page): Promise<Screen> => {
    const s = page.last ?? (await page.read())
    if (one(s, TOGGLE, ACCEPT_RESPONSES)) return s
    await page.act((x) => {
      const b = one(x, BUTTON, /^Settings$/i)
      return b ? [click(b)] : null
    }, 'Settings')
    const { screen, got } = await page.until((x) => one(x, TOGGLE, ACCEPT_RESPONSES), mount)
    if (!got) page.stop('the Settings panel did not open')
    return screen
  }

  /** Sets one toggle in the open panel to `want`, read back. */
  const setToggle = async (page: Page, name: RegExp, want: boolean, words: string): Promise<void> => {
    const s = page.last ?? (await page.read())
    const t = one(s, TOGGLE, name)
    if (!t) return page.stop(`${words} was not in Settings`)
    if (isOn(t) === want) return
    await page.act((x) => {
      const y = one(x, TOGGLE, name)
      return y && isOn(y) !== want ? [click(y)] : null
    }, words)
    const back = one(page.last!, TOGGLE, name)
    if (isOn(back) !== want) page.stop(`${words} did not turn ${want ? 'on' : 'off'}`)
  }

  /** Who can answer, as asked: only the org (with its two boxes), or anyone. */
  const setAudience = async (page: Page, s: MsFormSettings): Promise<void> => {
    const radio = s.orgOnly ? /^Only people in .+ can respond/i : /^Anyone can respond/i
    const now = one(page.last!, ['radio'], radio)
    if (!now) return page.stop('who can fill out the form was not in Settings')
    if (!isOn(now)) {
      await page.act((x) => {
        const r = one(x, ['radio'], radio)
        return r ? [click(r)] : null
      }, s.orgOnly ? 'Only people in the organization' : 'Anyone can respond')
      if (!isOn(one(page.last!, ['radio'], radio))) page.stop('who can fill out the form did not change')
    }
    if (s.orgOnly) {
      await setToggle(page, /^Record name$/i, s.recordName, 'Record name')
      await setToggle(page, /^One response per person$/i, s.onePerPerson, 'One response per person')
    }
  }

  /** A date toggle and its field, as asked: absent turns it off. */
  const setDate = async (page: Page, name: 'Start date' | 'End date', value: string | undefined): Promise<void> => {
    const re = new RegExp(`^${name}$`, 'i')
    const box = one(page.last!, TOGGLE, re)
    if (!box) return value ? page.stop(`${name} was not in Settings`) : undefined
    if (!value) return setToggle(page, re, false, name)
    await setToggle(page, re, true, name)
    await page.act((x) => {
      const field = first(x, ['date', 'input'], new RegExp(`^${name}`, 'i'))
      return field ? [typeInto(field, value), tab(field)] : null
    }, name)
  }

  /** The question being edited, mounted, after a click that opens it. */
  const editing = async (page: Page) => {
    const { got } = await page.until((x) => questionInEdit(x), mount)
    return got
  }

  /** Writes a question's fields into the one in edit: its title, its options, its switches, each committed by Tab. */
  const fill = async (page: Page, q: MsQuestion): Promise<void> => {
    let edit = await editing(page)
    if (!edit) return page.stop(`the question "${short(q.title)}" did not open for editing`)
    await page.act((x) => {
      const e = questionInEdit(x)
      return e ? [typeInto(e.title, q.title), tab(e.title)] : null
    }, `the title "${short(q.title)}"`)
    if (q.type === 'choice') {
      const want = q.options ?? []
      // Forms redraws an option's row as Tab commits it, and the tree lacks that row until the next press (P5): a count
      // read then took a second Add option and left Forms' "Option 4" behind, and a wait for the row never ended. So the
      // fields are never counted: each option goes into the next field still holding Forms' own "Option N", Add option
      // is pressed only when none shows, and the options are checked at rest, once the question is left.
      const placeholders = (x: Screen) => (questionInEdit(x)?.options ?? []).filter((o) => PLACEHOLDER.test((o.value ?? '').trim()))
      // an option asked for in Forms' own words ("Option 2") keeps its field a placeholder: those are passed over
      let kept = 0
      for (let i = 0; i < want.length; i++) {
        const skip = kept
        // an empty field shows whole (only a typed row is redrawn): Add option only when none does
        let { got } = await page.until((x) => placeholders(x)[skip], Math.min(mount, 3_000))
        if (!got) {
          await page.act((x) => {
            const e = questionInEdit(x)
            return e?.addOption ? [click(e.addOption)] : null
          }, 'Add option')
          got = (await page.until((x) => placeholders(x)[skip], mount)).got
        }
        if (!got) return page.stop(`the option "${short(want[i])}" found no empty field`)
        // Never Return in an option field: it takes a suggestion chip.
        await page.act((x) => {
          const field = placeholders(x)[skip]
          return field ? [typeInto(field, want[i]), tab(field)] : null
        }, `the option "${short(want[i])}"`)
        if (PLACEHOLDER.test(want[i].trim())) kept++
      }
      // Fields Forms put there that were not asked for go, each read afresh (P1: an "Option 4" was left behind). An
      // option's Delete is the first Delete after its field, whatever its words, drawn only while its row is hovered.
      for (let guard = 0; guard < 20; guard++) {
        if (!placeholders(await page.read())[kept]) break
        await page.act((x) => {
          const field = placeholders(x)[kept]
          const del = field ? [...x.elements.values()].filter((e) => e.role === 'button' && e.index > field.index && /^Delete\b/.test(e.name ?? '') && !/^Delete question\b/.test(e.name ?? '')).sort((a, b) => a.index - b.index)[0] : null
          return del && field ? [{ action: 'mouse_move', element: field.index } as ComputerAction, click(del)] : null
        }, 'removing an option Forms added')
      }
      await toggleIn(page, 'multiple', Boolean(q.multiple), 'Multiple answers')
    }
    if (q.type === 'text') await toggleIn(page, 'long', Boolean(q.long), 'Long answer')
    // Required is set on every new question: Forms copies it from the last one.
    if (q.type !== 'section') await toggleIn(page, 'required', q.required, 'Required')
  }

  const toggleIn = async (page: Page, which: 'required' | 'multiple' | 'long', want: boolean, words: string): Promise<void> => {
    const e = questionInEdit(page.last!)
    const t = e?.[which]
    if (!t) return want ? page.stop(`${words} was not on the question`) : undefined
    if (isOn(t) === want) return
    await page.act((x) => {
      const y = questionInEdit(x)?.[which]
      return y && isOn(y) !== want ? [click(y)] : null
    }, words)
  }

  /** Adds one question at the end and checks it shows. */
  const addQuestion = async (page: Page, q: MsQuestion, before: number): Promise<void> => {
    const s = page.last!
    const add = one(s, BUTTON, /^(Add new question|Quick start with)$/i)
    const kind = one(s, BUTTON, TYPE_BUTTON[q.type])
    if (!kind) {
      if (!add) return page.stop(`"Add new question" was not on the page for "${short(q.title)}"`)
      await page.act((x) => {
        const a = one(x, BUTTON, /^(Add new question|Quick start with)$/i)
        return a ? [click(a)] : null
      }, 'Add new question')
    }
    await page.act((x) => {
      const k = one(x, BUTTON, TYPE_BUTTON[q.type])
      return k ? [click(k)] : null
    }, `the ${q.type} question type`)
    await fill(page, q)
    // Leaving the question commits it (Forms saves on leaving it); then it must show at rest, last, by its title. It is
    // left by the form's own title: "Add new question" pressed while a question is open inserts one above it and leaves
    // it open (P5). The title field that opens is left by Tab, unchanged.
    await page.act((x) => {
      const b = formTitleButton(x)
      return b ? [click(b)] : null
    }, 'leaving the question')
    const { got: titleField } = await page.until((x) => one(x, ['text area', 'input'], /^Form title$/), mount)
    if (titleField) {
      await page.act((x) => {
        const f = one(x, ['text area', 'input'], /^Form title$/)
        return f ? [tab(f)] : []
      }, 'leaving the form title')
    }
    const { got } = await page.until((x) => {
      const list = questionsOf(x)
      return list.length > before && sameTitle(list[list.length - 1]?.title ?? '', q.title)
    }, mount)
    if (!got) page.stop(`the question "${short(q.title)}" did not show after Add`)
    if (q.type === 'choice') {
      const shown = questionsOf(page.last!).at(-1)
      const options = shown && 'options' in shown ? (shown.options ?? []) : []
      if (JSON.stringify(options.map((o) => o.trim())) !== JSON.stringify((q.options ?? []).map((o) => o.trim()))) page.stop(`the question "${short(q.title)}" shows other options than asked`)
    }
  }

  /** Puts a question at rest into edit by its place. */
  const openQuestion = async (page: Page, at: number, list: readonly MsAnyQuestion[]): Promise<void> => {
    await page.act((x) => {
      const b = one(x, BUTTON, new RegExp(`^${at + 1}\\.\\s*Question title\\b`))
      return b ? [click(b)] : null
    }, `the question "${short(list[at]?.title ?? String(at + 1))}"`)
  }

  /** Reads the builder fresh and stops when its questions are not `before`: someone changed the form since. */
  const noDrift = (page: Page, before: readonly MsAnyQuestion[], what: string): void => {
    const now = questionsOf(page.last!)
    const moved = diffQuestions(before, now)
    if (moved.length) page.stop(`the form in Forms is not as it was read (${moved.slice(0, 2).join('; ')}), so ${what} was not done`, formOf(page.last!))
  }

  const changeOne = async (page: Page, c: MsChange, list: MsAnyQuestion[]): Promise<MsAnyQuestion[]> => {
    switch (c.op) {
      case 'add': {
        await addQuestion(page, c.question, list.length)
        let next = [...list, c.question]
        const target = (c.after ?? list.length - 1) + 1
        for (let at = next.length - 1; at > target; at--) {
          await openQuestion(page, at, next)
          await page.act((x) => {
            const up = one(x, BUTTON, new RegExp(`^Move question up\\b`))
            return up ? [click(up)] : null
          }, 'Move question up')
          next = [...next.slice(0, at - 1), next[at], next[at - 1], ...next.slice(at + 1)]
        }
        return next
      }
      case 'change': {
        if (isOther(list[c.at])) page.stop(`"${short(list[c.at].title)}" is a kind of question only the Forms page changes`)
        await openQuestion(page, c.at, list)
        await fill(page, c.question)
        const next = [...list]
        next[c.at] = c.question
        return next
      }
      case 'remove': {
        await openQuestion(page, c.at, list)
        await page.act((x) => {
          const d = one(x, BUTTON, /^Delete question\b/i)
          return d ? [click(d)] : null
        }, `Delete "${short(list[c.at].title)}"`)
        return list.filter((_, i) => i !== c.at)
      }
      case 'move': {
        let at = c.at
        let next = [...list]
        while (at !== c.to) {
          await openQuestion(page, at, next)
          const up = c.to < at
          await page.act((x) => {
            const b = one(x, BUTTON, new RegExp(`^Move question ${up ? 'up' : 'down'}\\b`))
            return b ? [click(b)] : null
          }, `Move "${short(list[c.at].title)}"`)
          const to = up ? at - 1 : at + 1
          ;[next[at], next[to]] = [next[to], next[at]]
          next = [...next]
          at = to
        }
        return next
      }
    }
  }

  const changeWordsDone = (c: MsChange, list: readonly MsAnyQuestion[]): string =>
    c.op === 'add' ? `added "${short(c.question.title)}"` : c.op === 'remove' ? `removed "${short(list[c.at]?.title ?? '')}"` : c.op === 'move' ? `moved "${short(list[c.at]?.title ?? '')}"` : `changed "${short(list[c.at]?.title ?? '')}"`

  /** The form as a final read sees it: the Settings panel opened first (a click there commits a question in edit), then one read of both. */
  const finalRead = async (page: Page, formId: string, settings = true): Promise<FormRead> => {
    if (!settings) return formOf(await page.read(), { formId })
    const panel = await openSettings(page)
    // A toggle the panel does not show is read as on: an unread Accept responses never passes for off.
    return formOf(panel, { formId, was: { ...MSFORM_NEW_SETTINGS, accepting: true } })
  }

  return {
    async read(auth, formId) {
      // a read grant of its own: it presses only Settings open and closed, and changes nothing
      return checked(auth, 'read', formId, readPayload(formId), async () => {
        const page = await openBuilder(formId, 'read')
        return closing(page, () => finalRead(page, formId))
      })
    },

    async make(auth, ask: MakeAsk) {
      const workspaceId = ask.workspaceId
      // The folder's page is the host's own, from the library it reaches for this job: the call's address must be it,
      // the grant must name it, and only it is opened.
      const expected = (): string => {
        const page = deps.folderOf(workspaceId, ask.folder)
        if (!page) return refuse('that folder is not one this job may make a form in on this computer')
        if (page.url !== ask.folderUrl) refuse("the folder's page is not the one this computer makes for it")
        checkAuth(auth, { host: deps.host, workspaceId, target: { folder: ask.folder }, op: 'make', payload: makePayload({ ...ask, folderUrl: page.url }), rev: 0 })
        return page.url
      }
      expected()
      return deps.exclusive(async () => {
        ask.stage?.('opening')
        const folderUrl = expected()
        const folderWindow = await computer.open(folderUrl)
        const folder = new Page(computer, folderWindow, 'make')
        let formId: string | null = null
        let window: string | null = null
        try {
          const { got } = await folder.until((s) => one(s, BUTTON, /^(Create or upload|New)$/i), mount)
          if (!got) folder.stop('the folder\'s "Create or upload" was not on its page, so no form was made')
          ask.stage?.('making')
          await folder.act((x) => {
            const b = one(x, BUTTON, /^(Create or upload|New)$/i)
            return b ? [click(b)] : null
          }, 'Create or upload')
          await folder.act((x) => {
            // SharePoint names it with its file type first: "xlsx Forms survey" (P1, 2026-11-24)
            const item = one(x, ITEM, FORMS_SURVEY)
            return item ? [click(item)] : null
          }, 'Forms survey')
          // The new form opens in a window the folder's page opened (Chromium's opener), or in the folder's page itself;
          // its id is in that page's address once Forms has made it. No other page is looked at: a Forms page another
          // tab opened meanwhile is never taken for this job's form (review 16).
          for (let waited = 0; waited <= madeWait && !formId; waited += 250) {
            const mine = (await computer.windows()).filter((w) => w.id === folderWindow || w.opener === folderWindow)
            const made = mine.flatMap((w) => (isFormsUrl(w.url) && formIdOf(w.url) ? [{ id: formIdOf(w.url)!, window: w.id }] : []))
            if (made.length > 1) folder.stop("the folder's page opened more than one form, so none was taken")
            if (made.length === 1) {
              formId = made[0]!.id
              window = made[0]!.window
            } else await computer.wait(250)
          }
        } finally {
          // the folder's page may itself be the form's now: then it stays open for the form's steps
          if (window !== folderWindow) await computer.close(folderWindow).catch(() => {})
        }
        if (!formId || !window) throw new CarrierStop('Forms did not show the new form in time. It may have made one in the folder: look in Forms before trying again.', null, null)
        const page = new Page(computer, window, 'make', formId)
        try {
          return await closing(page, async () => {
            const { got } = await page.until((s) => titleOf(s) !== '', mount)
            // The welcome page has no title: nothing is pressed on it.
            if (!got) page.stop('Forms opened its welcome page, not the new form; nothing was pressed there', { ...emptyRead(formId!), settings: { ...MSFORM_NEW_SETTINGS, accepting: true } })
            // The first step on the new form: Accept responses off, read back.
            ask.stage?.('setting')
            try {
              await openSettings(page)
              await setToggle(page, ACCEPT_RESPONSES, false, 'Accept responses')
            } catch (err) {
              // the stop says a fixed sentence; what failed is for a proof's own log (TC_CARRIER_DEBUG)
              if (process.env.TC_CARRIER_DEBUG) console.error('[carrier] make: Accept responses off failed:', err)
              const read = formOf(page.last ?? (await page.read()), { formId: formId! })
              throw new CarrierStop(MAY_TAKE_ANSWERS_STOP, { ...read, formId: formId!, settings: { ...read.settings, accepting: true } })
            }
            page.done.push(ACCEPT_OFF_DONE)
            await setAudience(page, ask.settings)
            await setDate(page, 'Start date', ask.settings.startDate)
            await setDate(page, 'End date', ask.settings.endDate)
            page.done.push('set who can answer')
            // the panel as set, read back: what the final read keeps for the toggles it no longer shows (Accept responses unread is on)
            const panel = settingsOf(page.last ?? (await page.read()), { ...MSFORM_NEW_SETTINGS, accepting: true })
            await page.act((x) => {
              const close = one(x, BUTTON, SETTINGS_CLOSE)
              return close ? [click(close)] : []
            }, 'closing Settings')
            // The title first, so the workbook takes it.
            ask.stage?.('naming')
            await page.act((x) => {
              const b = formTitleButton(x)
              return b ? [click(b)] : null
            }, 'the form title')
            const { got: field } = await page.until((x) => one(x, ['text area', 'input'], /^Form title$/), mount)
            if (!field) page.stop('the form title did not open for typing', formOf(page.last!, { formId: formId! }))
            await page.act((x) => {
              const f = one(x, ['text area', 'input'], /^Form title$/)
              return f ? [typeInto(f, ask.title), tab(f)] : null
            }, 'the form title')
            if (ask.description) {
              await page.act((x) => {
                const d = one(x, ['input', 'text area'], /^Form description$/)
                return d ? [typeInto(d, ask.description), tab(d)] : null
              }, 'the description')
            }
            page.done.push(`named it "${short(ask.title)}"`)
            if (ask.questions.length) ask.stage?.('asking')
            for (let i = 0; i < ask.questions.length; i++) {
              try {
                await addQuestion(page, ask.questions[i], i)
              } catch {
                const read = formOf(await page.read(), { formId: formId! })
                throw new CarrierStop(`Made the form and added ${i} of ${ask.questions.length} questions; the next, "${short(ask.questions[i].title)}", did not show after Add. The form holds the first ${i}.`, read)
              }
            }
            // With no questions (New → Form in Files) nothing can be left in edit: the builder is read once it has
            // saved, its settings those the panel read back, so Settings is not opened a second time (about 4 s).
            if (!ask.questions.length) {
              const { screen } = await page.until((x) => !savingOf(x) && titleOf(x) !== '', mount)
              return { read: formOf(screen, { formId: formId!, was: panel }) }
            }
            return { read: await finalRead(page, formId!) }
          })
        } catch (err) {
          throw keptStop(page, formId, err)
        }
      })
    },

    async write(auth, formId, changes, before) {
      return checked(auth, 'write', formId, { changes, before }, async () => {
        const page = await openBuilder(formId, 'write')
        return closing(page, async () => {
          // An agent writes only a form that takes no answers, read so inside this very run.
          if (auth.by === 'pillar') {
            const panel = await openSettings(page)
            const accept = one(panel, ['checkbox', 'switch'], /^Accept responses$/i)
            if (!accept || isOn(accept)) page.stop('the form takes answers now (or its Settings did not say), so no change was made; it waits for the owner')
            await page.act((x) => {
              const close = one(x, BUTTON, /^(Close|Close settings)$/i)
              return close ? [click(close)] : []
            }, 'closing Settings')
          }
          noDrift(page, before, 'no change')
          let list = [...before]
          for (let i = 0; i < changes.length; i++) {
            try {
              list = await changeOne(page, changes[i], list)
            } catch (err) {
              const read = formOf(await page.read(), { formId })
              const did = changes.slice(0, i).map((c, k) => changeWordsDone(c, k === 0 ? before : list))
              throw new CarrierStop(`${did.length ? `Did ${i} of ${changes.length} changes (${did.join('; ')}); the next` : 'The first change'}, ${changeWordsDone(changes[i], list)}, did not take: ${(err as Error).message.replace(/\.$/, '')}. The form holds what was done.`, read)
            }
            page.done.push(changeWordsDone(changes[i], list))
          }
          return { read: await finalRead(page, formId) }
        })
      })
    },

    async settings(auth, formId, patch) {
      return checked(auth, 'settings', formId, patch, async () => {
        const page = await openBuilder(formId, 'settings')
        return closing(page, async () => {
          const panel = await openSettings(page)
          const now = settingsOf(panel)
          // An agent's settings run only on a draft: Accept responses must read off.
          // A closing end date is the one setting an agent sets on a form taking answers.
          const onlyEnd = Object.keys(patch).every((k) => k === 'endDate')
          if (auth.by === 'pillar' && now.accepting && !onlyEnd) page.stop('the form takes answers now, so its settings were not changed')
          // An agent's end date only shortens the window; a later one, or none, waits for the owner.
          if (auth.by === 'pillar' && now.accepting && !shortens(now.endDate, patch.endDate)) page.stop('a later end date, or none, lets more people answer, so it was not set; it waits for the owner')
          if (patch.orgOnly === false && now.orgOnly && auth.by === 'pillar') page.stop('who can answer is not widened without the owner\'s press')
          if (patch.orgOnly !== undefined || patch.recordName !== undefined || patch.onePerPerson !== undefined) await setAudience(page, { ...now, ...patch })
          if ('startDate' in patch) await setDate(page, 'Start date', patch.startDate)
          if ('endDate' in patch) await setDate(page, 'End date', patch.endDate)
          if (patch.accepting === false) await setToggle(page, ACCEPT_RESPONSES, false, 'Accept responses')
          return { read: await finalRead(page, formId) }
        })
      })
    },

    async collect(auth, formId, settings) {
      return checked(auth, 'collect', formId, settingsPayload(settings), async () => {
        const page = await openBuilder(formId, 'collect')
        return closing(page, async () => {
          await openSettings(page)
          await setAudience(page, settings)
          await setDate(page, 'Start date', settings.startDate)
          await setDate(page, 'End date', settings.endDate)
          await setToggle(page, ACCEPT_RESPONSES, true, 'Accept responses')
          page.done.push('turned Accept responses on')
          await page.act((x) => {
            const b = one(x, BUTTON, /^Collect responses$/i)
            return b ? [click(b)] : null
          }, 'Collect responses')
          // The link is read from the dialog, never sent or copied from it.
          const { got } = await page.until((x) => linkOf(x), mount)
          const link = got && formIdOf(got) === formId ? got : respondOf(formId)
          await page.act((x) => {
            const close = one(x, BUTTON, /^Close$/i)
            return close ? [click(close)] : []
          }, 'closing the dialog')
          const read = await finalRead(page, formId)
          return { read: { ...read, link }, link }
        })
      })
    },

    async audience(auth, formId, settings) {
      return checked(auth, 'audience', formId, settingsPayload(settings), async () => {
        const page = await openBuilder(formId, 'audience')
        return closing(page, async () => {
          await openSettings(page)
          await setAudience(page, settings)
          return { read: await finalRead(page, formId) }
        })
      })
    },

    async close(auth, formId, open) {
      if (open && auth.by === 'pillar') throw new CarrierRefused('The carrier refused: an agent\'s reopen waits for the owner\'s press. Nothing was done in Forms.')
      return checked(auth, 'close', formId, { open }, async () => {
        const page = await openBuilder(formId, 'close')
        return closing(page, async () => {
          await openSettings(page)
          await setToggle(page, ACCEPT_RESPONSES, open, 'Accept responses')
          return { read: await finalRead(page, formId) }
        })
      })
    },

    async count(auth, formId) {
      return checked(auth, 'count', formId, readPayload(formId), async () => {
        const page = await openBuilder(formId, 'count', '&analysis=true')
        return closing(page, async () => {
          const { screen, got } = await page.until((x) => countOf(x) !== null, Math.max(mount, RESPONSES_VIEW_MS))
          if (got === null) page.stop('the Responses view showed no count')
          return { count: countOf(screen) ?? 0, read: formOf(screen, { formId }) }
        })
      })
    },

    async pull(auth, formId, ask: PullAsk) {
      const { pullWorkbook } = await import('./pull')
      return checked(auth, 'pull', formId, pullPayload(formId, ask), (row) => {
        // the folder and the workbook the call names must be the row's own, read now: a grant made for them is not enough
        const want = row.pull
        if (!want) return refuse('the folder that form was made in is not one this computer reaches now')
        if (want.siteUrl !== ask.siteUrl || want.folderServerPath !== ask.folderServerPath) refuse("the workbook was asked of another folder than the form's own")
        if (want.uniqueId !== ask.uniqueId || want.name !== ask.name) refuse("the workbook asked for is not the one the form's row names")
        return pullWorkbook({ computer, mount, openResponses: () => openBuilder(formId, 'pull', '&analysis=true') }, formId, ask)
      })
    }
  }
}

/** Whether an end date moves the close earlier: a date where there was none, or an earlier one. Unreadable dates do not. */
export function shortens(now: string | undefined, next: string | undefined): boolean {
  if (!next) return false
  const n = Date.parse(next)
  if (Number.isNaN(n)) return false
  if (!now) return true
  const c = Date.parse(now)
  return !Number.isNaN(c) && n < c
}


const ACCEPT_OFF_DONE = 'made the form with Accept responses off'
const MAY_TAKE_ANSWERS_STOP = 'The form was made but may take answers until Accept responses is off. Open it and turn that off, or delete it.'

/**
 * A make that fails once Forms has made the form, in any way (the box browser stopped under its memory cap, a sign-in,
 * his driving), names the form, so its row is kept and he sees it: a form in Forms that no row knows is one he can
 * neither see nor delete from Work (P5: a browser stopped mid-make left one). Whether it may take answers is said
 * from what the make had done.
 */
export function keptStop(page: Page, formId: string, err: unknown): CarrierStop {
  if (err instanceof CarrierStop && err.formId) return err
  if (!page.done.includes(ACCEPT_OFF_DONE)) return new CarrierStop(MAY_TAKE_ANSWERS_STOP, null, formId)
  const why = err instanceof CarrierSignIn ? 'Microsoft asked for a sign-in' : err instanceof CarrierBusy ? 'the box browser was taken for driving' : 'the box browser stopped'
  return new CarrierStop(`${page.done.join('; ')}; then ${why} before the make finished. The form is in Forms as far as it got.`, { ...emptyRead(formId), settings: { ...MSFORM_NEW_SETTINGS, accepting: false } }, formId)
}

const emptyRead = (formId: string): FormRead => ({ formId, title: '', description: '', questions: [], settings: MSFORM_NEW_SETTINGS, count: null, signedInAs: null, link: null })

/** Steps the guard allows for one operation, exported for tests that send a step straight at it. */
export type GuardedStep = ComputerAction
