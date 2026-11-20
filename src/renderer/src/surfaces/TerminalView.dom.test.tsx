import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ANSI, MINIMUM_CONTRAST } from '../lib/terminalPalette'
import { hexOf, oscColors, statusPollAllowed, terminalScheme, terminalTheme } from './TerminalView'

// What the tokens compute to in each scheme (index.css), keyed by the expression the probe asks for.
const TOKENS = {
  dark: { 'var(--color-foreground)': 'rgb(231, 232, 234)', 'var(--color-accent)': 'rgb(69, 155, 247)', 'var(--color-background)': 'rgb(20, 21, 22)' },
  light: { 'var(--color-foreground)': 'rgb(19, 22, 28)', 'var(--color-accent)': 'rgb(13, 99, 211)', 'var(--color-background)': 'rgb(255, 255, 255)' }
} as const

function computeTokens(scheme: keyof typeof TOKENS) {
  const real = window.getComputedStyle
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => {
    const asked = (el as HTMLElement).style.getPropertyValue('color') as keyof (typeof TOKENS)['dark']
    return { ...real(el), color: TOKENS[scheme][asked] ?? '' } as CSSStyleDeclaration
  })
}

afterEach(() => vi.restoreAllMocks())

describe('the terminal chrome reads the tokens', () => {
  it.each(['dark', 'light'] as const)('answers OSC queries with the theme’s text and cursor and the content background (%s)', (scheme) => {
    computeTokens(scheme)
    const light = scheme === 'light'
    const theme = terminalTheme(light)
    const osc = oscColors(light)
    expect(theme.foreground).toBe(TOKENS[scheme]['var(--color-foreground)'])
    expect(osc.fg).toBe(hexOf(theme.foreground, ''))
    expect(osc.cursor).toBe(hexOf(theme.cursor, ''))
    expect(osc.fg).toBe(light ? '#13161c' : '#e7e8ea')
    expect(osc.bg).toBe(light ? '#ffffff' : '#141516')
  })

  it('in light tells xterm the pane’s own colour at zero alpha, so reverse video and the contrast floor start from what is on screen', () => {
    computeTokens('light')
    const theme = terminalTheme(true)
    expect(theme.background).toBe('#ffffff00')
    // The bar cursor's cut-out and a selection come from the same two colours.
    expect(theme.cursorAccent).toBe('#ffffff')
    expect(theme.selectionBackground).toBe('#13161c2e')
    expect(theme.selectionInactiveBackground).toBe('#13161c14')
  })

  it('in dark keeps the four values it always had', () => {
    computeTokens('dark')
    const theme = terminalTheme(false)
    expect({ background: theme.background, cursorAccent: theme.cursorAccent, selectionBackground: theme.selectionBackground, selectionInactiveBackground: theme.selectionInactiveBackground }).toEqual({
      background: '#00000000',
      cursorAccent: '#000000',
      selectionBackground: 'rgba(255,255,255,0.18)',
      selectionInactiveBackground: 'rgba(255,255,255,0.08)'
    })
  })

  it('carries the sixteen ANSI colours of the theme, with light’s whites as grays', () => {
    computeTokens('light')
    const light = terminalTheme(true)
    for (const [name, colour] of Object.entries(ANSI.light)) expect(light[name as keyof typeof ANSI.light]).toBe(colour)
    expect(terminalTheme(false).red).toBe(ANSI.dark.red)
    expect(Object.keys(ANSI.light)).toHaveLength(16)
    expect([ANSI.light.white, ANSI.light.brightWhite]).not.toContain('#ffffff')
  })

  it('holds a program’s own colours to 4.5:1 on the light pane, in the shell and in the Dev Console, and leaves dark as it was', () => {
    expect(MINIMUM_CONTRAST).toEqual({ dark: 1, light: 4.5 })
    computeTokens('light')
    expect(terminalScheme(true)).toEqual({ theme: terminalTheme(true), minimumContrastRatio: 4.5 })
    expect(terminalScheme(false).minimumContrastRatio).toBe(1)
    // Both terminals take the scheme's pair when they are built and again on every change.
    for (const file of ['TerminalView.tsx', 'DevConsole.tsx']) {
      const source = readFileSync(join(__dirname, file), 'utf8')
      expect(source, file).toMatch(/new Terminal\(\{[^}]*\.\.\.terminalScheme\(\)/)
      expect(source, file).toContain('Object.assign(term.options, terminalScheme())')
    }
  })

  it('turns rgb and hex into #rrggbb, and anything unreadable into the fallback', () => {
    expect(hexOf('rgb(10, 119, 235)', '#000000')).toBe('#0a77eb')
    expect(hexOf('#ABCDEF', '#000000')).toBe('#abcdef')
    expect(hexOf('', '#123456')).toBe('#123456')
  })
})

describe('the status poll', () => {
  it('polls only for the shown terminal of a shown pane while the document is visible', () => {
    expect(statusPollAllowed(true, true, false)).toBe(true)
    // A parked warm pane is not hidden from the browser: it polls nothing.
    expect(statusPollAllowed(true, false, false)).toBe(false)
    // Another terminal tab of the dock, or a hidden window, polls nothing.
    expect(statusPollAllowed(false, true, false)).toBe(false)
    expect(statusPollAllowed(true, true, true)).toBe(false)
  })
})
