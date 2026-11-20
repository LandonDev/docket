import type { FormQuestion, PublicForm } from '@shared/contract-work-forms'

/**
 * A published form as the person filling it sees it
 * (docs/agents/work-forms.md "The page"). Plain DOM, no framework: the page
 * is public, loads one small script and builds every word with
 * `textContent`, so nothing a form holds is read as markup.
 */

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

/**
 * The page's one status line, beside the root and never redrawn with it: it says each Send's outcome and keeps
 * saying it, so a screen reader hears what happened even when the focus did not move.
 */
function statusFor(root: HTMLElement): HTMLElement {
  const next = root.nextElementSibling
  if (next instanceof HTMLElement && next.dataset.fmStatus !== undefined) return next
  const line = el('p', 'fm-sr')
  line.dataset.fmStatus = ''
  line.setAttribute('role', 'status')
  root.after(line)
  return line
}

/** A sending whose reply never came: it may or may not be in, and a resend is counted once (the submission id). */
const UNCONFIRMED = "We couldn't confirm your answer. Check your connection, then send it again: it is counted once."

/** A page's id for one sending of one set of answers, as the service takes it (16 to 64 of A-Z a-z 0-9 _ -). */
export function newSubmissionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** `focus`: whether the heading takes the focus; by default, when the focus was inside what it replaces. */
function message(root: HTMLElement, title: string, line?: string, action?: { label: string; run: (button: HTMLButtonElement) => void }, focus?: boolean): void {
  // Focus inside the form (Send was just pressed) moves to the heading that replaces it, so a keyboard or a screen reader hears what happened.
  const hadFocus = focus ?? root.contains(document.activeElement)
  root.replaceChildren()
  const box = el('div', 'fm-msg')
  const heading = el('h1', undefined, title)
  heading.tabIndex = -1
  box.append(heading)
  if (line) box.append(el('p', 'fm-desc', line))
  if (action) {
    const foot = el('div', 'fm-foot')
    const button = el('button', 'fm-send', action.label)
    button.type = 'button'
    button.addEventListener('click', () => action.run(button))
    foot.append(button)
    box.append(foot)
  }
  root.append(box)
  root.removeAttribute('aria-busy')
  if (hadFocus) heading.focus()
}

function field(q: FormQuestion, i: number): HTMLElement {
  const id = `q${i}`
  const wrap = el(q.type === 'choice' ? 'fieldset' : 'div', 'fm-q')
  wrap.dataset.q = q.id
  if (q.type === 'choice') {
    const legend = el('legend', 'fm-ql', q.label)
    if (q.required) legend.append(el('span', 'fm-req', ' *'))
    wrap.append(legend)
    const opts = el('div', 'fm-opts')
    for (const [j, o] of (q.options ?? []).entries()) {
      const label = el('label', 'fm-o')
      const input = el('input')
      input.type = 'radio'
      input.name = id
      input.value = o
      input.id = `${id}-${j}`
      if (q.required) input.required = true
      label.append(input, el('span', undefined, o))
      opts.append(label)
    }
    wrap.append(opts)
  } else {
    const label = el('label', 'fm-ql', q.label)
    label.htmlFor = id
    if (q.required) label.append(el('span', 'fm-req', ' *'))
    let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    if (q.type === 'long') input = el('textarea', 'fm-f long')
    else if (q.type === 'dropdown') {
      input = el('select', 'fm-f drop')
      const none = el('option', undefined, 'Choose')
      none.value = ''
      input.append(none, ...(q.options ?? []).map((o) => Object.assign(el('option', undefined, o), { value: o })))
    } else {
      input = el('input', 'fm-f')
      input.type = 'text'
    }
    input.id = id
    input.name = id
    if (q.required) input.required = true
    wrap.append(label, input)
  }
  const err = el('p', 'fm-err')
  err.id = `${id}-err`
  err.hidden = true
  wrap.append(err)
  return wrap
}

/** The answers as the service takes them: question id to text, empty ones left out. */
export function answersOf(form: HTMLFormElement, questions: readonly FormQuestion[]): Record<string, string> {
  const data = new FormData(form)
  const out: Record<string, string> = {}
  questions.forEach((q, i) => {
    const v = data.get(`q${i}`)
    if (typeof v === 'string' && v.trim()) out[q.id] = v.trim()
  })
  return out
}

export function renderForm(root: HTMLElement, f: PublicForm, base: string, fetcher: Fetch): void {
  if (!f.open) return message(root, f.title, 'This form is closed. It takes no more answers.')
  document.title = f.title
  root.replaceChildren()
  const form = el('form', 'fm-form')
  form.noValidate = true
  form.append(el('h1', undefined, f.title))
  if (f.description) form.append(el('p', 'fm-desc', f.description))
  let qs = el('div', 'fm-qs')
  form.append(qs)
  f.questions.forEach((q, i) => {
    if (q.type === 'section') {
      form.append(el('h2', 'fm-sec', q.label))
      qs = el('div', 'fm-qs')
      form.append(qs)
    } else qs.append(field(q, i))
  })
  const foot = el('div', 'fm-foot')
  const button = el('button', 'fm-send', 'Send')
  button.type = 'submit'
  const said = el('p', 'fm-err')
  said.setAttribute('role', 'alert')
  said.hidden = true
  foot.append(button, said)
  form.append(foot)

  // A question's error is its controls' too: each is marked invalid and names the error line, so a screen reader says why on focus.
  const controlsOf = (wrap: Element): HTMLElement[] => [...wrap.querySelectorAll<HTMLElement>('input, textarea, select')]
  const clearQuestion = (wrap: Element): void => {
    const p = wrap.querySelector<HTMLElement>('.fm-err')
    if (p) p.hidden = true
    wrap.removeAttribute('aria-invalid')
    for (const c of controlsOf(wrap)) {
      c.removeAttribute('aria-invalid')
      c.removeAttribute('aria-describedby')
    }
  }
  const showError = (questionId: string | undefined, text: string): void => {
    for (const q of form.querySelectorAll<HTMLElement>('.fm-q')) clearQuestion(q)
    said.hidden = true
    const wrap = questionId ? form.querySelector<HTMLElement>(`.fm-q[data-q="${CSS.escape(questionId)}"]`) : null
    const p = wrap?.querySelector<HTMLElement>('.fm-err')
    if (wrap && p) {
      p.textContent = text
      p.hidden = false
      wrap.setAttribute('aria-invalid', 'true')
      for (const c of controlsOf(wrap)) {
        c.setAttribute('aria-invalid', 'true')
        c.setAttribute('aria-describedby', p.id)
      }
      controlsOf(wrap)[0]?.focus()
    } else {
      said.textContent = text
      said.hidden = false
    }
  }

  // Answering a refused question clears its error with it.
  const answered = (e: Event): void => {
    const wrap = (e.target as Element | null)?.closest('.fm-q[aria-invalid="true"]')
    if (wrap) clearQuestion(wrap)
  }
  form.addEventListener('input', answered)
  form.addEventListener('change', answered)

  // One id per set of answers: the same answers sent again (a reply that never came back) carry it again, and the service
  // answers with the row it already wrote rather than a second one; changed answers are a new submission.
  let sending: { key: string; id: string } | null = null
  const submissionFor = (answers: Record<string, string>): string => {
    const key = JSON.stringify(answers)
    if (sending?.key !== key) sending = { key, id: newSubmissionId() }
    return sending.id
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const answers = answersOf(form, f.questions)
    const missing = f.questions.find((q) => q.required && q.type !== 'section' && !answers[q.id])
    if (missing) return showError(missing.id, 'This question needs an answer.')
    // Where the focus was when Send began: the outcome takes it if it is still in the form, or fell to the page
    // while the fields rested, and never from somewhere he moved it to meanwhile.
    const hadFocus = form.contains(document.activeElement)
    const mayMove = (): boolean => {
      const at = document.activeElement
      return hadFocus && (!at || at === document.body || form.contains(at))
    }
    const status = statusFor(root)
    const outcome = (text: string): void => {
      status.textContent = text
    }
    // What goes is what was read just now: the fields rest until the answer comes, and come back as they were (values kept) if it fails.
    const fields = [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select')].filter((c) => !c.disabled)
    for (const c of fields) c.disabled = true
    form.setAttribute('aria-busy', 'true')
    button.disabled = true
    button.setAttribute('aria-busy', 'true')
    button.textContent = 'Sending…'
    // Back before any error is said, so the refused question can take the focus.
    const release = (): void => {
      for (const c of fields) c.disabled = false
      form.removeAttribute('aria-busy')
      button.disabled = false
      button.removeAttribute('aria-busy')
      button.textContent = 'Send'
    }
    const submission = submissionFor(answers)
    // A general failure (no question to point at) gives the focus back to Send, if the rest took it from there.
    const backToSend = (): void => {
      if (mayMove()) button.focus()
    }
    void fetcher(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answers, submission }) })
      .then(async (r) => {
        if (r.ok) {
          outcome('Your answer was sent.')
          return message(root, f.title, 'Your answer was sent. Thank you.', undefined, mayMove())
        }
        const body = (await r.json().catch(() => ({}))) as { error?: string; question?: string }
        if (r.status === 410) {
          outcome('Your answer was not sent: this form is closed.')
          return message(root, f.title, 'This form is closed. It takes no more answers.', undefined, mayMove())
        }
        // A gateway's failure with none of the service's words: the answer may have been written before it.
        const unknown = r.status >= 500 && !body.error
        const text = unknown ? UNCONFIRMED : (body.error ?? 'Your answer was not sent. Try again.')
        outcome(unknown || text.startsWith('Your answer was not sent') ? text : `Your answer was not sent. ${text}`)
        release()
        showError(body.question, text)
        if (!body.question) backToSend()
      })
      .catch(() => {
        // No reply came: the service may have written the row before the line went, so this cannot say it was not sent.
        outcome(UNCONFIRMED)
        release()
        showError(undefined, UNCONFIRMED)
        backToSend()
      })
  })
  root.append(form)
  root.removeAttribute('aria-busy')
}

/**
 * Reads the form the page's address names and draws it. A form that is not
 * there (404, 410) says so; a read that failed (the service, the connection)
 * is not the same thing, and offers Retry.
 */
export async function mount(root: HTMLElement, pathname: string, fetcher: Fetch): Promise<void> {
  const base = pathname.replace(/\/+$/, '')
  // One read at a time: Retry is busy while it reads, as Send is while it sends; a read that fails draws the message again, Retry with it.
  const retry = {
    label: 'Retry',
    run: (button: HTMLButtonElement) => {
      if (button.disabled) return
      button.disabled = true
      button.setAttribute('aria-busy', 'true')
      button.textContent = 'Retrying…'
      void mount(root, pathname, fetcher)
    },
  }
  try {
    const r = await fetcher(`${base}/form`)
    if (r.status === 404 || r.status === 410) return message(root, 'There is no form here', 'The link may be wrong, or the form was taken down.')
    if (!r.ok) return message(root, 'The form did not load', 'Something went wrong on our side.', retry)
    renderForm(root, (await r.json()) as PublicForm, base, fetcher)
  } catch {
    message(root, 'The form did not load', 'Check your connection.', retry)
  }
}
