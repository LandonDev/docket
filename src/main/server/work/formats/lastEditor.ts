import * as docx from 'work-kit/formats/docx'

/**
 * A Word file he writes through an editor names him as its last editor and keeps its own author (plan cBclQIRDtvVS
 * decision 16; docs/agents/work-docs.md "Authors"). The name is his Microsoft account's display name, and only that: never
 * LifeOS's name for him or a sign-in address. No host reads that name yet (the Windows VM's helper reads OneDrive's and
 * Office's sign-in addresses, the Mac none), so it is unknown and the file names no last editor: work-kit writes none
 * rather than a placeholder. Where a host comes to know it, `microsoftDisplayName` answers it.
 */
export function microsoftDisplayName(): string | null {
  return null
}

/** The name as work-kit's Word writers take it, where the pinned work-kit takes one (it exports `lastEditorOf`); nothing otherwise. */
export function lastEditorOption(name: string | null, kit: object = docx): { lastEditor?: string } {
  const named = name?.trim()
  if (!named || typeof (kit as { lastEditorOf?: unknown }).lastEditorOf !== 'function') return {}
  return { lastEditor: named.slice(0, 255) }
}
