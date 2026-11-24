import { z } from 'zod'
import type { CanvasSource } from './canvas'
import type { HostId, SectorKey } from './ids'

/**
 * What a Work thread may reach: its workspace, its sector and its host.
 * `workScopeOf` (milestone 6) builds one from the session row; a module's
 * tools and preamble take it and decide from it alone.
 */
export interface WorkScope {
  sessionId: string
  /** null: a Work Chat, outside every workspace */
  workspaceId: string | null
  /** null: an unlinked workspace; a Work Chat reads every sector through its own key */
  sector: SectorKey | null
  host: HostId
  away: boolean
  /** the routine run that started the thread, if one did */
  routineRunId: string | null
  /** Whether other people can see the item: a live guest link, a shared flag, a file in Microsoft or Google, or any outside author. */
  shared(source: CanvasSource): boolean
}

/**
 * A desktop a host knows (`work.desktops`): itself when it is a Mac or a PC, each saved host whose last hello
 * named one, and each host registered on its peer link to lend its desktop (a PC paired to the box). A
 * workspace's settings list these as "Computer use on <name>"; `platform` is null for a lender too old to say.
 */
export interface WorkDesktop {
  id: HostId
  name: string
  platform: 'darwin' | 'win32' | null
}

/** A workspace's own Work settings: JSON in `workspaces.work_settings`. */
export interface WorkspaceWorkSettings {
  /** "Computer use on <host>": his Macs and Windows hosts; a new Work workspace starts with every one its host and window know (work/scope.ts `ownerDesktops`), and `work.desktops` lists what may be switched on */
  mayUseDesktop: HostId[]
  model?: string
  reasoning?: string
  voice: boolean
  /**
   * "Computer use on the Windows VM": its threads get the `windows_*` tools (work/winvm). A setting of its own, on for
   * a new Work workspace (stored when it is made; absent reads as off), never an entry in `mayUseDesktop`, which five places read as a list of hosts to dial.
   */
  windowsVm?: boolean
}
export const WorkspaceWorkSettingsSchema = z.object({
  mayUseDesktop: z.array(z.string()).default([]),
  model: z.string().optional(),
  reasoning: z.string().optional(),
  voice: z.boolean().default(false),
  windowsVm: z.boolean().optional()
})
export const DEFAULT_WORKSPACE_WORK_SETTINGS: WorkspaceWorkSettings = Object.freeze({ mayUseDesktop: Object.freeze([]) as unknown as HostId[], voice: false })
/** The defaults as a value of the caller's own: a fresh list each time, so one caller's change is never another's default. */
const defaultWorkspaceWorkSettings = (): WorkspaceWorkSettings => ({ mayUseDesktop: [], voice: false })

/** Parse the stored JSON; a missing or broken value reads as the defaults. */
export function parseWorkspaceWorkSettings(raw: string | null | undefined): WorkspaceWorkSettings {
  if (!raw) return defaultWorkspaceWorkSettings()
  try {
    return WorkspaceWorkSettingsSchema.parse(JSON.parse(raw))
  } catch {
    return defaultWorkspaceWorkSettings()
  }
}

/** The Work switch: one setting per host (`settings.work`), off by default, never synced. */
export const WORK_SETTING_KEY = 'work'
export const WorkSettingsSchema = z.object({ enabled: z.boolean() })
export type WorkSettings = z.infer<typeof WorkSettingsSchema>
export const DEFAULT_WORK_SETTINGS: WorkSettings = { enabled: false }

export function parseWorkSettings(raw: string | null | undefined): WorkSettings {
  if (!raw) return { ...DEFAULT_WORK_SETTINGS }
  try {
    return WorkSettingsSchema.parse(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_WORK_SETTINGS }
  }
}
