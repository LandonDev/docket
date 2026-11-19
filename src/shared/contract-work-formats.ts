import { z } from 'zod'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The formats pillar's wire (docs/agents/work-formats.md). Its methods are
 * `work.formats.<verb>` and its pushes `work.formats`; src/shared/work/wire.ts has
 * the helpers and the rules. Milestone 15 wrote the toolchain's two methods;
 * milestone 21 adds import and export after them.
 */
export const FormatsRequestSchemas = [
  /** → ToolsReport */
  request('work.formats.tools', z.object({}).optional()),
  /**
   * A job another host forwards: the input travels in the request as base64
   * and the output comes back the same way (→ { data, ranOn, warnings }).
   * It runs here or fails; it is never forwarded on.
   */
  request(
    'work.formats.convert',
    z.object({
      from: z.string().regex(/^[a-z0-9]{1,10}$/),
      to: z.string().regex(/^[a-z0-9]{1,10}$/),
      /** the input's file name, for its extension and the output's name */
      name: z.string().min(1).max(255),
      data: z.string().max(90 * 1024 * 1024),
      options: z.record(z.string(), z.unknown()).optional()
    })
  )
] as const
/** What `work.formats.tools` answers: this host's tools, the pairs it converts itself, and its queue. */
export interface ToolsReport {
  host: string
  platform: string
  tools: { name: string; pillar: string; version: string; licence: string; ok: boolean; bytes?: number; error?: string }[]
  converts: { from: string; to: string }[]
  queue: { cap: { jobs: number; threads: number }; running: number; queued: number }
}

export type FormatsPush = never
export const FORMATS_CAPS = { 'work.formats.tools': 'read', 'work.formats.convert': 'operate' } satisfies CapsOf<typeof FormatsRequestSchemas>
/** A forwarded job is between two linked hosts, never carried on a relayed lane. */
export const FORMATS_RELAY = { 'work.formats.convert': 'never' } satisfies RelayOf<typeof FormatsRequestSchemas>
