import type { Caller } from '../modules'

/**
 * The one gate in front of every press that decides a held act (docs/agents/work-outbox.md "Who may decide"): the
 * Outbox's own methods and Mail's held-draft verbs. A press is his: this host's window (the local socket), or a client
 * key that holds the capability (his phone, a paired desktop). Never a thread (`model`), another host of his over the
 * link (`peer`), or a key made for an MCP client, whatever capabilities any of them carries.
 */

export const NOT_A_PERSON = "forbidden: only the owner decides a held act, a grant or a tool's rule; a thread cannot"

export function mustBePerson(by: Caller, cap: 'approve' | 'admin'): void {
  if (by.kind === 'model' || by.peer !== undefined) throw new Error(NOT_A_PERSON)
  if (by.kind === 'remote' && by.audience !== 'client') throw new Error(NOT_A_PERSON)
  if (!by.caps.includes(cap)) throw new Error(NOT_A_PERSON)
}

/** Who a decision is recorded as: the owner at this host, or the owner through a paired device. */
export const person = (by: Caller): 'owner' | 'owner:remote' => (by.kind === 'local' ? 'owner' : 'owner:remote')
