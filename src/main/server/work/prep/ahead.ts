import type { ClientRequest } from '@shared/contract'
import type { PrepAhead } from '@shared/contract-work-prep'
import type { SectorKey } from '@shared/work'
import { WORK_MODULES, type Caller, type WorkCtx } from '../modules'
import { sectorWord, workspaceSector } from './workspace'
import { changeInOrder } from './serial'

export const AHEAD_WITHHELD: SectorKey[] = ['purdue']
export const AHEAD_ROUTINE = 'Prepare today’s meetings'
export const AHEAD_PROMPT = [
  'Call prep_today. If it lists no meetings, say so and stop.',
  'For each meeting it lists, read the newest mail and the open tasks, check what changed since last time, and write its brief with prep_write. Pass the event id each time.',
  'Send nothing and add no task.'
].join('\n')

const owner: Caller = { kind: 'local', caps: ['read', 'operate', 'approve', 'admin'] }
type RoutineRequest = Extract<ClientRequest, { method: 'work.routines.list' | 'work.routines.save' | 'work.routines.pause' }>
type Routine = { id: string; enabled: boolean }

async function routines<T>(ctx: WorkCtx, req: RoutineRequest): Promise<T> {
  const module = WORK_MODULES.find((m) => m.id === 'routines')
  if (!module?.handle) throw new Error('Routines are not running on this host.')
  const answer = await module.handle(req, ctx, owner)
  if (!answer.handled) throw new Error('Routines did not take the call.')
  return answer.result as T
}

async function keptRoutine(ctx: WorkCtx, workspaceId: string): Promise<Routine | null> {
  const kept = ctx.db.prepare('SELECT routine_id FROM work_prep_ahead WHERE workspace_id = ?').get(workspaceId) as { routine_id: string } | undefined
  if (!kept) return null
  const { routines: rows } = await routines<{ routines: Routine[] }>(ctx, { id: 'prep', method: 'work.routines.list', params: { workspaceId } })
  return rows.find((r) => r.id === kept.routine_id) ?? null
}

const switchOf = (routine: Routine | null): PrepAhead => routine ? { offered: true, on: routine.enabled, routineId: routine.id } : { offered: true, on: false }

export async function aheadOf(ctx: WorkCtx, workspaceId: string): Promise<PrepAhead> {
  const sector = workspaceSector(ctx, workspaceId)
  if (AHEAD_WITHHELD.includes(sector)) return { on: false, offered: false }
  try {
    return switchOf(await keptRoutine(ctx, workspaceId))
  } catch (err) {
    ctx.log(`prep: could not read Prepare ahead: ${String(err)}`)
    return switchOf(null)
  }
}

/** Keep one routine for the switch. Pause it to keep its runs when it is off. */
export async function setAhead(ctx: WorkCtx, by: Caller, workspaceId: string, on: boolean, tz = Intl.DateTimeFormat().resolvedOptions().timeZone): Promise<PrepAhead> {
  if (by.kind === 'model' || !by.caps.includes('admin')) throw new Error('Only the owner with admin can change Prepare ahead.')
  return changeInOrder(ctx, ['ahead', workspaceId], async () => {
    const sector = workspaceSector(ctx, workspaceId)
    if (AHEAD_WITHHELD.includes(sector)) throw new Error(`Prepare ahead is not offered for ${sectorWord(sector)}.`)
    const routine = await keptRoutine(ctx, workspaceId)
    if (routine) {
      if (routine.enabled === on) return switchOf(routine)
      return switchOf(await routines<Routine>(ctx, { id: 'prep', method: 'work.routines.pause', params: { id: routine.id, paused: !on } }))
    }
    if (!on) return switchOf(null)
    const made = await routines<Routine>(ctx, {
      id: 'prep',
      method: 'work.routines.save',
      params: {
        workspaceId,
        name: AHEAD_ROUTINE,
        prompt: AHEAD_PROMPT,
        trigger: { on: 'schedule', rrule: 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0', tz },
        ends: { kind: 'never' }
      }
    })
    ctx.db.prepare('INSERT OR REPLACE INTO work_prep_ahead (workspace_id, routine_id) VALUES (?, ?)').run(workspaceId, made.id)
    return switchOf(made)
  })
}
