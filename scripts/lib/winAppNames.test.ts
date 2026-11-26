import { describe, expect, it } from 'vitest'
import { APP_PROCESSES, appExeCandidates, appOf, findAppExePs } from './winAppNames'

const LOCAL = 'C:\\Users\\tcuser\\AppData\\Local'

describe('the app on a PC under either name', () => {
  it('looks for a fresh Docket install first, then an updated TempCode folder, then an old install', () => {
    expect(appExeCandidates(LOCAL)).toEqual([
      `${LOCAL}\\Programs\\Docket\\Docket.exe`,
      `${LOCAL}\\Programs\\Docket\\TempCode.exe`,
      `${LOCAL}\\Programs\\TempCode\\Docket.exe`,
      `${LOCAL}\\Programs\\TempCode\\TempCode.exe`
    ])
    expect(findAppExePs(LOCAL)).toMatch(/^'C:\\Users\\tcuser\\AppData\\Local\\Programs\\Docket\\Docket\.exe',.* \| Where-Object \{ Test-Path \$_ \} \| Select-Object -First 1$/)
  })

  it('stops the app by both process names', () => {
    expect(APP_PROCESSES).toBe('Docket,TempCode')
  })

  it('reads the folder and the shortcut name off a found exe', () => {
    expect(appOf(`${LOCAL}\\Programs\\TempCode\\Docket.exe`)).toEqual({ dir: `${LOCAL}\\Programs\\TempCode`, exe: `${LOCAL}\\Programs\\TempCode\\Docket.exe`, name: 'Docket' })
  })
})
