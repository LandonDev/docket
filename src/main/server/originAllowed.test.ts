import { describe, expect, it } from 'vitest'
import { originAllowed } from './originAllowed'

describe('originAllowed', () => {
  it('lets in a client with no Origin, the app, and the dev renderer while one is set', () => {
    expect(originAllowed(undefined, undefined)).toBe(true)
    expect(originAllowed('tempcode-app://renderer', undefined)).toBe(true)
    expect(originAllowed('http://localhost:5173', 'http://localhost:5173/')).toBe(true)
    expect(originAllowed('http://localhost:5177', 'http://localhost:5177')).toBe(true)
  })

  it('refuses every other page', () => {
    for (const origin of ['null', 'https://purdue0.sharepoint.com', 'https://login.microsoftonline.com', 'http://localhost:5173', 'http://127.0.0.1:5173', 'file://', 'tempcode-app://other', ''])
      expect(originAllowed(origin, undefined)).toBe(false)
    expect(originAllowed('http://127.0.0.1:5173', 'http://localhost:5173/')).toBe(false)
    expect(originAllowed(['tempcode-app://renderer', 'tempcode-app://renderer'], undefined)).toBe(false)
  })
})
