import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app, BrowserWindow, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { hostProfileRunning, profileHost } from './server/doctorProfile'
import { buildMenu } from './menu'

vi.mock('electron', () => ({
  app: { quit: vi.fn(), getPath: vi.fn(), on: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn() },
  ipcMain: { on: vi.fn() },
  globalShortcut: { isRegistered: vi.fn(), register: vi.fn(), unregister: vi.fn() },
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn() }
}))
vi.mock('./windows', () => ({ createWindow: vi.fn() }))
vi.mock('./server/doctorProfile', () => ({ hostProfileRunning: vi.fn(), profileHost: vi.fn() }))

function template(): MenuItemConstructorOptions[] {
  buildMenu()
  return vi.mocked(Menu.buildFromTemplate).mock.calls.at(-1)![0] as MenuItemConstructorOptions[]
}

function menu(label: string): MenuItemConstructorOptions[] {
  return template().find((section) => section.label === label)!.submenu as MenuItemConstructorOptions[]
}

function clickProfile(): void {
  const item = menu('Help').find((row) => row.id === 'profile_host')!
  expect(item.label).toBe('Profile the Host for 10 Seconds')
  ;(item.click as () => void)()
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(hostProfileRunning).mockReturnValue(false)
})

describe('host profile menu', () => {
  it('calls the shared profiler and reveals the file after it finishes', async () => {
    let finish!: (result: Awaited<ReturnType<typeof profileHost>>) => void
    vi.mocked(profileHost).mockReturnValue(new Promise((resolve) => { finish = resolve }))
    clickProfile()
    expect(profileHost).toHaveBeenCalledWith({ seconds: 10 })
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
    finish({ path: '/tmp/host.cpuprofile', bytes: 123, seconds: 10, samples: 10 })
    await vi.waitFor(() => expect(shell.showItemInFolder).toHaveBeenCalledWith('/tmp/host.cpuprofile'))
    expect(BrowserWindow.getFocusedWindow).not.toHaveBeenCalled()
  })

  it('ignores a click while a profile is running', () => {
    vi.mocked(hostProfileRunning).mockReturnValue(true)
    clickProfile()
    expect(profileHost).not.toHaveBeenCalled()
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
  })

  it('logs one doctor line on error', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      vi.mocked(profileHost).mockRejectedValue(new Error('capture\nfailed'))
      clickProfile()
      await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1))
      expect(log).toHaveBeenCalledWith('[doctor] Error: capture failed')
      expect(shell.showItemInFolder).not.toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
  })
})

describe('menu template', () => {
  it('carries the Focus Pane submenu with its items', () => {
    const focus = menu('View').find((row) => row.label === 'Focus Pane')!
    const rows = focus.submenu as MenuItemConstructorOptions[]
    expect(rows.map((r) => [r.id, r.label, r.accelerator])).toEqual([
      ['focus_left', 'Left', 'CmdOrCtrl+Alt+Left'],
      ['focus_right', 'Right', 'CmdOrCtrl+Alt+Right'],
      ['focus_up', 'Up', 'CmdOrCtrl+Alt+Up'],
      ['focus_down', 'Down', 'CmdOrCtrl+Alt+Down']
    ])
  })

  it('passes the role overrides', () => {
    expect(menu('File').find((r) => r.role === 'close')).toEqual({ role: 'close', label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W' })
    expect(menu('View').find((r) => r.role === 'reload')).toEqual({ role: 'reload', label: 'Reload Window' })
    expect(menu('Help').find((r) => r.role === 'toggleDevTools')).toEqual({ role: 'toggleDevTools', label: 'Developer Tools', accelerator: 'Alt+CmdOrCtrl+I' })
    expect(menu('Edit').find((r) => r.role === 'undo')).toEqual({ role: 'undo' })
  })

  it('shows New Terminal\'s key without registering it', () => {
    const item = menu('File').find((r) => r.id === 'new_terminal')!
    expect(item.accelerator).toBe('Ctrl+`')
    expect(item.registerAccelerator).toBe(false)
    expect(menu('File').find((r) => r.id === 'new_tab')!.registerAccelerator).toBeUndefined()
  })

  it('leaves New Terminal\'s key to the page on macOS too, where the key still reaches the menu', () => {
    const send = vi.fn()
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue({ isDestroyed: () => false, webContents: { send } } as never)
    const click = menu('File').find((r) => r.id === 'new_terminal')!.click as (...args: unknown[]) => void
    click({}, undefined, { triggeredByAccelerator: true, ctrlKey: true })
    expect(send).not.toHaveBeenCalled()
    click({}, undefined, { triggeredByAccelerator: false })
    expect(send).toHaveBeenCalledTimes(1)
    // Return on the item while navigating the menu by keyboard.
    click({}, undefined, { triggeredByAccelerator: true, ctrlKey: false })
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith('native:menu', 'new_terminal')
  })
})

describe('show logs', () => {
  it('opens the logs directory, making it first', () => {
    const userData = mkdtempSync(join(tmpdir(), 'menu-logs-'))
    vi.mocked(app.getPath).mockReturnValue(userData)
    const item = menu('Help').find((row) => row.id === 'show_logs')!
    expect(item.label).toBe('Show Logs')
    ;(item.click as () => void)()
    expect(existsSync(join(userData, 'logs'))).toBe(true)
    expect(shell.openPath).toHaveBeenCalledWith(join(userData, 'logs'))
    expect(BrowserWindow.getFocusedWindow).not.toHaveBeenCalled()
  })
})

describe('force reload', () => {
  it('reloads the focused window past its cache, in main', () => {
    const reloadIgnoringCache = vi.fn()
    const send = vi.fn()
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue({ isDestroyed: () => false, webContents: { reloadIgnoringCache, send } } as never)
    const item = menu('View').find((row) => row.id === 'force_reload')!
    expect(item.label).toBe('Force Reload')
    expect(item.accelerator).toBeUndefined()
    ;(item.click as () => void)()
    expect(reloadIgnoringCache).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('menu state', () => {
  type Contents = { id: number; once: (event: string, cb: () => void) => void; destroy: () => void }
  function contents(id: number): Contents {
    let onDestroyed = (): void => {}
    return { id, once: (_event, cb) => { onDestroyed = cb }, destroy: () => onDestroyed() }
  }
  const windowOf = (c: Contents) => ({ webContents: c, isDestroyed: () => false }) as unknown as BrowserWindow
  const row = (section: string, id: string): MenuItemConstructorOptions => {
    const last = vi.mocked(Menu.buildFromTemplate).mock.calls.at(-1)![0] as MenuItemConstructorOptions[]
    const items = last.find((s) => s.label === section)!.submenu as MenuItemConstructorOptions[]
    return items.find((r) => r.id === id)!
  }
  let menuModule: typeof import('./menu')

  beforeEach(async () => {
    vi.resetModules()
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(null)
    vi.mocked(Menu.buildFromTemplate).mockReturnValue({} as Menu)
    menuModule = await import('./menu')
    menuModule.registerMenu()
  })

  it('takes the focused window\'s state: Hide Sidebar, Pause All greyed', () => {
    const c = contents(1)
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(windowOf(c))
    expect(row('View', 'toggle_sidebar').label).toBe('Show Sidebar')
    menuModule.receiveMenuState(c as never, { open: ['toggle_sidebar'], disabled: ['pause_all_threads'] })
    expect(row('View', 'toggle_sidebar').label).toBe('Hide Sidebar')
    expect(row('Threads', 'pause_all_threads').enabled).toBe(false)
    expect(row('Threads', 'stop_all_threads').enabled).toBeUndefined()
    expect(Menu.setApplicationMenu).toHaveBeenCalledTimes(2)
  })

  it('holds a blurred window\'s state until that window is focused', () => {
    const front = contents(1)
    const back = contents(2)
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(windowOf(front))
    menuModule.receiveMenuState(back as never, { open: ['toggle_terminal'], disabled: [] })
    expect(Menu.setApplicationMenu).toHaveBeenCalledTimes(1)
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(windowOf(back))
    const calls = vi.mocked(app.on).mock.calls as unknown as [string, () => void][]
    const onFocus = calls.find(([event]) => event === 'browser-window-focus')![1]
    onFocus()
    expect(row('View', 'toggle_terminal').label).toBe('Hide Terminal')
  })

  it('builds Away from Computer as a checkbox, ticked as the window says', () => {
    const c = contents(1)
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(windowOf(c))
    expect(row('Threads', 'toggle_away')).toMatchObject({ type: 'checkbox', checked: false, label: 'Away from Computer' })
    menuModule.receiveMenuState(c as never, { open: [], disabled: [], checked: { toggle_away: true, junk: 'yes' } })
    expect(row('Threads', 'toggle_away')).toMatchObject({ type: 'checkbox', checked: true })
    expect(row('Threads', 'mark_all_read').type).toBeUndefined()
    menuModule.receiveMenuState(c as never, { open: [], disabled: [], checked: { toggle_away: false } })
    expect(row('Threads', 'toggle_away').checked).toBe(false)
  })

  it('does not rebuild for a state it already shows', () => {
    const c = contents(1)
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(windowOf(c))
    menuModule.receiveMenuState(c as never, { open: ['toggle_panel'], disabled: [] })
    menuModule.receiveMenuState(c as never, { open: ['toggle_panel'], disabled: [] })
    menuModule.applyFocusedMenu()
    expect(Menu.setApplicationMenu).toHaveBeenCalledTimes(2)
  })

  it('while the window is editing, drops the keys the editor took, gives Print… ⌘P as the page\'s, and rebuilds when the caret leaves', () => {
    const c = contents(1)
    const send = vi.fn()
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue({ webContents: Object.assign(c, { send }), isDestroyed: () => false } as unknown as BrowserWindow)
    expect(row('View', 'toggle_sidebar').accelerator).toBe('CmdOrCtrl+B')
    expect(row('Go', 'go_to_file').accelerator).toBe('CmdOrCtrl+P')
    expect(row('File', 'print').accelerator).toBeUndefined()
    expect(row('File', 'export').accelerator).toBe('CmdOrCtrl+Shift+E')

    menuModule.receiveMenuState(c as never, { open: [], disabled: [], editing: ['toggle_sidebar', 'open_search', 'go_to_file', 'find', 'quit', 7] })
    expect(Menu.setApplicationMenu).toHaveBeenCalledTimes(2)
    for (const [section, id] of [['View', 'toggle_sidebar'], ['Go', 'open_search'], ['Go', 'go_to_file'], ['Edit', 'find']] as const) expect(row(section, id).accelerator, id).toBeUndefined()
    // an id that is no editor key is not taken at a window's word: Quit keeps ⌘Q
    expect(row('TempCode', 'quit').accelerator).toBe('CmdOrCtrl+Q')
    expect(row('Edit', 'find_in_project').accelerator).toBe('CmdOrCtrl+Shift+F')
    const print = row('File', 'print')
    expect(print).toMatchObject({ accelerator: 'CmdOrCtrl+P', registerAccelerator: false })
    // On macOS the key still reaches the menu: the page ran it, so the menu's own click by ⌘P or Ctrl+P is dropped; a press on the row runs.
    const click = print.click as (...args: unknown[]) => void
    click({}, undefined, { triggeredByAccelerator: true, metaKey: true })
    click({}, undefined, { triggeredByAccelerator: true, ctrlKey: true })
    expect(send).not.toHaveBeenCalled()
    click({}, undefined, { triggeredByAccelerator: false })
    expect(send).toHaveBeenLastCalledWith('native:menu', 'print')

    menuModule.receiveMenuState(c as never, { open: [], disabled: [] })
    expect(Menu.setApplicationMenu).toHaveBeenCalledTimes(3)
    expect(row('View', 'toggle_sidebar').accelerator).toBe('CmdOrCtrl+B')
    expect(row('File', 'print').accelerator).toBeUndefined()
  })

  it('leaves Work\'s own rows out for a window that hides them, and hides no other row at a window\'s word', () => {
    const c = contents(1)
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(windowOf(c))
    const go = (): (string | undefined)[] => {
      const last = vi.mocked(Menu.buildFromTemplate).mock.calls.at(-1)![0] as MenuItemConstructorOptions[]
      return (last.find((s) => s.label === 'Go')!.submenu as MenuItemConstructorOptions[]).map((r) => r.id)
    }
    // Before any window has reported, no window is there to open Today in: the row is left out.
    expect(go()).not.toContain('open_today')
    menuModule.receiveMenuState(c as never, { open: [], disabled: [] })
    expect(go()).toContain('open_today')
    menuModule.receiveMenuState(c as never, { open: [], disabled: [], hidden: ['open_today', 'open_search', 3] })
    expect(go()).not.toContain('open_today')
    expect(go()).toContain('open_search')
    // Work came on: the row is drawn, and reads Close Today while the page is open
    menuModule.receiveMenuState(c as never, { open: ['open_today'], disabled: [] })
    expect(row('Go', 'open_today').label).toBe('Close Today')
  })

  it('goes back to the rows that need no window when the focused one loses the focus to none of ours', () => {
    vi.useFakeTimers()
    try {
      const c = contents(1)
      vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(windowOf(c))
      menuModule.receiveMenuState(c as never, { open: ['open_today'], disabled: [] })
      expect(row('Go', 'open_today').label).toBe('Close Today')
      // Minimized: no window of ours has the focus a turn later.
      vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(null)
      const calls = vi.mocked(app.on).mock.calls as unknown as [string, () => void][]
      calls.find(([event]) => event === 'browser-window-blur')![1]()
      vi.runAllTimers()
      const last = vi.mocked(Menu.buildFromTemplate).mock.calls.at(-1)![0] as MenuItemConstructorOptions[]
      expect((last.find((s) => s.label === 'Go')!.submenu as MenuItemConstructorOptions[]).map((r) => r.id)).not.toContain('open_today')
    } finally {
      vi.useRealTimers()
    }
  })

  it('goes back to the plain menu when the window closes', () => {
    const c = contents(1)
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(windowOf(c))
    menuModule.receiveMenuState(c as never, { open: ['toggle_sidebar'], disabled: [] })
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(null)
    c.destroy()
    expect(row('View', 'toggle_sidebar').label).toBe('Show Sidebar')
  })

  it('listens on menu:state', () => {
    expect(vi.mocked(ipcMain.on).mock.calls.map(([channel]) => channel)).toContain('menu:state')
  })
})
