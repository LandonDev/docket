import { request } from 'node:http'
import type { RunningService } from '../service/serve'
import type { FakeConvex } from '../service/fakeConvex'
import { rmSync } from 'node:fs'

export const TEST_SECRET = 'f'.repeat(43)

export function post(socketPath: string, path: string, body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const fail = (error: unknown) => reject(new Error(`POST ${path}: ${String(error)}`, { cause: error }))
    const req = request({
      socketPath,
      path,
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_SECRET}` }
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('error', fail)
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { error?: string }
          if ((res.statusCode ?? 500) >= 400) fail(parsed.error ?? `HTTP ${res.statusCode}`)
          else resolve(parsed)
        } catch (error) {
          fail(error)
        }
      })
    })
    req.on('error', fail)
    req.end(JSON.stringify(body))
  })
}

export async function closeFormatRig(open: { dirs: string[]; services: RunningService[]; convex: FakeConvex[] }): Promise<void> {
  const services = await Promise.allSettled(open.services.splice(0).map((service) => service.stop()))
  const convex = await Promise.allSettled(open.convex.splice(0).map((server) => server.close()))
  for (const dir of open.dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  const failures = [...services, ...convex].filter((result) => result.status === 'rejected')
  if (failures.length) throw new AggregateError(failures.map(({ reason }) => reason), 'Closing the formats test rig failed')
}
