import { PassThrough } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkCtx } from '../../modules'
import { ensureSuggestionTables } from '../../sheets/suggestions'
import type { HelperProcess } from '../com/carrier'
import { ensureExcelTables } from '../excel'
import { ensureFilesTables } from '../files/library'
import { TC_OFFICE_CS } from '../com/source'
import { NO_LICENCE, setVmHelperStart, setVmState, vmAllowed, vmHasOffice, vmHereOf } from './office'

/** Office in the Windows VM over a stand-in helper that speaks the helper's frames on one socket-like pair. */

function helper(answer: (verb: string, args: unknown) => { ok: true; value: unknown } | { ok: false; error: { code?: string; message?: string; hresult?: string } }): () => Promise<HelperProcess> {
  return async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    stdin.setEncoding('utf8').on('data', (d: string) => {
      for (const line of d.split('\n').filter(Boolean)) {
        const req = JSON.parse(line) as { id: number; verb: string; args: unknown }
        stdout.write(JSON.stringify({ id: req.id, ...answer(req.verb, req.args) }) + '\n')
      }
    })
    setImmediate(() => stdout.write(JSON.stringify({ event: 'ready', version: 1 }) + '\n'))
    return { stdin, stdout, kill: () => true, once: () => undefined }
  }
}

const ctxOf = (office: { installed: boolean; licensed: boolean | null } | null): WorkCtx => {
  const db = new DatabaseSync(':memory:')
  ensureFilesTables(db)
  ensureSuggestionTables(db)
  ensureExcelTables(db)
  if (office) db.prepare('INSERT INTO work_office_files (key, value) VALUES (?, ?)').run('vm:status', JSON.stringify({ at: 1, status: { onedrive: { installed: true, running: true, account: null }, mounts: [], office: { ...office, version: '16', apps: ['excel'], account: null } }, tops: {} }))
  return { db, log: () => {}, settings: { workspace: () => ({ mayUseDesktop: [], windowsVm: true }) } } as unknown as WorkCtx
}

afterEach(() => {
  setVmHelperStart(null)
  setVmState(null)
})

describe('Office in the Windows VM', () => {
  it("drives Excel there through the guest's helper, one frame per call", async () => {
    setVmHelperStart(helper((verb) => ({ ok: true, value: verb === 'workbooks' ? [{ key: 'C:\\b.xlsx', name: 'b.xlsx', sheets: [] }] : null })))
    const here = vmHereOf(ctxOf({ installed: true, licensed: true }))
    expect(await here.carrier.workbooks()).toEqual([{ key: 'C:\\b.xlsx', name: 'b.xlsx', sheets: [] }])
    expect(here.carrier.kind).toBe('com')
  })

  it("says an Office with no licence views only, where the app answers a bare code; a licensed one's failure stays as it is", async () => {
    const refuse = helper(() => ({ ok: false, error: { code: 'failed', message: 'Microsoft Excel answered: Exception from HRESULT: 0x800A03EC', hresult: '0x800A03EC' } }))
    setVmHelperStart(refuse)
    await expect(vmHereOf(ctxOf({ installed: true, licensed: false })).carrier.readRange('b', 's', 'A1')).rejects.toMatchObject({ message: NO_LICENCE, code: 'not-allowed' })
    setVmHelperStart(refuse)
    await expect(vmHereOf(ctxOf({ installed: true, licensed: true })).carrier.readRange('b', 's', 'A1')).rejects.toThrow('0x800A03EC')
  })

  it('says nothing of a licence where Office has not been read, or was never read in this VM', async () => {
    const refuse = helper(() => ({ ok: false, error: { code: 'failed', message: 'Microsoft Excel answered: Exception from HRESULT: 0x800A03EC', hresult: '0x800A03EC' } }))
    for (const office of [{ installed: true, licensed: null }, null]) {
      setVmHelperStart(refuse)
      const err = await vmHereOf(ctxOf(office)).carrier.readRange('b', 's', 'A1').catch((e: unknown) => e)
      expect(err).toMatchObject({ code: 'failed' })
      expect((err as Error).message).toContain('0x800A03EC')
    }
  })

  it('is a place for a thread only where its workspace turns the VM on, the VM is set up, and Office is installed there', () => {
    const ctx = ctxOf({ installed: true, licensed: false })
    setVmState(() => ({ state: 'asleep', cannot: null }))
    expect(vmAllowed(ctx, { workspaceId: 'w1' })).toBe(true)
    expect(vmAllowed(ctx, { workspaceId: null })).toBe(false)
    expect(vmHasOffice(ctx)).toBe(true)
    expect(vmHasOffice(ctxOf({ installed: false, licensed: null }))).toBe(false)
    expect(vmHasOffice(ctxOf(null))).toBe(false)
    setVmState(() => ({ state: 'none', cannot: null }))
    expect(vmAllowed(ctx, { workspaceId: 'w1' })).toBe(false)
    setVmState(() => null)
    expect(vmAllowed(ctx, { workspaceId: 'w1' })).toBe(false)
    expect(vmAllowed({ settings: { workspace: () => ({ mayUseDesktop: [], windowsVm: false }) } } as never, { workspaceId: 'w1' })).toBe(false)
  })

  describe("the guest's helper (TcOffice.cs, built only in Windows)", () => {
    it('reads and writes a formula through Formula where Formula2 answers 0x800A03EC (an Excel without dynamic arrays)', () => {
      expect(TC_OFFICE_CS).toContain('public static bool NoFormula2(COMException e) { var h = (uint)e.ErrorCode; return h == 0x80020006 || h == 0x800A03EC; }')
      expect(TC_OFFICE_CS).toContain('catch (COMException e) { if (!NoFormula2(e)) throw; f = com.Get(r, "Formula"); }')
      expect(TC_OFFICE_CS).toContain('catch (COMException e) { if (!NoFormula2(e)) throw; com.Set(r, "Formula", v); }')
      expect(TC_OFFICE_CS).not.toContain('!= 0x80020006) throw')
    })

    it("says Office is licensed by a Provisioned licence file named in the CID mapping, and who by OneAuth's account", () => {
      expect(TC_OFFICE_CS).toContain('@"\\CIDToLicenseIdsMapping"')
      expect(TC_OFFICE_CS).toContain('Licensed(Path.Combine(local, @"Microsoft\\Office\\Licenses"), ids)')
      expect(TC_OFFICE_CS).toContain('"Provisioned".Equals(')
      expect(TC_OFFICE_CS).toContain('OfficeAccount(Path.Combine(local, @"Microsoft\\OneAuth\\accounts"), cids)')
      expect(TC_OFFICE_CS).toContain('linked["com.microsoft.Office"] as string != "associated"')
      // installed: a yes or a no, never unknown; the grace Office starts with is not a licence
      expect(TC_OFFICE_CS).toContain('licensed = held;')
      expect(TC_OFFICE_CS).not.toContain('InstalledGraceKey")')
    })
  })
})
