import { describe, expect, it } from 'vitest'
import { POP_OUT_FRAME, popOutCreated, windowOpenHandler } from './popOut'

describe('the pop-out window', () => {
  it('lets the page open its pop-out as a floating child with none of the main window\'s preload or slot', () => {
    const external: string[] = []
    const answer = windowOpenHandler({ url: 'about:blank', frameName: POP_OUT_FRAME }, (url) => external.push(url))
    expect(answer.action).toBe('allow')
    const options = answer.action === 'allow' ? answer.overrideBrowserWindowOptions! : {}
    expect(options).toMatchObject({ frame: false, show: false, alwaysOnTop: true, skipTaskbar: true })
    expect(options.webPreferences).toEqual({ preload: undefined, additionalArguments: [], backgroundThrottling: false })
    expect(external).toEqual([])
  })

  it('sends every other window.open to the system\'s browser and opens nothing', () => {
    const external: string[] = []
    expect(windowOpenHandler({ url: 'https://example.test/', frameName: '' }, (url) => external.push(url))).toEqual({ action: 'deny' })
    // the frame name alone is not enough: the pop-out is always an empty page the main window fills
    expect(windowOpenHandler({ url: 'https://example.test/', frameName: POP_OUT_FRAME }, (url) => external.push(url))).toEqual({ action: 'deny' })
    expect(windowOpenHandler({ url: 'about:blank', frameName: 'other' }, (url) => external.push(url))).toEqual({ action: 'deny' })
    expect(external).toEqual(['https://example.test/', 'https://example.test/', 'about:blank'])
  })

  it('floats over every app and every Space, and shows without taking the keyboard', () => {
    const did: string[] = []
    popOutCreated({
      setAlwaysOnTop: (on, level) => void did.push(`top ${on} ${level}`),
      setVisibleOnAllWorkspaces: (on, o) => void did.push(`spaces ${on} ${o.visibleOnFullScreen}`),
      showInactive: () => void did.push('showInactive')
    })
    expect(did).toEqual(['top true floating', 'spaces true true', 'showInactive'])
  })
})
