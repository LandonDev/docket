import type { ActKind } from '@shared/work'
import { WORK_MODULES, type ActKindDef, type WorkModule } from '../modules'

/**
 * The kinds of outward act this host can hold and carry out. A pillar
 * registers its kinds through `WorkModule.acts`; the outbox adds its own
 * (`addon.call`, `computer.act`, and the two LifeOS-held kinds). A kind
 * nobody registered cannot be held: `ctx.held.create` says which milestone
 * builds it.
 */
export class ActKinds {
  private readonly own = new Map<ActKind, ActKindDef>()

  constructor(private readonly modules: () => readonly WorkModule[] = () => WORK_MODULES) {}

  /** The outbox's own kinds, and a test's. A kind registered here wins over a module's. */
  register<P, M>(def: ActKindDef<P, M>): void {
    this.own.set(def.kind, def as unknown as ActKindDef)
  }

  get(kind: ActKind): ActKindDef | null {
    const own = this.own.get(kind)
    if (own) return own
    for (const module of this.modules()) {
      // The outbox's own are registered above; reading them back through its module would only find them twice.
      if (module.id === 'outbox') continue
      const def = module.acts?.find((a) => a.kind === kind)
      if (def) return def
    }
    return null
  }
}

/**
 * A send that failed before anything went out (a refusal, a switch that was
 * off, an answer that says nothing was done). The row reads `failed` and a
 * plain press may send it again. Any other throw from `execute` reads
 * failed with its outcome unknown: it may have gone, and he must choose
 * "Send again" after checking.
 */
export class ActNotSent extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ActNotSent'
  }
}

/** An act that can no longer be carried out as it was shown: the screen moved on, the draft is gone. Thrown by a kind's `execute`; the row reads `stale`, not `failed`. */
export class ActStale extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ActStale'
  }
}
