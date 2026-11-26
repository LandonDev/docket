import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * People read Docket (APP_NAME); the OS still shows TempCode (OS_APP_NAME).
 * Any other "TempCode" in code is a name another program keys on, a path or a
 * file, and is held here with its reason. A new one fails until it says Docket,
 * uses a constant, or joins this list.
 */
const HELD: Record<string, [string, string][]> = {
  'src/shared/appName.ts': [["OS_APP_NAME = 'TempCode'", 'the bundle name macOS and Windows show']],
  'src/main/printOut.ts': [["'TempCode-print'", 'a temp folder name']],
  'src/main/downloads.ts': [['`TempCode download', 'a part file name in Downloads']],
  'src/main/pty.ts': [["TERM_PROGRAM = 'TempCode'", 'shells and prompts key on TERM_PROGRAM']],
  'src/main/appshots.ts': [["'-x', 'TempCode'", 'the process name (findings row 53)']],
  'src/main/addonHostSpawn.ts': [["'TempCode Add-ons'", 'a process name in Activity Monitor and the process guard']],
  'src/main/execBrokerSpawn.ts': [["'TempCode Exec'", 'a process name']],
  'src/main/gatewaySpawn.ts': [["'TempCode Gateway'", 'a process name']],
  'src/main/server/work/service/spawn.ts': [["'TempCode Work'", 'a process name']],
  'src/main/server/work/sheets/spawnWorker.ts': [["'TempCode Sheets'", 'a process name']],
  'src/main/server/projectPreamble.ts': [['/Applications/TempCode.app', 'the bundle on disk']],
  'src/main/server/tls.ts': [["'TempCode Local CA'", 'a certificate trusted by name']],
  'src/main/server/threadResourcesRemove.ts': [["new Set(['TempCode', 'temp-code'])", 'userData folder names']],
  'src/main/server/remote/macBridge.ts': [
    ["'Library/Application Support/TempCode'", 'a data folder'],
    ["'AppData/Local/TempCode'", 'a data folder']
  ],
  'src/main/server/addons/grantProbe.ts': [["clientInfo: { name: 'TempCode'", 'the MCP client name servers have seen (row 56)']],
  'src/main/server/addons/oauthFlow.ts': [
    ["clientInfo: { name: 'TempCode'", 'the MCP client name servers have seen (row 56)'],
    ["client_name: 'TempCode'", 'the registered OAuth client (row 56)']
  ],
  'src/main/server/work/lifeos/session.ts': [['`TempCode on ', 'a device LifeOS has registered (row 42)']],
  'src/main/server/work/lifeos/keys.ts': [['`TempCode ${hostName}', 'key names LifeOS holds and revokes by (row 42)']],
  'src/main/server/work/frameio/hooks.ts': [["name: 'TempCode'", 'the webhook Frame.io holds']],
  'src/main/server/work/office/mac.ts': [["'Caches', 'TempCode')", 'a folder in Office containers']],
  'src/main/server/work/office/addin/web.ts': [['TempCode\\/\\S+', 'the user agent the app sends']],
  'src/main/server/work/office/com/source.ts': [["TempCode's Office helper", 'a comment inside the C# source']],
  'src/main/server/work/files/word.ts': [['(before TempCode saved it)', 'backups already on disk carry this name']],
  'src/main/server/work/winvm/door.ts': [['AppData\\\\Local\\\\TempCode', 'a folder in the guest']],
  'src/main/server/work/winvm/setup.ts': [
    ['Program Files\\\\TempCode', 'a folder in the guest'],
    ['ProgramData\\\\TempCode', 'a folder in the guest'],
    ["'\\\\TempCode'", 'the scheduled task folder'],
    ["'TempCode: the service", 'a task Windows lists (row 43)']
  ],
  'src/main/server/work/winvm/helperDoor.ts': [["'TempCode: the Office", 'a task Windows lists (row 43)']],
  'ios/TempCode/Sources/Shell/InboxStore.swift': [['"TempCode/inbox"', 'a folder in the app group']],
  'ios/TempCode/Sources/Work/Items/LivePicture.swift': [['for TempCode in System Settings', 'the Mac lists its bundle name under Screen Recording']]
}

const root = join(__dirname, '../..')
const ROOTS = ['src/main', 'src/shared', 'src/preload', 'src/renderer/src', 'src/hosted', 'ios']
const SKIP = /\.test\.|\.preview\.|fixture|\/proof\/|\/Generated\/|Tests\//

function files(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.(ts|tsx|swift)$/.test(e.name))
    .map((e) => relative(root, join(e.parentPath, e.name)))
    .filter((f) => !SKIP.test(f))
}

/** Lines that say TempCode outside a comment: a Swift line only where it sits in a string. */
function shown(file: string): string[] {
  const swift = file.endsWith('.swift')
  return readFileSync(join(root, file), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && (swift ? /"[^"]*\bTempCode\b[^"]*"/ : /\bTempCode\b/).test(line))
}

describe('the shown name', () => {
  const found = new Map(ROOTS.flatMap(files).map((f) => [f, shown(f)] as const).filter(([, lines]) => lines.length))

  it('says Docket everywhere but the held names', () => {
    const loose = [...found].flatMap(([file, lines]) => lines.filter((line) => !(HELD[file] ?? []).some(([text]) => line.includes(text))).map((line) => `${file}: ${line.trim()}`))
    expect(loose).toEqual([])
  })

  it('holds nothing that is gone', () => {
    const stale = Object.entries(HELD).flatMap(([file, held]) => held.filter(([text]) => !(found.get(file) ?? []).some((line) => line.includes(text))).map(([text]) => `${file}: ${text}`))
    expect(stale).toEqual([])
  })
})
