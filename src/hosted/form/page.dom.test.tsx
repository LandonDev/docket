import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicForm } from '@shared/contract-work-forms'
import { mount } from './page'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The public form page as a filler's browser runs it, against a stand-in for the Work service. */

const FORM: PublicForm = {
  title: 'Spring LAN registration',
  description: 'Saturday, April 10.',
  open: true,
  questions: [
    { id: 'n', label: 'Name', type: 'short', required: true },
    { id: 's', label: 'Your team', type: 'section', required: false },
    { id: 'g', label: 'Game', type: 'choice', required: true, options: ['Valorant', 'Rocket League'] },
    { id: 'z', label: 'Size', type: 'dropdown', required: false, options: ['S', 'M'] },
    { id: 'd', label: 'Dietary needs', type: 'long', required: false }
  ]
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let root: HTMLElement
beforeEach(() => {
  document.body.innerHTML = '<main id="form" aria-busy="true"></main>'
  root = document.getElementById('form')!
})

const type = (selector: string, value: string): void => {
  const input = root.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector)!
  input.value = value
}
const submit = (): void => void root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))

describe('the form page', () => {
  it('draws the questions as the filler sees them, a section as a heading, every word as text', async () => {
    const fetcher = vi.fn(async () => json(200, { ...FORM, title: '<img src=x onerror=alert(1)>' }))
    await mount(root, '/f/abcdefghijklmnop/', fetcher)
    expect(fetcher).toHaveBeenCalledWith('/f/abcdefghijklmnop/form')
    expect(root.querySelector('h1')!.textContent).toBe('<img src=x onerror=alert(1)>')
    expect(root.querySelector('img')).toBeNull()
    expect(root.querySelector('h2')!.textContent).toBe('Your team')
    expect([...root.querySelectorAll('.fm-q')].map((q) => q.getAttribute('data-q'))).toEqual(['n', 'g', 'z', 'd'])
    expect(root.querySelectorAll('input[type=radio]')).toHaveLength(2)
    expect(root.querySelector('select')!.options).toHaveLength(3)
    expect(root.getAttribute('aria-busy')).toBeNull()
  })

  it('names a missing answer at its question, then sends the rest as JSON and thanks the filler', async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => (init?.method === 'POST' ? json(201, { ok: true }) : json(200, FORM)))
    await mount(root, '/f/abcdefghijklmnop', fetcher)
    submit()
    const name = root.querySelector('.fm-q[data-q="n"]')!
    expect(name.getAttribute('aria-invalid')).toBe('true')
    expect(name.querySelector('.fm-err')!.textContent).toBe('This question needs an answer.')
    expect(fetcher).toHaveBeenCalledTimes(1)
    type('#q0', ' Ava ')
    root.querySelector<HTMLInputElement>('input[value="Valorant"]')!.checked = true
    type('select', 'M')
    submit()
    await vi.waitFor(() => expect(root.textContent).toContain('Your answer was sent.'))
    // Focus follows the swap: the confirmation's heading, not a control that is gone.
    expect(document.activeElement).toBe(root.querySelector('h1'))
    const [url, init] = fetcher.mock.calls[1]
    expect(url).toBe('/f/abcdefghijklmnop')
    expect(JSON.parse(String(init!.body))).toEqual({ answers: { n: 'Ava', g: 'Valorant', z: 'M' }, submission: expect.stringMatching(/^[A-Za-z0-9_-]{16,64}$/) })
  })

  it('shows the service\'s refusal at the question it names, and a closed form as closed', async () => {
    let post = json(400, { error: 'Pick one of the answers.', question: 'g' })
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === 'POST' ? post : json(200, FORM)))
    await mount(root, '/f/abcdefghijklmnop', fetcher)
    type('#q0', 'Ava')
    root.querySelector<HTMLInputElement>('input[value="Valorant"]')!.checked = true
    submit()
    await vi.waitFor(() => expect(root.querySelector('.fm-q[data-q="g"] .fm-err')!.textContent).toBe('Pick one of the answers.'))
    post = json(410, { error: 'This form is closed.' })
    submit()
    await vi.waitFor(() => expect(root.textContent).toContain('This form is closed.'))
    expect(root.querySelector('form')).toBeNull()
  })

  it('says so when there is no form, or it is closed before anyone answers', async () => {
    await mount(root, '/f/nope', async () => json(404, {}))
    expect(root.querySelector('h1')!.textContent).toBe('There is no form here')
    await mount(root, '/f/abcdefghijklmnop', async () => json(200, { ...FORM, open: false }))
    expect(root.textContent).toContain('This form is closed.')
  })

  it('says Sending… on the button while the answer is on its way', async () => {
    let done: (r: Response) => void = () => undefined
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === 'POST' ? new Promise<Response>((r) => (done = r)) : json(200, FORM)))
    await mount(root, '/f/abcdefghijklmnop', fetcher)
    type('#q0', 'Ava')
    root.querySelector<HTMLInputElement>('input[value="Valorant"]')!.checked = true
    submit()
    const button = root.querySelector<HTMLButtonElement>('.fm-send')!
    expect(button.textContent).toBe('Sending…')
    expect(button.disabled).toBe(true)
    done(json(400, { error: 'Try again.' }))
    await vi.waitFor(() => expect(button.textContent).toBe('Send'))
  })

  it('rests the answers while Send is in flight, and gives them back as they were, the refused one focused, if it fails', async () => {
    let done: (r: Response) => void = () => undefined
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === 'POST' ? new Promise<Response>((r) => (done = r)) : json(200, FORM)))
    await mount(root, '/f/abcdefghijklmnop', fetcher)
    type('#q0', 'Ava')
    root.querySelector<HTMLInputElement>('input[value="Valorant"]')!.checked = true
    submit()
    const name = root.querySelector<HTMLInputElement>('#q0')!
    const choice = root.querySelector<HTMLInputElement>('input[value="Valorant"]')!
    expect(name.disabled).toBe(true)
    expect(choice.disabled).toBe(true)
    expect(root.querySelector('form')!.getAttribute('aria-busy')).toBe('true')
    done(json(400, { error: 'That name is taken.', question: FORM.questions[0]!.id }))
    await vi.waitFor(() => expect(name.disabled).toBe(false))
    expect(choice.disabled).toBe(false)
    expect(name.value).toBe('Ava')
    expect(choice.checked).toBe(true)
    expect(root.querySelector('form')!.hasAttribute('aria-busy')).toBe(false)
    expect(document.activeElement).toBe(name)
  })

  it('takes the focus to the outcome when it fell to the page while Send was out, and says the outcome in a status line that stays', async () => {
    let done: (r: Response) => void = () => undefined
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === 'POST' ? new Promise<Response>((r) => (done = r)) : json(200, FORM)))
    await mount(root, '/f/abcdefghijklmnop', fetcher)
    type('#q0', 'Ava')
    root.querySelector<HTMLInputElement>('input[value="Valorant"]')!.checked = true
    root.querySelector<HTMLButtonElement>('.fm-send')!.focus()
    submit()
    // The button rested, and a browser drops the focus of a control it disables to the page (jsdom keeps it, so the test drops it).
    expect(root.querySelector<HTMLButtonElement>('.fm-send')!.disabled).toBe(true)
    const gone = document.createElement('input')
    document.body.append(gone)
    gone.focus()
    gone.remove()
    expect(document.activeElement).toBe(document.body)
    done(json(200, {}))
    await vi.waitFor(() => expect(root.querySelector('.fm-msg')).not.toBeNull())
    expect(document.activeElement).toBe(root.querySelector('.fm-msg h1'))
    const status = document.querySelector('[data-fm-status]')!
    expect(status.getAttribute('role')).toBe('status')
    expect(status.textContent).toBe('Your answer was sent.')
    // Outside the root, so the redraw left it standing.
    expect(root.contains(status)).toBe(false)
  })

  it('leaves the focus where he moved it during the send, and still says the outcome', async () => {
    let done: (r: Response) => void = () => undefined
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === 'POST' ? new Promise<Response>((r) => (done = r)) : json(200, FORM)))
    await mount(root, '/f/abcdefghijklmnop', fetcher)
    type('#q0', 'Ava')
    root.querySelector<HTMLInputElement>('input[value="Valorant"]')!.checked = true
    root.querySelector<HTMLButtonElement>('.fm-send')!.focus()
    submit()
    const elsewhere = document.createElement('button')
    document.body.append(elsewhere)
    elsewhere.focus()
    done(json(200, {}))
    await vi.waitFor(() => expect(root.querySelector('.fm-msg')).not.toBeNull())
    expect(document.activeElement).toBe(elsewhere)
    expect(document.querySelector('[data-fm-status]')!.textContent).toBe('Your answer was sent.')
  })

  it('says a send that failed once, in its alert beside Send, and leaves the status line to outcomes that replace the form', async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === 'POST' ? Promise.reject(new TypeError('offline')) : json(200, FORM)))
    await mount(root, '/f/abcdefghijklmnop', fetcher)
    type('#q0', 'Ava')
    root.querySelector<HTMLInputElement>('input[value="Valorant"]')!.checked = true
    submit()
    // No reply came: the answer may be in, so the page cannot say it was not sent.
    const alert = await vi.waitFor(() => {
      const shown = document.querySelector<HTMLElement>('[role=alert]:not([hidden])')
      if (!shown) throw new Error('no alert yet')
      return shown
    })
    expect(alert.textContent).toBe("We couldn't confirm your answer. Check your connection, then send it again: it is counted once.")
    expect(document.querySelector('[data-fm-status]')!.textContent).toBe('')
    expect([...document.querySelectorAll('[role=alert], [role=status]')].filter((n) => n.textContent === alert.textContent)).toHaveLength(1)
  })

  it('sends the same answers again under the same submission, and changed answers under a new one', async () => {
    const bodies: { answers: Record<string, string>; submission: string }[] = []
    let fail = true
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return json(200, FORM)
      bodies.push(JSON.parse(String(init.body)))
      if (fail) throw new TypeError('offline')
      return json(201, { ok: true })
    })
    await mount(root, '/f/abcdefghijklmnop', fetcher)
    type('#q0', 'Ava')
    root.querySelector<HTMLInputElement>('input[value="Valorant"]')!.checked = true
    submit()
    await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>('.fm-send')!.disabled).toBe(false))
    submit()
    await vi.waitFor(() => expect(bodies).toHaveLength(2))
    await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>('.fm-send')!.disabled).toBe(false))
    expect(bodies[0]!.submission).toMatch(/^[A-Za-z0-9_-]{16,64}$/)
    expect(bodies[1]!.submission).toBe(bodies[0]!.submission)
    type('#q0', 'Ava Thompson')
    fail = false
    submit()
    await vi.waitFor(() => expect(bodies).toHaveLength(3))
    expect(bodies[2]!.submission).not.toBe(bodies[0]!.submission)
  })

  it('gives the focus back to Send after a general failure, when it fell to the page meanwhile', async () => {
    let done: (r: Response) => void = () => undefined
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === 'POST' ? new Promise<Response>((r) => (done = r)) : json(200, FORM)))
    await mount(root, '/f/abcdefghijklmnop', fetcher)
    type('#q0', 'Ava')
    root.querySelector<HTMLInputElement>('input[value="Valorant"]')!.checked = true
    const send = root.querySelector<HTMLButtonElement>('.fm-send')!
    send.focus()
    submit()
    // A browser drops the focus of the control it disables (jsdom does not, so the test does).
    const gone = document.createElement('input')
    document.body.append(gone)
    gone.focus()
    gone.remove()
    // A gateway's 502 with none of the service's words: unconfirmed, and Send has the focus back.
    done(new Response('Bad gateway', { status: 502 }))
    await vi.waitFor(() => expect(document.activeElement).toBe(send))
    expect(document.querySelector('[role=alert]:not([hidden])')!.textContent).toBe("We couldn't confirm your answer. Check your connection, then send it again: it is counted once.")
    expect(document.querySelector('[data-fm-status]')!.textContent).toBe('')
  })

  it('tells a form that failed to load from one that is not there, and Retry reads it again', async () => {
    let answer = json(503, {})
    const fetcher = vi.fn(async () => answer)
    await mount(root, '/f/abcdefghijklmnop', fetcher)
    expect(root.querySelector('h1')!.textContent).toBe('The form did not load')
    answer = json(200, FORM)
    root.querySelector<HTMLButtonElement>('button')!.click()
    await vi.waitFor(() => expect(root.querySelector('h1')!.textContent).toBe('Spring LAN registration'))
    await mount(root, '/f/abcdefghijklmnop', async () => Promise.reject(new TypeError('offline')))
    expect(root.querySelector('button')!.textContent).toBe('Retry')
  })

  it('takes the focus to the form\'s title after a Retry that drew it, when the focus was on Retry, and not when he moved it', async () => {
    let answer = json(503, {})
    const fetcher = vi.fn(async () => answer)
    await mount(root, '/f/abcdefghijklmnop', fetcher)
    answer = json(200, FORM)
    const retry = root.querySelector<HTMLButtonElement>('button')!
    retry.focus()
    retry.click()
    await vi.waitFor(() => expect(root.querySelector('h1')!.textContent).toBe('Spring LAN registration'))
    const title = root.querySelector<HTMLElement>('h1')!
    expect(document.activeElement).toBe(title)
    expect(title.tabIndex).toBe(-1)
    // The next Tab starts at the recovered form: its first field follows the title.
    expect(title.compareDocumentPosition(root.querySelector('#q0')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // Moved elsewhere while the read was out: the focus stays where he put it.
    let done: (r: Response) => void = () => {}
    fetcher.mockImplementation(async () => json(503, {}))
    await mount(root, '/f/abcdefghijklmnop', fetcher)
    fetcher.mockImplementation(() => new Promise<Response>((r) => (done = r)))
    const again = root.querySelector<HTMLButtonElement>('button')!
    again.focus()
    again.click()
    const elsewhere = document.createElement('button')
    document.body.append(elsewhere)
    elsewhere.focus()
    done(json(200, FORM))
    await vi.waitFor(() => expect(root.querySelector('h1')!.textContent).toBe('Spring LAN registration'))
    expect(document.activeElement).toBe(elsewhere)
    elsewhere.remove()
  })

  it('makes Retry busy and off while it reads, one read at a time, and brings it back when the read fails', async () => {
    let done: (r: Response) => void = () => {}
    const fetcher = vi.fn(async () => json(503, {}))
    await mount(root, '/f/abcdefghijklmnop', fetcher)
    fetcher.mockImplementation(() => new Promise<Response>((r) => (done = r)))
    const button = root.querySelector<HTMLButtonElement>('button')!
    button.click()
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(button.textContent).toBe('Retrying…')
    button.click()
    expect(fetcher).toHaveBeenCalledTimes(2)
    done(json(503, {}))
    await vi.waitFor(() => expect(root.querySelector('button')!.textContent).toBe('Retry'))
    const again = root.querySelector<HTMLButtonElement>('button')!
    expect(again.disabled).toBe(false)
    expect(again.hasAttribute('aria-busy')).toBe(false)
  })

  it('presses Send by a fill step on the app\'s duration tokens, never a scale or a hard-coded time', () => {
    const css = readFileSync(join(dirname(__filename), 'form.css'), 'utf8')
    expect(css).not.toMatch(/scale\(/)
    expect(css).not.toMatch(/\d+ms var\(/)
    expect(css).toMatch(/\.fm-send:not\(:disabled\):active \{\s*background: color-mix/)
    expect(css).toContain('--dur-hover: 60ms')
  })

  it('ties a refused answer to its error: aria-invalid and aria-describedby on the control, both gone once it is answered', async () => {
    await mount(root, '/f/abcdefghijklmnop', async () => json(200, FORM))
    submit()
    const name = root.querySelector<HTMLInputElement>('#q0')!
    expect(name.getAttribute('aria-invalid')).toBe('true')
    expect(name.getAttribute('aria-describedby')).toBe('q0-err')
    expect(document.getElementById('q0-err')!.textContent).toBe('This question needs an answer.')
    expect(document.activeElement).toBe(name)
    name.value = 'Ava'
    name.dispatchEvent(new Event('input', { bubbles: true }))
    expect(name.hasAttribute('aria-invalid')).toBe(false)
    expect(name.hasAttribute('aria-describedby')).toBe(false)
    expect(document.getElementById('q0-err')!.hidden).toBe(true)
    // A choice's radios carry it too.
    submit()
    const radios = [...root.querySelectorAll<HTMLInputElement>('.fm-q[data-q="g"] input')]
    expect(radios.every((r) => r.getAttribute('aria-describedby') === 'q2-err')).toBe(true)
  })
})
