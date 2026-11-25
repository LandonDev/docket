import { contextBridge } from 'electron'
import { refusePasskeys } from '../shared/work/livePasskey'

/**
 * A live Office guest's one preload (src/main/officeLive.ts `liveSession` registers it on each live session): before
 * Microsoft's scripts run, a passkey ask in the page refuses at once. It exposes nothing and holds no IPC.
 */
contextBridge.executeInMainWorld({ func: refusePasskeys })
