import { ElectronAPI } from '@electron-toolkit/preload'
import type { LiveOfficeApi, ShowApi, TempCodeApi } from './index'
import type { AliaxApi } from './aliax'

declare global {
  interface Window {
    electron: ElectronAPI
    api: TempCodeApi
    /** The Aliax pages' bridge (see src/preload/aliax.ts). */
    aliax: AliaxApi
    /** A show's windows (src/main/present.ts); absent in a browser. */
    tcShow?: ShowApi
    /** A live Office file's ticket (src/main/officeLive.ts); absent in a browser. */
    tcLive?: LiveOfficeApi
  }
}
