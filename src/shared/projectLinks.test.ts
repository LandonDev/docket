import { describe, expect, it } from 'vitest'
import {
  decideLink,
  matchProjects,
  matchWorkspaces,
  pairable,
  newProjectLinkId,
  newWorkspaceLinkId,
  projectMatchKey,
  settingsHomeOf,
  headlessOf,
  type HostBuild,
  workspaceMatchKey,
  type LinkableProject,
  type LinkableWorkspace
} from './projectLinks'

/** The pure link rules (CLAUDE.md "One project across hosts"). */

const ws = (id: string, path: string, patch: Partial<LinkableWorkspace> = {}): LinkableWorkspace => ({
  id,
  path,
  createdAt: 1,
  ...patch
})
const pr = (id: string, workspaceId: string, name: string, patch: Partial<LinkableProject> = {}): LinkableProject => ({
  id,
  workspaceId,
  name,
  createdAt: 1,
  ...patch
})

describe('keys', () => {
  it('a workspace keys by its repo, lowercased, else its folder name', () => {
    expect(workspaceMatchKey(ws('a', '/Users/me/IdeaProjects/Temp-Code', { githubRepo: 'LandonDev/Temp-Code' }))).toBe('repo:landondev/temp-code')
    expect(workspaceMatchKey(ws('a', '/srv/agents/work/Temp-Code/'))).toBe('name:temp-code')
    expect(workspaceMatchKey(ws('a', '/x', { githubRepo: '  ' }))).toBe('name:x')
  })
  it('a project keys by its name, trimmed and lowercased', () => {
    expect(projectMatchKey('  iOS App ')).toBe('ios app')
  })
  it('mints prefixed ids', () => {
    expect(newWorkspaceLinkId()).toMatch(/^wl_[\w-]{12}$/)
    expect(newProjectLinkId()).toMatch(/^pl_[\w-]{12}$/)
    expect(newProjectLinkId()).not.toBe(newProjectLinkId())
  })
})

describe('matchWorkspaces', () => {
  it('pairs by repo first, then by folder name', () => {
    const local = [ws('m1', '/Users/me/IdeaProjects/temp-code', { githubRepo: 'LandonDev/temp-code' }), ws('m2', '/Users/me/IdeaProjects/notes')]
    const peer = [ws('b1', '/srv/agents/work/tc-clone', { githubRepo: 'landondev/temp-code' }), ws('b2', '/srv/agents/work/Notes'), ws('b3', '/srv/agents/work/other')]
    expect(matchWorkspaces(local, peer).map((p) => [p.local.id, p.peer.id])).toEqual([
      ['m1', 'b1'],
      ['m2', 'b2']
    ])
  })
  it('never pairs a Work workspace (architecture §19): not with a Work one of another sector or the same, not with a code one', () => {
    const local = [ws('m-purdue', '/Users/me/Work/Both', { kind: 'work' }), ws('m-code', '/Users/me/IdeaProjects/Shop')]
    const peer = [ws('b-life', '/srv/agents/work/Work/Both', { kind: 'work' }), ws('b-shop', '/srv/agents/work/Work/Shop', { kind: 'work' })]
    expect(matchWorkspaces(local, peer)).toEqual([])
    expect(pairable({ kind: 'work' })).toBe(false)
    expect(pairable({})).toBe(true)
  })
  it('takes at most one row per host per key: the oldest', () => {
    const local = [ws('m-new', '/a/temp-code', { createdAt: 5 }), ws('m-old', '/b/temp-code', { createdAt: 2 })]
    const peer = [ws('b-old', '/c/temp-code', { createdAt: 1 }), ws('b-new', '/d/temp-code', { createdAt: 9 })]
    expect(matchWorkspaces(local, peer)).toEqual([{ local: local[1], peer: peer[0] }])
  })
  it('a repo workspace never pairs with a folder-name one', () => {
    expect(matchWorkspaces([ws('m', '/x/temp-code', { githubRepo: 'a/temp-code' })], [ws('b', '/y/temp-code')])).toEqual([])
  })
})

describe('matchProjects', () => {
  const pairs = matchWorkspaces([ws('mw', '/m/temp-code')], [ws('bw', '/b/temp-code')])
  it('pairs by name inside paired workspaces only', () => {
    const local = [pr('m1', 'mw', 'iOS App'), pr('m2', 'mw', 'Alpha'), pr('m3', 'other', 'Alpha')]
    const peer = [pr('b1', 'bw', 'ios app '), pr('b2', 'bw', 'Beta'), pr('b3', 'elsewhere', 'Alpha')]
    expect(matchProjects(pairs, local, peer).map((p) => [p.local.id, p.peer.id])).toEqual([['m1', 'b1']])
  })
  it('the oldest of two same-named projects on one host pairs', () => {
    const local = [pr('m-new', 'mw', 'Alpha', { createdAt: 9 }), pr('m-old', 'mw', 'alpha', { createdAt: 3 })]
    const peer = [pr('b', 'bw', 'ALPHA')]
    expect(matchProjects(pairs, local, peer).map((p) => p.local.id)).toEqual(['m-old'])
  })
})

describe('decideLink', () => {
  const mint = (): string => 'pl_minted'
  it('mints when neither side has an id and stamps both', () => {
    expect(decideLink(null, undefined, true, mint)).toEqual({ linkId: 'pl_minted', local: true, peer: true })
  })
  it('adopts the one side that has an id', () => {
    expect(decideLink('pl_a', null, true, mint)).toEqual({ linkId: 'pl_a', local: false, peer: true })
    expect(decideLink(null, 'pl_b', false, mint)).toEqual({ linkId: 'pl_b', local: true, peer: false })
  })
  it('on a conflict the settings home wins', () => {
    expect(decideLink('pl_mac', 'pl_box', true, mint)).toEqual({ linkId: 'pl_box', local: true, peer: false })
    expect(decideLink('pl_box', 'pl_mac', false, mint)).toEqual({ linkId: 'pl_box', local: false, peer: true })
  })
  it('equal ids decide nothing', () => {
    expect(decideLink('pl_a', 'pl_a', true, mint)).toBeNull()
  })
})

describe('settingsHomeOf', () => {
  const builds: Record<string, HostBuild | undefined> = {
    env_mac: { platform: 'darwin', headless: false },
    env_box: { platform: 'linux', headless: true },
    env_box2: { platform: 'linux', headless: true },
    env_a_pc: { platform: 'win32', headless: false },
    env_a_desk: { platform: 'linux', headless: false },
    env_old_box: { platform: 'linux' },
    env_old_mac: { platform: 'darwin' }
  }
  const buildOf = (id: string): HostBuild | undefined => builds[id]
  const home = (...ids: string[]): string | null => settingsHomeOf(ids.map((environmentId) => ({ environmentId })), buildOf)
  it('is the copy on the headless host', () => {
    expect(home('env_mac', 'env_box')).toBe('env_box')
    expect(home('env_box', 'env_mac')).toBe('env_box')
  })
  it('a win32 desktop never becomes home beside the box, whichever id sorts first', () => {
    expect(home('env_a_pc', 'env_box')).toBe('env_box')
    expect(home('env_a_pc', 'env_mac', 'env_box')).toBe('env_box')
  })
  it('a linux desktop never becomes home beside the box', () => {
    expect(home('env_a_desk', 'env_box')).toBe('env_box')
  })
  it('a build older than the headless field: linux is the box, darwin a desktop', () => {
    expect(headlessOf({ platform: 'linux' })).toBe(true)
    expect(headlessOf({ platform: 'win32' })).toBe(false)
    expect(headlessOf(undefined)).toBeUndefined()
    expect(home('env_a_pc', 'env_old_box')).toBe('env_old_box')
    expect(home('env_old_mac', 'env_old_box')).toBe('env_old_box')
  })
  it('two headless copies: the id that sorts first; desktops alone: the same', () => {
    expect(home('env_box2', 'env_box')).toBe('env_box')
    expect(home('env_mac', 'env_a_pc')).toBe('env_a_pc')
  })
  it('a host not yet heard from counts as a box, below one heard to be headless', () => {
    expect(home('env_mac', 'env_unknown')).toBe('env_unknown')
    expect(home('env_a_pc', 'env_unknown')).toBe('env_unknown')
    expect(home('env_box', 'env_0unknown')).toBe('env_box')
  })
  it('one copy is its own home; none is null', () => {
    expect(home('env_mac')).toBe('env_mac')
    expect(home('env_a_pc')).toBe('env_a_pc')
    expect(home()).toBeNull()
  })
})
