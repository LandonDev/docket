// The Work half of a deploy's probe (box-probe.mjs) and of the gate's boot of
// the built bundle (scripts/boot-built-probe.ts): with Work on in a scratch
// home, one cheap read of each pillar, failing on a pillar that could not load.
//
// 2026-11-24: 1.0.371 reached the box with the Files place dead ("files did not
// load: Cannot access 'SHARED_BYTES' before initialization", an import cycle
// only the built main bundle's order trips). Its trial passed: the probe asked
// hello, session.list and a ticket, none of them Work's. A pillar that answers
// "not signed in", "off" or "needs you" passes; one that threw at load fails,
// named with its error.

/** What a pillar that could not load answers, or what its code throws when a bundle's order broke it. */
export const LOAD_FAULT =
  /did not (load|start)|before initialization|is not defined|is not a (function|constructor)|Cannot read properties of (undefined|null)|Cannot find module|does not provide an export|ReferenceError|TypeError|SyntaxError/

/** The text, when it reads as a load failure; null when it is an answer a working host may give (off, not signed in). */
export const loadFault = (text) => (typeof text === 'string' && LOAD_FAULT.test(text) ? text : null)

/** work.health's rows that are broken for a load failure, as `<pillar>: <line>`. */
export function healthFaults(report) {
  const rows = Array.isArray(report?.rows) ? report.rows : []
  return rows
    .filter((r) => r?.state === 'broken' && (loadFault(r.line) || loadFault(r.title)))
    .map((r) => `${r.pillar}: ${r.line ?? r.title}`)
}

/** One request on a host's local socket (the implicit admin): its result, or a throw with its error. */
export function localCaller(port, timeoutMs = 25_000) {
  let next = 0
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = `probe-work-${++next}`
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
      const timer = setTimeout(() => {
        ws.close()
        reject(Error(`${method}: no answer in ${timeoutMs} ms`))
      }, timeoutMs)
      ws.addEventListener('open', () => ws.send(JSON.stringify({ id, method, params })))
      ws.addEventListener('error', () => {
        clearTimeout(timer)
        reject(Error(`${method}: socket error`))
      })
      ws.addEventListener('message', (event) => {
        const frame = JSON.parse(String(event.data))
        if (frame.id !== id) return
        clearTimeout(timer)
        ws.close()
        if (frame.ok) resolve(frame.result)
        else reject(Error(String(frame.error)))
      })
    })
}

/**
 * Work on, then each read in turn. `call(method, params)` answers or throws
 * the host's error. Answers `{ failures, notes, ms }`: a failure names the
 * read and the load error; a note is an error that is not one (kept for the log).
 */
export async function probeWork(call) {
  const started = Date.now()
  const failures = []
  const notes = []
  const ask = async (what, method, params) => {
    try {
      return await call(method, params)
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      if (loadFault(text)) failures.push(`${what}: ${text}`)
      else notes.push(`${what}: ${text}`)
      return null
    }
  }
  await ask('work.set', 'work.set', { enabled: true })
  const work = await ask('work.get', 'work.get', {})
  if (work && work.enabled !== true && failures.length === 0) failures.push('work.get: Work did not turn on')
  const workspace = await ask('workspace.create', 'workspace.create', { kind: 'work', name: 'Trial probe' })
  if (workspace?.id) await ask('files (work.files.places)', 'work.files.places', { workspaceId: workspace.id })
  const health = await ask('work.health', 'work.health', {})
  for (const fault of healthFaults(health)) failures.push(`work.health ${fault}`)
  return { failures, notes, ms: Date.now() - started }
}
