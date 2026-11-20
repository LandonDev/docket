/**
 * The pop-out's proof (plan-m1X24rQ6nikm A6), on an isolated dev instance
 * whose renderer listens for CDP: whether a canvas in a child window, drawn
 * by a worker the main window made, keeps drawing while the main window is
 * minimized, covered by another app or on another Space. That worker draws
 * on `requestAnimationFrame` as the video worker does (video.worker.ts), so
 * its frame clock is the one in question. Nothing in the app opens a
 * pop-out yet: this script does, under the one frame name the open handler
 * lets through (src/main/popOut.ts).
 *
 *   bun scripts/popout-proof.ts <port> open               opens the pop-out and starts drawing
 *   bun scripts/popout-proof.ts <port> sample <label> [s]  frames a second in the pop-out, and the main window's own
 *   bun scripts/popout-proof.ts <port> minimize            minimizes the main window
 *   bun scripts/popout-proof.ts <port> keys                a key held in the pop-out, then the pop-out loses focus
 *   bun scripts/popout-proof.ts <port> close               closes the pop-out
 *
 * Each prints one JSON line. Uses the global WebSocket (the ws package hangs evaluate).
 */

const [port, verb, ...rest] = process.argv.slice(2)
if (!port || !verb) {
  console.error('usage: bun scripts/popout-proof.ts <port> open|sample <label> [seconds]|minimize|keys|close')
  process.exit(2)
}

async function pageSocket(): Promise<string> {
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[]
  const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('about:') && !t.url.startsWith('devtools:'))
  if (!page) throw new Error('no app page on that port')
  return page.webSocketDebuggerUrl
}

async function evaluate<T>(expression: string): Promise<T> {
  const ws = new WebSocket(await pageSocket())
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('CDP socket failed'))
  })
  const answer = await new Promise<{ result?: { result?: { value?: T }; exceptionDetails?: unknown } }>((resolve) => {
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number }
      if (message.id === 1) resolve(message as never)
    }
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }))
  })
  ws.close()
  if (answer.result?.exceptionDetails) throw new Error(JSON.stringify(answer.result.exceptionDetails))
  return answer.result?.result?.value as T
}

const OPEN = `(async () => {
  if (window.__pop) return { opened: true, again: true }
  const w = window.open('about:blank', 'tc-popout')
  if (!w) return { opened: false }
  await new Promise((r) => setTimeout(r, 500))
  w.document.body.style.margin = '0'
  const canvas = w.document.createElement('canvas')
  canvas.width = 384; canvas.height = 240
  w.document.body.appendChild(canvas)
  const off = canvas.transferControlToOffscreen()
  const src = "let n = 0; onmessage = (e) => { const ctx = e.data.getContext('2d'); const f = () => { n++; ctx.fillStyle = 'hsl(' + (n % 360) + ' 70% 50%)'; ctx.fillRect(0, 0, 384, 240); requestAnimationFrame(f) }; requestAnimationFrame(f); setInterval(() => postMessage(n), 100) }"
  const worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })))
  const pop = { w, worker, drawn: 0, main: 0, keys: [] }
  worker.onmessage = (e) => { pop.drawn = e.data }
  worker.postMessage(off, [off])
  const tick = () => { pop.main++; requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
  window.__pop = pop
  return { opened: true, childHasPreload: typeof w.api !== 'undefined', childSlotArg: typeof w.api?.win?.slot === 'string' ? w.api.win.slot : null, childDpr: w.devicePixelRatio, mainDpr: window.devicePixelRatio }
})()`

const sample = (seconds: number) => `(async () => {
  const pop = window.__pop
  if (!pop) return { error: 'not open' }
  const a = { drawn: pop.drawn, main: pop.main, t: performance.now() }
  await new Promise((r) => setTimeout(r, ${seconds * 1000}))
  const s = (performance.now() - a.t) / 1000
  return { popOutFps: Math.round((pop.drawn - a.drawn) / s), mainFps: Math.round((pop.main - a.main) / s), seconds: Math.round(s * 10) / 10, mainHidden: document.hidden, childHidden: pop.w.document.hidden, childClosed: pop.w.closed }
})()`

// A key down in the pop-out, then the pop-out's own window loses focus: what the input layer must hear to let it go.
const KEYS = `(() => {
  const pop = window.__pop
  if (!pop) return { error: 'not open' }
  const heard = []
  pop.w.addEventListener('keydown', (e) => heard.push('child keydown ' + e.key))
  pop.w.addEventListener('blur', () => heard.push('child blur'))
  window.addEventListener('blur', () => heard.push('main blur'))
  pop.w.document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
  pop.w.dispatchEvent(new FocusEvent('blur'))
  return { heard }
})()`

const MINIMIZE = `(async () => { await window.api.win.minimize(); return { minimized: true } })()`
const CLOSE = `(() => { const pop = window.__pop; if (!pop) return { closed: false }; pop.worker.terminate(); pop.w.close(); delete window.__pop; return { closed: true } })()`

const run = async (): Promise<unknown> => {
  switch (verb) {
    case 'open':
      return evaluate(OPEN)
    case 'sample': {
      const label = rest[0] ?? 'sample'
      return { label, ...(await evaluate<object>(sample(Number(rest[1] ?? 5)))) }
    }
    case 'minimize':
      return evaluate(MINIMIZE)
    case 'keys':
      return evaluate(KEYS)
    case 'close':
      return evaluate(CLOSE)
    default:
      throw new Error(`unknown verb ${verb}`)
  }
}

run().then(
  (answer) => console.log(JSON.stringify(answer)),
  (err: Error) => {
    console.log(JSON.stringify({ error: err.message }))
    process.exit(1)
  }
)
