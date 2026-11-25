// The desktop viewer's page in a real Chromium for scripts/e2e-video-viewer.ts: an Electron window, inert (an
// accessory app, never focusable, shown without being made key), that loads the page the proof serves. It writes
// each of the page's console lines to stdout as `PAGE <json>` and the screen's rate as `SCREEN <hz>`, takes
// `eval <script>` and `quit` on stdin, and keeps its data under TC_VIEWER_DATA, never the app's.
const { app, BrowserWindow, screen } = require('electron')

app.setPath('userData', process.env.TC_VIEWER_DATA)
// a covered or background window must keep its frame clock: the proof judges the worker, not the window's place
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.setActivationPolicy('accessory')
  app.dock?.hide()
  const win = new BrowserWindow({
    width: 1320, height: 900, x: 60, y: 60, show: false, focusable: false, skipTaskbar: true,
    title: 'TC video viewer proof',
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true }
  })
  win.webContents.on('console-message', (event) => process.stdout.write(`PAGE ${event.message}\n`))
  win.webContents.on('render-process-gone', (_e, details) => process.stdout.write(`GONE ${JSON.stringify(details)}\n`))
  win.once('ready-to-show', () => {
    win.showInactive()
    const display = screen.getDisplayMatching(win.getBounds())
    process.stdout.write(`SCREEN ${display.displayFrequency}\n`)
  })
  win.loadURL(process.env.TC_VIEWER_PAGE)
  let input = ''
  // A series of timestamped Chromium mouse samples for the isolated Linux proof.
  let motion
  win.on('closed', () => clearInterval(motion))
  const movePointer = () => {
    win.webContents.debugger.attach('1.3')
    let x = 24
    motion = setInterval(() => {
      x = x < 600 ? x + 1 : 24
      const timestamp = (performance.timeOrigin + performance.now()) / 1000
      void win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: 50, timestamp }).catch(() => {})
    }, 11)
  }
  process.stdin.on('data', (chunk) => {
    input += chunk
    for (let at = input.indexOf('\n'); at >= 0; at = input.indexOf('\n')) {
      const line = input.slice(0, at).trim()
      input = input.slice(at + 1)
      if (line === 'quit') app.quit()
      else if (line === 'motion' && process.env.TC_VIEWER_MOTION === '1' && !motion) movePointer()
      else if (line.startsWith('eval ')) win.webContents.executeJavaScript(line.slice(5))
    }
  })
})
app.on('window-all-closed', () => app.quit())
