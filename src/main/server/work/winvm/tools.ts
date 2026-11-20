import type { z } from 'zod'
import { WAKING_WORDS } from '@shared/contract-work-winvm'
import { computerToolSpecs, ComputerResultInputSchema } from '@shared/computer/tools'
import { COMPUTER_RESULT_TOOL, heldCallWhat } from '@shared/computer/heldCalls'
import { hostErrorLine } from '@shared/computer/hostErrors'
import { workText, type WorkScope, type WorkToolResult } from '@shared/work'
import { computerContent } from '../../computer/mcp'
import { PendingCalls } from '../../computer/pending'
import { refusal, type ComputerToolOutcome } from '../../computer/result'
import type { WorkCtx, WorkTool } from '../modules'
import type { Keeper } from './keeper'
import { vmHost } from './vm'
import { fileTools, type GuestFiles } from './files'

/**
 * The five `windows_*` tools (docs/agents/work-winvm.md "The tools"): the
 * computer tools in Windows' words, run on the VM's sessions. Offered only to
 * a Work thread of a workspace whose "Computer use on the Windows VM" is on
 * (`windowsVm`), on the host that has the VM and once it is set up; a Work
 * Chat never gets them. The setting is read again at every call.
 */

export const NOT_ON_VM = 'refused: computer use on the Windows VM is off for this workspace (Settings → Work)'
export const NO_VM = 'refused: the Windows VM is not on this host'

const LEAD =
  'A Windows 11 PC on this host, his own, signed in as he left it: Notepad, Edge, Explorer and the apps he installed, as the standard user. ' +
  'One thread uses it at a time. A send, a post or a submit is held for his press on its own: drive up to it and stop. ' +
  'Never type a password: say he must take over. There is no command line here: the consoles and script hosts do not start. ' +
  'Below, "computer_*" and "the computer" mean these windows_* tools and this PC.\n\n'

const rename = (name: string): string => name.replace(/^computer_/, 'windows_')

/** Whether a thread of this scope may have the tools now: a workspace (never a Work Chat) with the setting on, and a VM set up here. */
export function vmOffered(ctx: Pick<WorkCtx, 'settings'>, scope: Pick<WorkScope, 'workspaceId'>, keeper: Keeper | null): boolean {
  if (!scope.workspaceId || !vmHost() || !keeper) return false
  if (keeper.state().state === 'none') return false
  try {
    return ctx.settings.workspace(scope.workspaceId).windowsVm === true
  } catch {
    return false
  }
}

/** The computer tools' answers name computer_apps, computer_result and the rest where the thread has windows_*. */
export function windowsWords(o: ComputerToolOutcome): ComputerToolOutcome {
  const fix = (s: string) => s.replace(/\bcomputer_(apps|observe|act|batch|result)\b/g, 'windows_$1')
  return { ...o, steps: o.steps.map(fix), ...(o.body !== undefined && o.body !== null ? { body: fix(o.body) } : {}) }
}

export interface VmToolsDeps {
  ctx: () => WorkCtx | null
  keeper: () => Keeper | null
  pending: PendingCalls
}

/** The file tools' way into the guest: the setting read again, the machine held for the thread and woken. */
function guestFiles(keeper: () => Keeper | null): GuestFiles | null {
  const h = vmHost()
  const k = keeper()
  if (!h || !k) return null
  return {
    async enter(ctx) {
      if (!vmOffered(ctx, ctx.scope, k)) return NOT_ON_VM
      const refused = h.lease.take(ctx.sessionId)
      if (refused) return refused
      k.touch()
      try {
        await k.wake()
      } catch (e) {
        return `refused: ${e instanceof Error ? e.message : String(e)}`
      }
      return null
    },
    admin: (script) => k.admin(script),
    send: (local, rel) => k.send(local, rel),
    fetch: (rel, local) => k.fetch(rel, local)
  }
}

export function vmTools(scope: WorkScope, d: VmToolsDeps): WorkTool[] {
  const started = d.ctx()
  if (!started || !vmOffered(started, scope, d.keeper())) return []
  return [...computerTools(d), ...fileTools(() => guestFiles(d.keeper))]
}

function computerTools(d: VmToolsDeps): WorkTool[] {
  return computerToolSpecs('anthropic', 'act', { result: true, platform: 'windows' }).map((spec) => ({
    name: rename(spec.name),
    description: LEAD + spec.description.replace(/\bcomputer_(apps|observe|act|batch|result)\b/g, 'windows_$1'),
    input: spec.input as z.ZodType,
    readOnly: spec.name === 'computer_observe' || spec.name === COMPUTER_RESULT_TOOL,
    async run(args, ctx): Promise<WorkToolResult> {
      const h = vmHost()
      const keeper = d.keeper()
      if (!h || !keeper) return { ...workText(NO_VM), isError: true }
      // the setting may have changed since the tools were listed
      if (!vmOffered(ctx, ctx.scope, keeper)) return { ...workText(NOT_ON_VM), isError: true }
      const threadId = ctx.sessionId
      if (spec.name === COMPUTER_RESULT_TOOL) {
        const parsed = ComputerResultInputSchema.safeParse(args)
        const outcome = parsed.success
          ? await d.pending.result(threadId, parsed.data.id, parsed.data.cancel === true, ctx.signal)
          : refusal(hostErrorLine('invalid_args', parsed.error.issues[0]?.message ?? 'refused'))
        return computerContent(windowsWords(outcome), 'parts')
      }
      const refused = h.lease.take(threadId)
      if (refused) return { ...workText(refused), isError: true }
      keeper.touch()
      // the next call wins: a pending call of the thread is cancelled first, and this answer says what became of it
      let opening = await d.pending.supersede(threadId)
      let waking = false
      const outcome = await d.pending.start(
        {
          threadId,
          what: heldCallWhat(spec.name, args as Record<string, unknown>),
          holdWords: () => {
            if (waking) return WAKING_WORDS
            const running = h.sessions.rowOf(threadId)?.running
            return running?.held ? running.words : null
          },
          run: async ({ signal, reader }) => {
            if (keeper.state().state !== 'awake') {
              waking = true
              try {
                await keeper.wake()
              } catch (e) {
                return refusal(hostErrorLine('service_unavailable', e instanceof Error ? e.message : String(e)))
              } finally {
                waking = false
              }
            }
            signal.throwIfAborted()
            const out = await h.sessions.run({ threadId, signal, reader }, spec.name, args)
            keeper.touch()
            return out
          }
        },
        ctx.signal
      )
      opening = [...opening, ...d.pending.take(threadId)]
      return computerContent(windowsWords(opening.length ? { ...outcome, steps: [...opening, ...outcome.steps] } : outcome), 'parts')
    }
  }))
}

/** The Work preamble's line for the VM, where its tools are offered. */
export const VM_PREAMBLE =
  "This workspace may use the owner's Windows VM with the `windows_*` tools: a Windows 11 PC on this host, signed in as he left it. One thread uses it at a time; a send or submit there is held for his press; never type a password, ask him to take over."
