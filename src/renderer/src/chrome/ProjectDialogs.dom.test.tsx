import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { registry, LOCAL_ENVIRONMENT_ID } from '../lib/connection/registry'
import { IDLE_STATUS, type EnvironmentStatus } from '../lib/connection/types'
import type { Link } from '../lib/connection'
import { workspaceStore } from '../lib/tcserver/workspaces'
import type { ProjectMeta, WorkspaceMeta } from '../lib/tcserver/types'
import { AccountPinFields, NewProjectDialog, ProjectSettingsDialog, ProjectTeardownDialog } from './ProjectDialogs'
import { accountsStore } from '../stores/accounts'
import { emptyAccounts, type AccountPins } from '@server/shared/accounts'
import { PreambleDialog } from './PreambleDialog'
import { resetPlanSettingsForTests } from '../lib/tcserver/plans'

// The sheet's Cancel on a changed draft asks through the confirm host, which no test mounts: its answer is set here.
const confirmed = vi.hoisted(() => ({ answer: false, asked: [] as string[] }))
vi.mock('./ConfirmDialog', async (original) => ({
  ...(await original<object>()),
  confirmAction: async (request: { title: string }) => (confirmed.asked.push(request.title), confirmed.answer)
}))

const failed = vi.hoisted(() => [] as { verb: string; title: string; err: unknown }[])
vi.mock('../lib/threadActionToast', () => ({ actionFailed: (verb: string, title: string, err: unknown) => failed.push({ verb, title, err }) }))
// jsdom has no Web Animations; the settings sheet's scroll area asks for them.
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => []

// Two hosts: this Mac (the `local` slot, host id env_mac, darwin) and the
// box (env_box, linux). One project linked across both, one only on the Mac.
const BOX = 'env_box'

const ws = (environmentId: string, id: string, path: string): WorkspaceMeta => ({
  id,
  name: 'temp-code',
  path,
  git: true,
  linkId: 'wl_1',
  createdAt: 1,
  environmentId
})

const project = (environmentId: string, over: Partial<ProjectMeta>): ProjectMeta => ({
  id: 'p',
  workspaceId: 'w',
  name: 'Alpha',
  mode: 'local',
  branch: null,
  cwd: '/x',
  archived: false,
  createdAt: 1,
  environmentId,
  ...over
})

const MAC_WS = ws(LOCAL_ENVIRONMENT_ID, 'w_mac', '/Users/l/IdeaProjects/temp-code')
const BOX_WS = ws(BOX, 'w_box', '/srv/agents/work/temp-code')
// The Mac's copy still has the old name and preamble: its pull lags the box.
const MAC = project(LOCAL_ENVIRONMENT_ID, {
  id: 'p_mac',
  workspaceId: 'w_mac',
  name: 'Alpha (stale)',
  preamble: 'old rules',
  cwd: MAC_WS.path,
  linkId: 'pl_1'
})
const BOX_COPY = project(BOX, {
  id: 'p_box',
  workspaceId: 'w_box',
  name: 'Alpha',
  preamble: 'box rules',
  cwd: BOX_WS.path,
  linkId: 'pl_1'
})
const SOLO = project(LOCAL_ENVIRONMENT_ID, { id: 'p_solo', workspaceId: 'w_mac', name: 'Solo', cwd: MAC_WS.path })

type Call = { slot: string; method: string; params: Record<string, unknown> }
let calls: Call[] = []
let boxOpen = true
// A project-scope plans.get that fails for good (the global one still answers).
let projectPlansFail = false
let projectReviewFail = false
// Every write refused, for a failed save.
let writeFail = false
// These methods alone refused, for a save that lands in part.
let failOn = new Set<string>()
// These reads never answer, for the sheet's waiting shape; these fail.
let pendingOn = new Set<string>()
let readFailOn = new Set<string>()
// The window's key: null is its own socket, which may do everything.
let key: { caps: string[] } | null = null
// turnpass.set refused alone, after a create that went through.
let turnPassFail = false

// One object a state, as the registry keeps it: a hook that subscribes (useEnvironmentStatus) reads it on every render.
const statuses = new Map<string, EnvironmentStatus>()
const status = (slot: string): EnvironmentStatus => {
  const id = `${slot}:${boxOpen}:${key ? key.caps.join() : 'own'}`
  const kept = statuses.get(id)
  if (kept) return kept
  const made = statusFor(slot)
  statuses.set(id, made)
  return made
}
const statusFor = (slot: string): EnvironmentStatus => {
  const box = slot === BOX
  return {
    ...IDLE_STATUS,
    transport: box && !boxOpen ? 'offline' : 'open',
    lastHello: {
      environmentId: box ? BOX : 'env_mac',
      contract: 1,
      caps: key?.caps ?? [],
      ...(key ? { key: { id: 'laptop' } } : {}),
      build: { release: 1, version: '1.0.1', sha: null, platform: box ? 'linux' : 'darwin' }
    }
  }
}

const linkFor = (slot: string): Link =>
  ({
    environmentId: slot,
    connected: true,
    onOpen: () => () => {},
    request: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ slot, method, params })
      if (projectPlansFail && method === 'plans.get' && params.projectId) throw new Error('not connected')
      if (projectReviewFail && method === 'review.get' && params.projectId) throw new Error('unknown method')
      if (writeFail && !/\.(get|detect|list)$/.test(method) && method !== 'accounts.list') throw new Error('disk full')
      if (failOn.has(method)) throw new Error('disk full')
      if (pendingOn.has(method)) return new Promise(() => {})
      if (readFailOn.has(method)) throw new Error('The computer did not answer')
      if (turnPassFail && method === 'turnpass.set') throw new Error('forbidden: turnpass.set needs admin')
      if (turnPassFail && method === 'project.create') return project(slot, { id: 'p_new', workspaceId: 'w_mac', name: String(params.name) })
      return null
    }
  }) as unknown as Link

const writes = () => calls.filter((c) => !/\.(get|detect|list)$/.test(c.method) && c.method !== 'accounts.list')

beforeEach(() => {
  calls = []
  boxOpen = true
  projectPlansFail = false
  projectReviewFail = false
  writeFail = false
  failOn = new Set()
  pendingOn = new Set()
  readFailOn = new Set()
  key = null
  confirmed.answer = false
  confirmed.asked = []
  turnPassFail = false
  failed.length = 0
  resetPlanSettingsForTests()
  workspaceStore.reset()
  workspaceStore.hydrate([
    { environmentId: LOCAL_ENVIRONMENT_ID, workspaces: [MAC_WS], projects: [MAC, SOLO] },
    { environmentId: BOX, workspaces: [BOX_WS], projects: [BOX_COPY] }
  ])
  vi.spyOn(registry, 'statusOf').mockImplementation(status)
  vi.spyOn(registry, 'environment').mockImplementation((id: string) =>
    id === BOX ? { id, name: 'box', routes: [], credentialRef: id } : undefined
  )
  vi.spyOn(registry, 'linkOf').mockImplementation((slot: string) => linkFor(slot) as never)
  vi.spyOn(workspaceStore, 'refresh').mockResolvedValue()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  workspaceStore.reset()
})

// A closed modal leaves an inert fading copy behind for a moment; read the live one.
const footerNote = () =>
  [...document.body.querySelectorAll('[data-footer-note]')].find((n) => !n.closest('[inert]'))?.textContent ?? null
const saveButton = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement

describe('ProjectSettingsDialog on a linked project', () => {
  it('reads from the box copy, says where it saves, and saves the name there', async () => {
    render(<ProjectSettingsDialog project={MAC} workspace={MAC_WS} onClose={() => {}} />)
    const name = screen.getByDisplayValue('Alpha') as HTMLInputElement
    expect(footerNote()).toBe('Saved on box')
    await waitFor(() => expect(calls.some((c) => c.method === 'build.get')).toBe(true))
    const reads = calls.filter((c) => c.method.endsWith('.get'))
    expect(reads.every((c) => c.slot === BOX)).toBe(true)
    expect(calls.find((c) => c.method === 'build.get')?.params).toMatchObject({ workspaceId: 'w_box', projectId: 'p_box' })

    fireEvent.change(name, { target: { value: 'Alpha two' } })
    await act(async () => {
      fireEvent.click(saveButton())
    })
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0]).toEqual({ slot: BOX, method: 'project.rename', params: { projectId: 'p_box', name: 'Alpha two' } })
  })

  it('disables Save with the reason while the box is offline', () => {
    boxOpen = false
    render(<ProjectSettingsDialog project={MAC} workspace={MAC_WS} onClose={() => {}} />)
    fireEvent.change(screen.getByDisplayValue('Alpha'), { target: { value: 'Alpha two' } })
    expect(saveButton().disabled).toBe(true)
    expect(footerNote()).toBe('box is offline')
  })

  it('an unlinked project reads and saves on its own host, with no footer note', async () => {
    render(<ProjectSettingsDialog project={SOLO} workspace={MAC_WS} onClose={() => {}} />)
    expect(footerNote()).toBeNull()
    fireEvent.change(screen.getByDisplayValue('Solo'), { target: { value: 'Solo two' } })
    // Save waits for every group to answer.
    await waitFor(() => expect(saveButton().disabled).toBe(false))
    await act(async () => {
      fireEvent.click(saveButton())
    })
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0]).toMatchObject({ slot: LOCAL_ENVIRONMENT_ID, method: 'project.rename', params: { projectId: 'p_solo' } })
    expect(calls.every((c) => c.slot === LOCAL_ENVIRONMENT_ID)).toBe(true)
  })
})

describe('ProjectSettingsDialog: New threads start on', () => {
  const field = () => screen.getByRole('combobox', { name: 'New threads start on' })
  const pick = async (name: string) => {
    await act(async () => {
      fireEvent.click(field())
    })
    const option = await screen.findByRole('option', { name })
    await act(async () => {
      fireEvent.pointerDown(option, { pointerType: 'mouse' })
      fireEvent.click(option)
    })
  }

  it('shows Thread defaults’ host until the project picks its own, and saves the pick on the box', async () => {
    render(<ProjectSettingsDialog project={MAC} workspace={MAC_WS} onClose={() => {}} />)
    expect(field().textContent).toContain('Box')
    expect(screen.queryByRole('button', { name: 'Use global setting' })).toBeNull()
    await pick('Mac')
    expect(field().textContent).toContain('Mac')
    await act(async () => {
      fireEvent.click(saveButton())
    })
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0]).toEqual({ slot: BOX, method: 'project.setStartOn', params: { projectId: 'p_box', startOn: 'mac' } })
  })

  it('a project with its own host offers Use global setting, which saves null', async () => {
    workspaceStore.hydrate([{ environmentId: BOX, workspaces: [BOX_WS], projects: [{ ...BOX_COPY, startOn: 'mac' }] }])
    render(<ProjectSettingsDialog project={MAC} workspace={MAC_WS} onClose={() => {}} />)
    expect(field().textContent).toContain('Mac')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Use global setting' }))
    })
    expect(field().textContent).toContain('Box')
    await act(async () => {
      fireEvent.click(saveButton())
    })
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0]).toMatchObject({ method: 'project.setStartOn', params: { projectId: 'p_box', startOn: null } })
  })

  it('a project on one host has no such section', () => {
    render(<ProjectSettingsDialog project={SOLO} workspace={MAC_WS} onClose={() => {}} />)
    expect(screen.queryByRole('combobox', { name: 'New threads start on' })).toBeNull()
  })
})

describe('PreambleDialog on a linked project', () => {
  it('edits the box copy’s text and saves it there', async () => {
    render(<PreambleDialog scope={{ kind: 'project', project: MAC, workspace: MAC_WS }} onClose={() => {}} />)
    const text = screen.getByDisplayValue('box rules') as HTMLTextAreaElement
    expect(footerNote()).toBe('Saved on box')
    fireEvent.change(text, { target: { value: 'new rules' } })
    await act(async () => {
      fireEvent.click(saveButton())
    })
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0]).toEqual({
      slot: BOX,
      method: 'project.setPreamble',
      params: { projectId: 'p_box', preamble: 'new rules', enabled: true }
    })
  })

  it('disables Save with the reason while the box is offline', () => {
    boxOpen = false
    render(<PreambleDialog scope={{ kind: 'project', project: MAC, workspace: MAC_WS }} onClose={() => {}} />)
    fireEvent.change(screen.getByDisplayValue('box rules'), { target: { value: 'new rules' } })
    expect(saveButton().disabled).toBe(true)
    expect(footerNote()).toBe('box is offline')
  })
})

describe('ProjectSettingsDialog as a sheet', () => {
  it('slides in from the right with the name focused and every section open, no folds', async () => {
    render(<ProjectSettingsDialog project={SOLO} workspace={MAC_WS} onClose={() => {}} />)
    const sheet = screen.getByRole('dialog')
    expect(sheet.getAttribute('data-side')).toBe('right')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Name')))
    const headings = [...sheet.querySelectorAll('h3')].map((h) => h.textContent)
    expect(headings).toEqual(['After each turn', 'Reviews', 'Accounts', 'Plans', 'Build'])
    expect(sheet.querySelector('[aria-expanded]:not([data-slot=select-trigger]):not([data-slot=combobox-trigger])')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Use workspace setting' })).toBeNull()
  })

  it('shows a failed save over the footer with one hairline between them, not two', async () => {
    writeFail = true
    render(<ProjectSettingsDialog project={SOLO} workspace={MAC_WS} onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Solo two' } })
    await waitFor(() => expect(saveButton().disabled).toBe(false))
    await act(async () => {
      fireEvent.click(saveButton())
    })
    await waitFor(() => expect(screen.getByText('Name did not save: Disk full.')).toBeTruthy())
    const line = screen.getByRole('dialog').querySelector('[data-project-settings-error]')!
    expect(line.className).not.toContain('border-t')
    expect(line.nextElementSibling!.className).toContain('border-t')
  })

  it('tells the mode from the path by weight, 4px apart', () => {
    render(<ProjectSettingsDialog project={SOLO} workspace={MAC_WS} onClose={() => {}} />)
    const mode = screen.getByRole('dialog').querySelector('[data-project-mode]')!
    expect(mode.className).toContain('font-medium')
    expect(mode.parentElement!.className).toContain('gap-1')
    expect(mode.nextElementSibling!.className).not.toContain('font-medium')
  })
})

const section = (label: string) => [...screen.getByRole('dialog').querySelectorAll('h3')].find((h) => h.textContent === label)!.closest('section')!

describe('ProjectSettingsDialog: each field waits for its value', () => {
  it('holds After each turn and Build in their shape until the host answers, never a pass of nothing in their place', async () => {
    pendingOn = new Set(['turnpass.get', 'build.get'])
    render(<ProjectSettingsDialog project={SOLO} workspace={MAC_WS} onClose={() => {}} />)
    await act(async () => {})
    expect(section('After each turn').querySelectorAll('[data-slot=field-bone]')).toHaveLength(3)
    expect(section('After each turn').querySelector('[role=switch]')).toBeNull()
    expect(section('Build').querySelector('input')).toBeNull()
  })

  it('says a failed read with Retry, which asks again', async () => {
    readFailOn = new Set(['turnpass.get', 'build.get'])
    render(<ProjectSettingsDialog project={SOLO} workspace={MAC_WS} onClose={() => {}} />)
    // Two groups one computer did not answer: one line at the sheet's head, naming it; the groups say nothing more.
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(1))
    expect(screen.getByRole('alert').textContent).toBe('This Mac did not answer.')
    expect(section('After each turn').textContent).not.toContain('did not answer')
    expect(section('Build').textContent).not.toContain('did not answer')
    readFailOn = new Set()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })))
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Run the checks' })).toBeTruthy())
  })
})

describe('ProjectSettingsDialog for a key that may not change it', () => {
  it('shows the admin groups as words with one line saying who can, and still saves the name', async () => {
    key = { caps: ['read', 'operate'] }
    render(<ProjectSettingsDialog project={SOLO} workspace={MAC_WS} onClose={() => {}} />)
    await act(async () => {})
    expect(screen.queryByRole('switch', { name: 'Run the checks' })).toBeNull()
    expect(section('After each turn').textContent).toContain('Run the checks')
    expect(screen.getByRole('dialog').querySelectorAll('[data-managed]')).toHaveLength(1)
    expect(section('Build').querySelector('input')).toBeNull()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Solo two' } })
    await act(async () => fireEvent.click(saveButton()))
    expect(writes().map((w) => w.method)).toEqual(['project.rename'])
  })
})

describe('ProjectSettingsDialog: a save that lands in part', () => {
  it('saves every changed group it can and says which did not and why, and which did', async () => {
    failOn = new Set(['turnpass.set'])
    render(<ProjectSettingsDialog project={SOLO} workspace={MAC_WS} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Run the checks' })).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Solo two' } })
    fireEvent.click(screen.getByRole('switch', { name: 'Run the checks' }))
    await act(async () => fireEvent.click(saveButton()))
    await waitFor(() => expect(screen.getByText('After each turn did not save: Disk full. Name saved.')).toBeTruthy())
    expect(writes().map((w) => w.method)).toEqual(['project.rename', 'turnpass.set'])
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('words the line for one refused and none saved, and for three saved', async () => {
    const { partialSaveWords } = await import('./ProjectDialogs')
    expect(partialSaveWords([], [{ name: 'Build', why: 'Disk full' }])).toBe('Build did not save: Disk full.')
    expect(partialSaveWords(['Name', 'Reviews', 'Plans'], [{ name: 'Build', why: 'Disk full.' }])).toBe('Build did not save: Disk full. Name, Reviews and Plans saved.')
  })
})

describe('ProjectSettingsDialog: Cancel on a changed draft', () => {
  it('asks first, and keeps the sheet and the draft when he says no', async () => {
    const onClose = vi.fn()
    render(<ProjectSettingsDialog project={SOLO} workspace={MAC_WS} onClose={onClose} />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Solo two' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' })))
    expect(confirmed.asked).toEqual(['Discard your changes?'])
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Solo two')
    expect(writes()).toEqual([])
  })

  it('closes at once with nothing changed', async () => {
    render(<ProjectSettingsDialog project={SOLO} workspace={MAC_WS} onClose={() => {}} />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' })))
    expect(confirmed.asked).toEqual([])
  })
})

describe('ProjectSettingsDialog while the plans load', () => {
  it('holds the Plans section in the shape of its five rows', () => {
    render(<ProjectSettingsDialog project={SOLO} workspace={MAC_WS} onClose={() => {}} />)
    const plans = [...screen.getByRole('dialog').querySelectorAll('h3')].find((h) => h.textContent === 'Plans')!.closest('section')!
    expect(plans.querySelectorAll('[data-slot=field-bone]')).toHaveLength(5)
    // Drawn as the loaded rows are: no hairline between the bones.
    expect(plans.querySelector('[data-slot=field-bone]')?.className).not.toContain('border')
  })
})

describe('ProjectSettingsDialog when the project\'s plans fail to load', () => {
  it('says why with Retry instead of fields from the global set that would never save', async () => {
    projectPlansFail = true
    render(<ProjectSettingsDialog project={SOLO} workspace={MAC_WS} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('Not connected.')).toBeTruthy())
    expect(screen.queryByRole('switch', { name: 'Start the build when a plan is done' })).toBeNull()
    projectPlansFail = false
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    })
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Start the build when a plan is done' })).toBeTruthy())
  })
})

describe('ProjectSettingsDialog when the project\'s review set fails to load', () => {
  it('says why with Retry instead of fields that would never save', async () => {
    projectReviewFail = true
    render(<ProjectSettingsDialog project={SOLO} workspace={MAC_WS} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('Unknown method.')).toBeTruthy())
    expect(screen.queryByRole('switch', { name: 'Review before merge' })).toBeNull()
    projectReviewFail = false
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    })
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Review before merge' })).toBeTruthy())
  })
})

describe('ProjectTeardownDialog on a linked project', () => {
  it('archive archives every copy, the box first', async () => {
    const done = vi.fn()
    render(<ProjectTeardownDialog project={MAC} action="archive" onClose={() => {}} onDone={done} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    })
    await waitFor(() => expect(done).toHaveBeenCalled())
    expect(writes().map((c) => [c.slot, c.method, c.params.projectId])).toEqual([
      [BOX, 'project.archive', 'p_box'],
      [LOCAL_ENVIRONMENT_ID, 'project.archive', 'p_mac']
    ])
  })

  it('archive is held with the reason while the box is offline', () => {
    boxOpen = false
    render(<ProjectTeardownDialog project={MAC} action="archive" onClose={() => {}} onDone={() => {}} />)
    expect((screen.getByRole('button', { name: 'Archive' }) as HTMLButtonElement).disabled).toBe(true)
    expect(footerNote()).toBe('box is offline')
  })

  it('delete takes this copy only, unless the copy on the box is ticked', async () => {
    const done = vi.fn()
    const first = render(<ProjectTeardownDialog project={MAC} action="delete" onClose={() => {}} onDone={done} />)
    // A choice to make: a form dialog, never a confirm holding a checkbox.
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByRole('dialog').textContent).toContain('Delete Alpha (stale)?')
    expect(screen.getByRole('dialog').textContent).toContain('Its threads are deleted for good.')
    expect(screen.getByRole('button', { name: 'Delete project' }).getAttribute('data-variant')).toBe('destructive')
    const also = screen.getByRole('checkbox', { name: 'Also delete the copy on box' })
    expect(also.getAttribute('aria-checked')).toBe('false')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete project' }))
    })
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1))
    expect(writes().map((c) => [c.slot, c.method, c.params.projectId])).toEqual([
      [LOCAL_ENVIRONMENT_ID, 'project.delete', 'p_mac']
    ])
    first.unmount()

    calls = []
    render(<ProjectTeardownDialog project={MAC} action="delete" onClose={() => {}} onDone={done} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Also delete the copy on box' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete project' }))
    })
    await waitFor(() => expect(done).toHaveBeenCalledTimes(2))
    expect(writes().map((c) => [c.slot, c.method, c.params.projectId])).toEqual([
      [LOCAL_ENVIRONMENT_ID, 'project.delete', 'p_mac'],
      [BOX, 'project.delete', 'p_box']
    ])
  })

  // council-2 F9.2: a host's name mid-line is lower case ("the box", "this Mac"), DESIGN "Typography and text hierarchy".
  it('names the copy\'s host mid-line in lower case', () => {
    vi.mocked(registry.environment).mockImplementation((id: string) =>
      id === BOX ? { id, name: 'The box', routes: [], credentialRef: id } : undefined
    )
    render(<ProjectTeardownDialog project={MAC} action="delete" onClose={() => {}} onDone={() => {}} />)
    expect(screen.getByRole('checkbox', { name: 'Also delete the copy on the box' })).toBeTruthy()
  })

  it('an unlinked project with nothing to clean up is a plain confirm', () => {
    render(<ProjectTeardownDialog project={SOLO} action="delete" onClose={() => {}} onDone={() => {}} />)
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Delete project' })).toBeTruthy()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(footerNote()).toBeNull()
  })

  it('its confirm is ConfirmDialog: the verb holds its width, and Done runs after the exit', async () => {
    const done = vi.fn()
    render(<ProjectTeardownDialog project={SOLO} action="delete" onClose={() => {}} onDone={done} />)
    const verb = screen.getByRole('button', { name: 'Delete project' })
    expect(verb.querySelector('[data-slot=busy-label]')).not.toBeNull()
    expect(verb.getAttribute('data-variant')).toBe('destructive')
    await act(async () => {
      fireEvent.click(verb)
    })
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1))
    expect(writes().map((c) => [c.slot, c.method, c.params.projectId])).toEqual([[LOCAL_ENVIRONMENT_ID, 'project.delete', 'p_solo']])
  })
})

describe('NewProjectDialog', () => {
  it('focuses the name, picks the mode from the toggle, and creates once the exit has played', async () => {
    const created = vi.fn()
    render(<NewProjectDialog workspace={MAC_WS} onClose={() => {}} onCreated={created} />)
    const name = screen.getByLabelText('Name')
    await waitFor(() => expect(document.activeElement).toBe(name))
    const worktree = screen.getByRole('button', { name: 'Worktree' })
    const local = screen.getByRole('button', { name: 'Local' })
    expect(worktree.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByLabelText('Branch')).toBeTruthy()
    expect(screen.getByText('Own branch and folder.')).toBeTruthy()

    fireEvent.click(local)
    expect(local.getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByLabelText('Branch')).toBeNull()
    // Pressing the chosen mode again keeps it: a mode is never unset.
    fireEvent.click(local)
    expect(local.getAttribute('aria-pressed')).toBe('true')

    fireEvent.change(name, { target: { value: 'Search' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    })
    await waitFor(() => expect(created).toHaveBeenCalledTimes(1))
    expect(writes().find((c) => c.method === 'project.create')?.params).toEqual({ workspaceId: 'w_mac', name: 'Search', mode: 'local' })
  })
})

describe('NewProjectDialog when After each turn does not save', () => {
  it('closes on the created project, names the setting that did not save, and never offers Create again', async () => {
    turnPassFail = true
    const created = vi.fn()
    render(<NewProjectDialog workspace={MAC_WS} onClose={() => {}} onCreated={created} />)
    fireEvent.click(screen.getByRole('button', { name: 'Local' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Search' } })
    fireEvent.click(screen.getByRole('switch', { name: 'Run the checks' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    })
    await waitFor(() => expect(created).toHaveBeenCalledTimes(1))
    expect(writes().filter((c) => c.method === 'project.create')).toHaveLength(1)
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({ verb: 'save After each turn', title: 'Search' })
  })
})

describe('AccountPinFields', () => {
  const keysLink = (keys: string[]): Link =>
    ({
      environmentId: LOCAL_ENVIRONMENT_ID,
      connected: true,
      onOpen: () => () => {},
      onClose: () => () => {},
      onPush: () => () => {},
      request: async (method: string) => {
        if (method !== 'accounts.list') return null
        const snap = emptyAccounts()
        snap.updatedAt = 1
        snap.providers.claude.profiles = [{ name: 'a@x.com', email: 'a@x.com', createdAt: 1, active: true }]
        snap.providers.meta.profiles = keys.map((name) => ({ name, createdAt: 1, active: false, static: true, kind: 'key' as const }))
        return snap
      }
    }) as unknown as Link
  const mount = async (keys: string[], value: AccountPins = {}) => {
    accountsStore.attach(keysLink(keys))
    await act(() => new Promise((r) => setTimeout(r, 0)))
    render(
      <AccountPinFields
        environmentId={LOCAL_ENVIRONMENT_ID}
        value={value}
        onChange={() => {}}
        inheritLabel={() => 'Inherit (auto)'}
      />
    )
  }
  afterEach(() => accountsStore.reset())

  it('says an agent app with no account to pick as words, never a select that cannot open', async () => {
    await mount([])
    // Codex has no account and no pin: its value as words; Claude has one to pick: a select.
    expect(screen.queryByRole('combobox', { name: 'Codex' })).toBeNull()
    expect(document.querySelector('[data-account-value]')?.textContent).toBe('Inherit (auto)')
    expect(screen.getByRole('combobox', { name: 'Claude' })).toBeTruthy()
  })

  it('has a Meta row only once the host holds a key, named Meta with the keys as its choices', async () => {
    await mount([])
    expect(screen.queryByRole('combobox', { name: 'Meta' })).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Claude' })).toBeTruthy()
    cleanup()
    await mount(['Work', 'Meta key …9QzT'], { meta: 'Work' })
    const meta = screen.getByRole('combobox', { name: 'Meta' }) as HTMLButtonElement
    expect(meta.disabled).toBe(false)
    expect(meta.textContent).toContain('Work')
    expect(meta.textContent).not.toContain('not in Aliax')
  })
})

describe('ProjectSettingsDialog: Save and the groups that did not load', () => {
  it('holds Save while a group is still reading', async () => {
    pendingOn = new Set(['turnpass.get'])
    render(<ProjectSettingsDialog project={SOLO} workspace={MAC_WS} onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Solo two' } })
    await act(async () => {})
    expect(saveButton().disabled).toBe(true)
  })

  it('says a group that did not load is not saved, says its failure once at the head with Retry on the same line, and still saves the rest', async () => {
    readFailOn = new Set(['build.get'])
    render(<ProjectSettingsDialog project={SOLO} workspace={MAC_WS} onClose={() => {}} />)
    // Over the footer, never in it: Save stays beside Cancel at any width.
    await waitFor(() => expect(document.querySelector('[data-sheet-note]')?.textContent).toBe('Only what loaded is saved'))
    expect(footerNote()).toBeNull()
    // Said at the sheet's head, with its Retry on the same line; the Build group draws nothing under its heading.
    expect(section('Build').querySelectorAll('[role=alert]')).toHaveLength(0)
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(document.querySelector('[data-read-failures] [data-slot=page-error-line] button')?.textContent).toBe('Retry')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Solo two' } })
    await waitFor(() => expect(saveButton().disabled).toBe(false))
  })

  it('puts Use workspace setting at the end of its group\'s heading line', async () => {
    render(<ProjectSettingsDialog project={SOLO} workspace={MAC_WS} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Run the checks' })).toBeTruthy())
    fireEvent.click(screen.getByRole('switch', { name: 'Run the checks' }))
    const button = await screen.findByRole('button', { name: 'Use workspace setting' })
    expect(button.parentElement?.querySelector('h3')?.textContent).toBe('After each turn')
  })
})

describe('ProjectSettingsDialog when every group fails for one computer', () => {
  it('says it once at the head of the sheet, with one Retry that asks every group again, and draws no group under it', async () => {
    readFailOn = new Set(['turnpass.get', 'build.get', 'review.get', 'plans.get', 'accounts.list'])
    render(<ProjectSettingsDialog project={SOLO} workspace={MAC_WS} onClose={() => {}} />)
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(1))
    expect(screen.getByRole('alert').textContent).toBe('This Mac did not answer.')
    expect([...screen.getByRole('dialog').querySelectorAll('h3')].map((h) => h.textContent)).toEqual([])
    readFailOn = new Set()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })))
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Run the checks' })).toBeTruthy())
  })
})

describe('ProjectSettingsDialog: Accounts read their own state', () => {
  it('holds their shape until the accounts answer, never Same as the workspace before', async () => {
    pendingOn = new Set(['accounts.list'])
    render(<ProjectSettingsDialog project={SOLO} workspace={MAC_WS} onClose={() => {}} />)
    await act(async () => {})
    expect(section('Accounts').querySelectorAll('[data-slot=field-bone]')).toHaveLength(2)
    expect(section('Accounts').textContent).not.toContain('Same as the workspace')
  })
})

describe('ProjectSettingsDialog: its subtitle', () => {
  it('wraps the path rather than cut its end, which names the project', () => {
    render(<ProjectSettingsDialog project={SOLO} workspace={MAC_WS} onClose={() => {}} />)
    const path = screen.getByRole('dialog').querySelector('[data-project-path]')!
    expect(path.className).not.toContain('truncate')
    expect(path.className).toContain('[overflow-wrap:anywhere]')
    // It breaks after a slash, a folder's name kept whole.
    expect(path.querySelectorAll('wbr').length).toBeGreaterThan(0)
    expect(path.textContent).toBe('~/IdeaProjects/temp-code')
  })
})
