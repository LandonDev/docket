import { screenOfObservation, type Screen } from '@shared/computer/outward'
import type { ComputerAction } from '@shared/computer/protocol'
import { builderOf, type MsAnyQuestion, type MsFormSettings, type MsQuestion } from '@shared/work/msforms'
import type { FormsComputer } from './steps'

/**
 * A Forms page for tests, drawn in the trial's names (trial-raw.md §5) as the
 * box browser's read prints them: a builder with its title, questions,
 * Settings panel and Collect responses dialog, and a SharePoint folder page
 * whose "Forms survey" makes one. Every read numbers its elements afresh, so
 * a step that reuses an index from an older read misses, as on the real page.
 * `log` keeps every step the carrier took, by what it pressed.
 */

const q = (s: string): string => JSON.stringify(s)
const TYPE_WORD: Record<MsQuestion['type'], string> = { choice: 'Choice', text: 'Text', rating: 'Rating', date: 'Date', section: 'Section' }

export interface FakeFormState {
  formId: string
  title: string
  description: string
  questions: MsAnyQuestion[]
  settings: MsFormSettings
  count: number
}

interface Editing {
  at: number
  draft: MsQuestion
}

type Hit = { what: string; run(text?: string): void }

export class FakeForms implements FormsComputer {
  readonly forms = new Map<string, FakeFormState>()
  readonly log: string[] = []
  /** pages by window id: a builder of a form, or a folder */
  private pages = new Map<string, { kind: 'builder'; formId: string; results?: boolean } | { kind: 'folder'; menu: boolean } | { kind: 'site'; url: string }>()
  /** the page each popup was opened from, as Chromium's openerId says it */
  private openers = new Map<string, string>()
  /** another Forms page opens at the same moment as a make's, from some other page, after the make's own */
  stray = false
  strayId: string | null = null
  /** the make's new page reports no opener (a browser that does not say one) */
  noOpener = false
  private ui = new Map<string, { panel: boolean; dialog: boolean; adding: boolean; editing: Editing | null; titleEdit: boolean }>()
  private hits = new Map<number, Hit>()
  private render = 0
  private nextWindow = 1
  /** a toggle this page will not turn, by its name: the next press on it does nothing */
  stuck = new Set<string>()
  /** questions whose title the page drops on Tab (an add that "does not show") */
  dropTitles = new Set<string>()
  /** pages a folder's Forms survey makes start with Accept responses on, as Forms does */
  made = 0
  /** the next Forms survey opens Forms' welcome page instead */
  welcome = false
  /** the form's own title button is drawn twice (a page whose layout moved): which to press is not known, so a make stops at its title */
  twoTitles = false
  /** how many more reads show the last change still saving ("… Saving...") */
  saving = 0
  /** the page never says the change is saved */
  neverSaves = false
  /** as Forms does (P5): the option field last typed in or added is drawn as a text area, the others as inputs */
  activeAsTextArea = false
  private activeOption: number | null = null
  /** as Forms does (P5): "Add new question" pressed while a question is open inserts above it and leaves it open */
  insertsBetween = false
  /** forms deleted in Forms: their builder draws Forms' "This form doesn't exist" page (P5) */
  gone = new Set<string>()
  /** the browser stops once a step of this name was taken (the box browser's memory cap, P5): every call after it fails */
  diesAfter: string | null = null
  private dead = false
  files = new Map<string, { UniqueId: string; Name: string; ServerRelativeUrl: string; TimeLastModified: string; bytes: Uint8Array }>()

  add(form: FakeFormState): void {
    this.forms.set(form.formId, form)
  }

  async open(url: string): Promise<string> {
    const id = `#${this.nextWindow++}`
    const m = /[?&]id=([^&]+)/.exec(url)
    if (/forms\.cloud\.microsoft/.test(url) && m) this.pages.set(id, { kind: 'builder', formId: decodeURIComponent(m[1]), results: /analysis=true/.test(url) })
    else if (/\/_api\//.test(url) || !/AllItems\.aspx/.test(url)) this.pages.set(id, { kind: 'site', url })
    else this.pages.set(id, { kind: 'folder', menu: false })
    this.ui.set(id, { panel: false, dialog: false, adding: false, editing: null, titleEdit: false })
    this.log.push(`open ${url}`)
    return id
  }
  async windows() {
    return [...this.pages.entries()].map(([id, p]) => ({
      id,
      url: p.kind === 'builder' ? builderOf(p.formId) : p.kind === 'site' ? p.url : 'https://purdue0.sharepoint.com/sites/RecWell/Shared%20Documents/Forms/AllItems.aspx',
      ...(this.openers.has(id) ? { opener: this.openers.get(id)! } : {})
    }))
  }
  async close(window: string): Promise<void> {
    this.pages.delete(window)
    this.log.push(`close ${window}`)
  }
  async wait(): Promise<void> {}
  async fetch(_window: string, url: string, o: { bytes?: boolean } = {}) {
    const byId = /GetFileById\('([^']+)'\)/.exec(url)
    const byPath = /GetFileByServerRelativeUrl\('([^']+)'\)/.exec(url)
    const folder = /GetFolderByServerRelativeUrl\('([^']+)'\)/.exec(url)
    if (folder) return { status: 200, json: { UniqueId: 'parent-1' } }
    const file = byId ? [...this.files.values()].find((f) => f.UniqueId === byId[1]) : byPath ? this.files.get(byPath[1].replace(/''/g, "'")) : undefined
    if (!file) return { status: 404 }
    if (o.bytes) return { status: 200, bytes: file.bytes }
    const { bytes: _b, ...facts } = file
    return { status: 200, json: facts }
  }

  async read(window: string): Promise<Screen> {
    if (this.dead) throw new Error('The box browser could not read the page.')
    const page = this.pages.get(window)
    if (!page) throw new Error('no such window')
    const ui = this.ui.get(window)!
    this.hits.clear()
    const base = ++this.render * 1000
    let n = base
    const lines: string[] = []
    const el = (depth: number, line: string, hit?: Hit): number => {
      const i = ++n
      lines.push(`${'  '.repeat(depth)}[${i}] ${line}`)
      if (hit) this.hits.set(i, hit)
      return i
    }
    if (page.kind === 'site') {
      el(0, `window "Site"`)
      el(1, `input "Address and search bar" = ${q(page.url)}`)
      return screenOfObservation(`app "Chromium" · window "Site" · 1280×800\n${lines.join('\n')}`, { bundleId: 'org.chromium.Chromium', name: 'Chromium' })!
    }
    if (page.kind === 'builder' && this.gone.has(page.formId)) {
      el(0, 'window "Microsoft Forms"')
      el(1, `input "Address and search bar" = ${q(builderOf(page.formId))}`)
      el(1, `heading "This form doesn’t exist"`)
      el(1, 'text "Please make sure the link is correct and try again."')
      el(1, 'button "Technical details"')
      return screenOfObservation(`app "Chromium" · window "Microsoft Forms" · 1280×800\n${lines.join('\n')}`, { bundleId: 'org.chromium.Chromium', name: 'Chromium' })!
    }
    if (page.kind === 'folder') {
      el(0, `window "RecWell - Documents"`)
      el(1, `input "Address and search bar" = "https://purdue0.sharepoint.com/sites/RecWell/Shared%20Documents/Forms/AllItems.aspx"`)
      el(1, 'button "Create or upload"', { what: 'Create or upload', run: () => void (page.menu = true) })
      if (page.menu) {
        el(1, 'menu "Create or upload"')
        el(2, 'menu item "Word document"', { what: 'Word document', run: () => {} })
        el(2, 'menu item "xlsx Forms survey"', {
          what: 'Forms survey',
          run: () => {
            const formId = `FakeFormId${String(++this.made).padStart(14, '0')}`
            this.add({ formId, title: this.welcome ? '' : 'Untitled form', description: '', questions: [], settings: { accepting: true, orgOnly: true, recordName: true, onePerPerson: false }, count: 0 })
            const id = `#${this.nextWindow++}`
            this.pages.set(id, { kind: 'builder', formId })
            if (!this.noOpener) this.openers.set(id, window)
            this.ui.set(id, { panel: false, dialog: false, adding: false, editing: null, titleEdit: false })
            if (this.stray) {
              const other = `FakeFormId${String(++this.made).padStart(14, '0')}`
              this.add({ formId: other, title: 'Untitled form', description: '', questions: [], settings: { accepting: true, orgOnly: true, recordName: true, onePerPerson: false }, count: 0 })
              const sid = `#${this.nextWindow++}`
              this.pages.set(sid, { kind: 'builder', formId: other })
              this.openers.set(sid, '#999')
              this.ui.set(sid, { panel: false, dialog: false, adding: false, editing: null, titleEdit: false })
              this.strayId = other
            }
          }
        })
      }
      return screenOfObservation(`app "Chromium" · window "RecWell" · 1280×800\n${lines.join('\n')}`, { bundleId: 'org.chromium.Chromium', name: 'Chromium' })!
    }
    const f = this.forms.get(page.formId)!
    el(0, `window ${q(f.title || 'Microsoft Forms')}`)
    el(1, `input "Address and search bar" = ${q(`${builderOf(f.formId)}${page.results ? '&analysis=true' : ''}`)}`)
    if (!f.title) {
      el(1, 'heading "Welcome to Microsoft Forms"')
      el(1, 'button "Customer feedback template"', { what: 'template', run: () => {} })
      return screenOfObservation(`app "Chromium" · window "Microsoft Forms" · 1280×800\n${lines.join('\n')}`, { bundleId: 'org.chromium.Chromium', name: 'Chromium' })!
    }
    el(1, 'button "Settings"', { what: 'Settings', run: () => void (ui.panel = true) })
    el(1, 'button "Collect responses"', { what: 'Collect responses', run: () => void (ui.dialog = true) })
    el(1, 'button "View responses"', { what: 'View responses', run: () => void (page.results = true) })
    el(1, 'button "More form settings"', { what: 'More form settings', run: () => {} })
    if (page.results) {
      el(1, f.count ? `text ${q(`${f.count} Responses`)}` : 'text "No responses yet"')
      if (f.count) el(1, 'button "Open results in Excel"', { what: 'Open results in Excel', run: () => {} })
      el(1, 'button "Delete all responses"', { what: 'Delete all responses', run: () => (f.count = 0) })
    }
    // the real page draws the title twice: in its top bar with the save state, and on the form (P1)
    el(1, `button ${q(`Form title ${f.title} ${this.neverSaves || this.saving > 0 ? (this.saving--, 'Saving...') : 'Saved'}`)}`, { what: 'top bar title', run: () => {} })
    if (ui.titleEdit) el(1, `text area "Form title" = ${q(f.title)} focused`, { what: 'title field', run: (t) => t !== undefined && (f.title = t) })
    else for (let n = this.twoTitles ? 2 : 1; n > 0; n--) el(1, `button ${q(`Form title ${f.title}`)}`, { what: 'Form title', run: () => void (ui.titleEdit = true) })
    el(1, `input "Form description" = ${q(f.description)}`, { what: 'description', run: (t) => t !== undefined && (f.description = t) })
    f.questions.forEach((question, i) => {
      if (ui.editing?.at === i) return this.drawEdit(el, f, ui, i)
      // at rest the real page says "Single choice" / "Multiple choice" (P1), where the add buttons say "Choice"
      const kind = question.type === 'other' ? question.kind : question.type === 'choice' ? (question.multiple ? 'Multiple choice' : 'Single choice') : question.type === 'text' ? (question.long ? 'Multi line text' : 'Single line text') : TYPE_WORD[question.type]
      const req = question.type !== 'other' && question.type !== 'section' && question.required ? ' Required to answer' : ''
      const b = el(1, `button ${q(`${i + 1}. Question title ${question.title} ${kind}${req}`)}`, { what: `question ${i + 1}`, run: () => (ui.editing = { at: i, draft: structuredClone(question) as MsQuestion }) })
      void b
      if (question.type === 'choice') for (const o of question.options ?? []) el(2, `${question.multiple ? 'checkbox' : 'radio'} ${q(o)} unchecked`)
    })
    if (ui.editing && ui.editing.at === f.questions.length) this.drawEdit(el, f, ui, f.questions.length)
    el(1, `button "Add new question"${ui.adding ? ' expanded' : ''}`, { what: 'Add new question', run: () => void (ui.adding = true) })
    if (ui.adding)
      for (const [type, word] of Object.entries(TYPE_WORD))
        el(2, `button ${q(word)}`, {
          what: word,
          run: () => {
            this.commit(f, ui)
            ui.adding = false
            // A new question copies Required from the last one, as Forms does.
            const last = [...f.questions].reverse().find((x) => x.type !== 'other' && x.type !== 'section') as MsQuestion | undefined
            const draft: MsQuestion = { title: '', type: type as MsQuestion['type'], required: last?.required ?? false, ...(type === 'choice' ? { options: ['Option 1', 'Option 2'] } : {}) }
            ui.editing = { at: f.questions.length, draft }
          }
        })
    if (ui.panel) {
      el(1, 'group "Settings"')
      const t = (name: string, on: boolean, run: () => void, role = 'checkbox') => el(2, `${role} ${q(name)} ${on ? 'checked' : 'unchecked'}`, { what: name, run: () => (this.stuck.has(name) ? undefined : run()) })
      t('Anyone can respond', !f.settings.orgOnly, () => (f.settings.orgOnly = false), 'radio')
      t('Only people in purdue.edu can respond', f.settings.orgOnly, () => (f.settings.orgOnly = true), 'radio')
      t('Record name', f.settings.recordName, () => (f.settings.recordName = !f.settings.recordName))
      t('One response per person', f.settings.onePerPerson, () => (f.settings.onePerPerson = !f.settings.onePerPerson))
      // the real panel names it after its section too (P1)
      t('Options for responses Accept responses', f.settings.accepting, () => (f.settings.accepting = !f.settings.accepting))
      t('Start date', Boolean(f.settings.startDate), () => (f.settings.startDate = f.settings.startDate ? undefined : '1/1/2027'))
      t('End date', Boolean(f.settings.endDate), () => (f.settings.endDate = f.settings.endDate ? undefined : '1/1/2027'))
      el(2, 'button "Settings Close"', { what: 'Close settings', run: () => void (ui.panel = false) })
    }
    if (ui.dialog) {
      const d = el(1, 'dialog "Send and collect responses"')
      void d
      el(2, `input "Link for Collecting Responses" = ${q(`https://forms.cloud.microsoft/Pages/ResponsePage.aspx?id=${f.formId}`)} read-only`)
      el(2, 'checkbox "Shorten URL" unchecked', { what: 'Shorten URL', run: () => {} })
      el(2, 'button "Copy link"', { what: 'Copy link', run: () => {} })
      el(2, 'checkbox "Outlook" checked', { what: 'Outlook', run: () => {} })
      el(2, 'button "Send"', { what: 'Send', run: () => {} })
      el(2, 'button "Close"', { what: 'Close dialog', run: () => void (ui.dialog = false) })
    }
    return screenOfObservation(`app "Chromium" · window ${q(f.title)} · 1280×800\n${lines.join('\n')}`, { bundleId: 'org.chromium.Chromium', name: 'Chromium' })!
  }

  private drawEdit(el: (d: number, l: string, h?: Hit) => number, f: FakeFormState, ui: { editing: Editing | null }, i: number): void {
    const e = ui.editing!
    const d = e.draft
    el(1, `group ${q(`Question ${i + 1}`)}`)
    el(2, `text area ${q(`Question title ${i + 1} Input your question title here`)} = ${q(d.title)}`, { what: 'question title', run: (t) => t !== undefined && (d.title = t) })
    if (d.type === 'choice') {
      ;(d.options ?? []).forEach((o, k) => {
        el(2, `${this.activeAsTextArea && k === this.activeOption ? 'text area' : 'input'} "Choice Option Text Please enter a name for this option." = ${q(o)}`, { what: `option ${k + 1}`, run: (t) => void (t !== undefined && ((d.options![k] = t), (this.activeOption = k))) })
        el(3, `button ${q(`Delete ${o}`)}`, { what: `Delete ${o}`, run: () => d.options!.splice(k, 1) })
      })
      el(2, 'button "Add option"', { what: 'Add option', run: () => void (d.options!.push(`Option ${d.options!.length + 1}`), (this.activeOption = d.options!.length - 1)) })
      el(2, `switch "Multiple answers" ${d.multiple ? 'checked' : 'unchecked'}`, { what: 'Multiple answers', run: () => (d.multiple = !d.multiple) })
    }
    if (d.type === 'text') el(2, `switch "Long answer" ${d.long ? 'checked' : 'unchecked'}`, { what: 'Long answer', run: () => (d.long = !d.long) })
    if (d.type !== 'section') el(2, `switch "Required" ${d.required ? 'checked' : 'unchecked'}`, { what: 'Required', run: () => (d.required = !d.required) })
    el(2, `button ${q(`Delete question ${i + 1}`)}`, { what: 'Delete question', run: () => (f.questions.splice(i, 1), (ui.editing = null)) })
    if (i > 0) el(2, `button ${q(`Move question up ${i + 1}`)}`, { what: 'Move question up', run: () => (this.commit(f, ui), ([f.questions[i - 1], f.questions[i]] = [f.questions[i], f.questions[i - 1]])) })
  }

  /** The question in edit is written back when another is opened or added (Tab and a click commit). */
  private commit(f: FakeFormState, ui: { editing: Editing | null }): void {
    const e = ui.editing
    if (!e) return
    ui.editing = null
    if (!e.draft.title || this.dropTitles.has(e.draft.title)) return
    const clean: MsQuestion = { ...e.draft }
    if (!clean.multiple) delete clean.multiple
    if (!clean.long) delete clean.long
    if (e.at >= f.questions.length) f.questions.push(clean)
    else f.questions[e.at] = clean
  }

  async act(window: string, _screen: Screen, steps: readonly ComputerAction[]): Promise<{ ok: boolean; words?: string }> {
    const page = this.pages.get(window)
    for (const s of steps) {
      const index = (s as { element?: number }).element
      const hit = index === undefined ? undefined : this.hits.get(index)
      const action = (s as { action: string }).action
      if (!hit) return { ok: false, words: 'stale_element' }
      if (action === 'left_click') {
        this.log.push(`click ${hit.what}`)
        // A click elsewhere commits the question in edit, as Forms does.
        const opens = this.insertsBetween && hit.what === 'Add new question' && !!this.ui.get(window)?.editing
        if (page?.kind === 'builder' && !opens && !/question title|option|Required|Multiple|Long|Add option|Delete|Move/.test(hit.what)) this.commit(this.forms.get(page.formId)!, this.ui.get(window)!)
        hit.run()
        if (this.diesAfter === hit.what) this.dead = true
      } else if (action === 'type') {
        this.log.push(`type ${hit.what}: ${(s as { text: string }).text}`)
        hit.run((s as { text: string }).text)
        if (this.diesAfter === hit.what) this.dead = true
      } else if (action === 'key') {
        const key = (s as { text: string }).text
        this.log.push(`key ${key} in ${hit.what}`)
        if (key === 'Tab' && hit.what === 'title field' && page?.kind === 'builder') this.ui.get(window)!.titleEdit = false

      }
    }
    return { ok: true }
  }
}
