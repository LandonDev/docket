import { describe, expect, it } from 'vitest'
import { CONHOST_PATH, doorArguments, doorTask, OFFICE_POLICY, ONEDRIVE_POLICY, SERVICE_PATH, SETUP_STEPS, setupScript, startDoorScript, TOKEN_PATH } from './setup'

/** The door's logon task and the guest's OneDrive policies, as setup and each wake write them. */

describe("the door's logon task", () => {
  it('runs the service under the headless console host, so no terminal window sits on his desktop', () => {
    expect(doorArguments(47800)).toBe(`--headless "${SERVICE_PATH}" serve --listen 127.0.0.1:47800 --token-file "${TOKEN_PATH}"`)
    const task = doorTask()
    expect(task).toContain(`$action.Path = '${CONHOST_PATH}'`)
    expect(task).toContain(`$action.Arguments = '${doorArguments()}'`)
    expect(task).not.toContain(`$action.Path = '${SERVICE_PATH}'`)
  })
  it('is the task setup registers', () => {
    const script = setupScript({ token: 'x'.repeat(40) })
    expect(script).toContain(doorTask())
    for (const step of SETUP_STEPS) expect(script).toContain(`Step "${step}"`)
  })
  it("at a wake, registers a task from before the headless host again and ends its door, which shows a window; a door that runs is left", () => {
    const script = startDoorScript()
    expect(script).toMatch(/Actions\.Item\(1\)\.Path -ne 'C:\\Windows\\System32\\conhost\.exe'/)
    expect(script).toMatch(/Get-Process tc-computer[^\n]*Stop-Process -Force\n[^\n]*\n\$svc = New-Object/)
    expect(script).toMatch(/if \(-not \(Get-Process tc-computer[^)]*\)\) \{ \$doorTask\.Run/)
  })
})

describe("OneDrive's policies in the guest", () => {
  it('keeps files on demand, offers no folder backup or tutorial, and has Storage Sense send a file back to the cloud after a day unopened', () => {
    for (const line of ["'FilesOnDemandEnabled' 1", "'KFMBlockOptIn' 1", "'DisableTutorial' 1", "'AllowStorageSenseGlobal' 1", "'ConfigStorageSenseGlobalCadence' 1", "'ConfigStorageSenseCloudContentDehydrationThreshold' 1"]) expect(ONEDRIVE_POLICY).toContain(line)
    expect(ONEDRIVE_POLICY).toContain('HKLM:\\SOFTWARE\\Policies\\Microsoft\\OneDrive')
    expect(setupScript({ token: 'x'.repeat(40) })).toContain(ONEDRIVE_POLICY)
  })
})

describe("Office's first run in the guest", () => {
  it("skips the licensing dialog, which does not draw on this image, by Microsoft's viewer mode policy: he signs in from the title bar", () => {
    expect(OFFICE_POLICY).toContain("HKLM:\\SOFTWARE\\Policies\\Microsoft\\Office\\16.0\\Common\\Licensing")
    expect(OFFICE_POLICY).toContain("-Name 'ViewerMode' -Value 1 -Type DWord")
    expect(setupScript({ token: 'x'.repeat(40) })).toContain(OFFICE_POLICY)
    expect(SETUP_STEPS).toContain('Office viewer mode')
  })
})
