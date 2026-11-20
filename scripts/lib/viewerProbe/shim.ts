// Counts what the viewer's worker does, for scripts/e2e-video-viewer.ts with TC_VIEWER_PROBE=1: its frame clock's
// callbacks, the decoder's calls and outputs, the socket's messages and sends. It only watches; the worker is the
// app's own (entry.ts imports it after this).
/* eslint-disable @typescript-eslint/no-explicit-any */
const s = self as any
const counts = { rafAsked: 0, rafRan: 0, configure: 0, decode: 0, output: 0, errors: [] as string[], received: 0, sent: 0 }
const raf = typeof s.requestAnimationFrame === 'function' ? s.requestAnimationFrame.bind(s) : null
if (raf) s.requestAnimationFrame = (cb: (t: number) => void) => (counts.rafAsked++, raf((t: number) => (counts.rafRan++, cb(t))))
const Decoder = s.VideoDecoder
s.VideoDecoder = class extends Decoder {
  constructor(init: any) {
    super({ output: (f: any) => (counts.output++, init.output(f)), error: (e: any) => (counts.errors.push(String(e)), init.error(e)) })
  }
  configure(c: any) { counts.configure++; return super.configure(c) }
  decode(c: any) { counts.decode++; return super.decode(c) }
}
const Socket = s.WebSocket
s.WebSocket = class extends Socket {
  constructor(url: string, protocols: string[]) {
    super(url, protocols)
    this.addEventListener('message', () => counts.received++)
  }
  send(data: any) { counts.sent++; return super.send(data) }
}
setInterval(() => s.postMessage({ t: 'probe', hasRaf: !!raf, ...counts }), 1000)
