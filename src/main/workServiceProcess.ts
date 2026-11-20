import { startWorkService, type RunningService } from './server/work/service/serve'
import type { FromService, ToService } from './server/work/service/wire'

/**
 * Entry of the Work service's utility process (docs/agents/work-service.md):
 * the one process that serves live documents and, as their milestones land,
 * sheets, guest links, the hosted pages and the Office relay. Main forks it
 * while Work is on (work/service/supervisor.ts). It never opens the app's
 * database and never reads the vault; main feeds it over this port.
 */

const parent = process.parentPort
if (!parent) {
  console.error('the Work service runs only as a utility process')
  process.exit(1)
}

const send = (m: FromService): void => parent.postMessage(m)
const asked = new Map<number, { resolve(jwt: string): void; reject(err: Error): void }>()
let nextAsk = 1
let running: RunningService | null = null
let starting = false
/** pushes that came while the service was starting: applied before it says it is ready */
let heldLinks: Extract<ToService, { t: 'links' }>['links'] | null = null
let heldTrusted: Extract<ToService, { t: 'trusted' }>['trusted'] | null = null
const heldProjects = new Map<string, Extract<ToService, { t: 'project' }>['project']>()

const jwt = (): Promise<string> =>
  new Promise((resolve, reject) => {
    const id = nextAsk++
    asked.set(id, { resolve, reject })
    send({ t: 'jwt?', id })
    setTimeout(() => {
      if (asked.delete(id)) reject(new Error('main did not answer for a LifeOS JWT'))
    }, 30_000)
  })

const fault = (err: unknown): void => {
  send({ t: 'fault', message: err instanceof Error ? (err.stack ?? err.message) : String(err) })
  // A service in an unknown state serves nothing: main starts a fresh one, and the journal keeps every acknowledged edit.
  process.exit(1)
}
process.on('uncaughtException', fault)
process.on('unhandledRejection', fault)

parent.on('message', (event: { data: unknown }) => {
  const m = event.data as ToService
  if (m.t === 'config') {
    if (running || starting) return
    starting = true
    startWorkService(m.config, { jwt, log: (line) => send({ t: 'log', line }) }).then(
      (service) => {
        running = service
        if (heldLinks) service.setLinks(heldLinks)
        if (heldTrusted) service.setTrusted(heldTrusted)
        for (const [linkId, project] of heldProjects) service.setProject(linkId, project)
        heldProjects.clear()
        heldLinks = heldTrusted = null
        send({ t: 'ready', port: service.port })
      },
      fault
    )
  } else if (m.t === 'links') {
    if (running) running.setLinks(m.links)
    else heldLinks = m.links
  } else if (m.t === 'project') {
    if (running) running.setProject(m.linkId, m.project)
    else heldProjects.set(m.linkId, m.project)
  } else if (m.t === 'trusted') {
    if (running) running.setTrusted(m.trusted)
    else heldTrusted = m.trusted
  } else if (m.t === 'jwt') {
    const waiter = asked.get(m.id)
    asked.delete(m.id)
    if (m.jwt) waiter?.resolve(m.jwt)
    else waiter?.reject(new Error(m.error ?? 'no JWT'))
  } else if (m.t === 'stop') {
    void (running?.stop() ?? Promise.resolve()).finally(() => {
      send({ t: 'stopped' })
      process.exit(0)
    })
  }
})
