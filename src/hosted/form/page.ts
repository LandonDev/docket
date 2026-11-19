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

function message(root: HTMLElement, title: string, line?: string, action?: { label: string; run: () => void }): void {
  root.replaceChildren()
  const box = el('div', 'fm-msg')
  box.append(el('h1', undefined, title))
  if (line) box.append(el('p', 'fm-desc', line))
  if (action) {
    const foot = el('div', 'fm-foot')
    const button = el('button', 'fm-send', action.label)
    button.type = 'button'
    button.addEventListener('click', action.run)
    foot.append(button)
    box.append(foot)
  }
  root.append(box)
  root.removeAttribute('aria-busy')
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

  const showError = (questionId: string | undefined, text: string): void => {
    for (const p of form.querySelectorAll<HTMLElement>('.fm-q .fm-err')) p.hidden = true
    for (const q of form.querySelectorAll<HTMLElement>('.fm-q')) q.removeAttribute('aria-invalid')
    said.hidden = true
    const wrap = questionId ? form.querySelector<HTMLElement>(`.fm-q[data-q="${CSS.escape(questionId)}"]`) : null
    const p = wrap?.querySelector<HTMLElement>('.fm-err')
    if (wrap && p) {
      p.textContent = text
      p.hidden = false
      wrap.setAttribute('aria-invalid', 'true')
      wrap.querySelector<HTMLElement>('input, textarea, select')?.focus()
    } else {
      said.textContent = text
      said.hidden = false
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const answers = answersOf(form, f.questions)
    const missing = f.questions.find((q) => q.required && q.type !== 'section' && !answers[q.id])
    if (missing) return showError(missing.id, 'This question needs an answer.')
    button.disabled = true
    button.setAttribute('aria-busy', 'true')
    button.textContent = 'Sending…'
    void fetcher(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answers }) })
      .then(async (r) => {
        if (r.ok) return message(root, f.title, 'Your answer was sent. Thank you.')
        const body = (await r.json().catch(() => ({}))) as { error?: string; question?: string }
        if (r.status === 410) return message(root, f.title, 'This form is closed. It takes no more answers.')
        showError(body.question, body.error ?? 'Your answer was not sent. Try again.')
      })
      .catch(() => showError(undefined, 'Your answer was not sent. Check your connection and try again.'))
      .finally(() => {
        button.disabled = false
        button.removeAttribute('aria-busy')
        button.textContent = 'Send'
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
  const retry = { label: 'Retry', run: () => void mount(root, pathname, fetcher) }
  try {
    const r = await fetcher(`${base}/form`)
    if (r.status === 404 || r.status === 410) return message(root, 'There is no form here', 'The link may be wrong, or the form was taken down.')
    if (!r.ok) return message(root, 'The form did not load', 'Something went wrong on our side.', retry)
    renderForm(root, (await r.json()) as PublicForm, base, fetcher)
  } catch {
    message(root, 'The form did not load', 'Check your connection.', retry)
  }
}
