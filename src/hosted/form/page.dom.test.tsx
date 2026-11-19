import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicForm } from '@shared/contract-work-forms'
import { mount } from './page'

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
    const [url, init] = fetcher.mock.calls[1]
    expect(url).toBe('/f/abcdefghijklmnop')
    expect(JSON.parse(String(init!.body))).toEqual({ answers: { n: 'Ava', g: 'Valorant', z: 'M' } })
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
})
