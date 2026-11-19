import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ANSI, TERMINAL_OPTIONS } from '../lib/terminalPalette'
import { hexOf, oscColors, statusPollAllowed, terminalTheme } from './TerminalView'

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

  it.each(['dark', 'light'] as const)('tells xterm the pane’s own colour at zero alpha, so reverse video and the contrast floor start from what is on screen (%s)', (scheme) => {
    computeTokens(scheme)
    const light = scheme === 'light'
    const theme = terminalTheme(light)
    const ground = light ? '#ffffff' : '#141516'
    expect(theme.background).toBe(`${ground}00`)
    // The bar cursor's cut-out and a selection come from the same two colours.
    expect(theme.cursorAccent).toBe(ground)
    expect(theme.selectionBackground).toBe(`${light ? '#13161c' : '#e7e8ea'}2e`)
    expect(theme.selectionInactiveBackground).toBe(`${light ? '#13161c' : '#e7e8ea'}14`)
  })

  it('carries the sixteen ANSI colours of the theme, with light’s whites as grays', () => {
    computeTokens('light')
    const light = terminalTheme(true)
    for (const [name, colour] of Object.entries(ANSI.light)) expect(light[name as keyof typeof ANSI.light]).toBe(colour)
    expect(terminalTheme(false).red).toBe(ANSI.dark.red)
    expect(Object.keys(ANSI.light)).toHaveLength(16)
    expect([ANSI.light.white, ANSI.light.brightWhite]).not.toContain('#ffffff')
  })

  it('holds a program’s own colours to 4.5:1 in the shell and in the Dev Console', () => {
    expect(TERMINAL_OPTIONS).toEqual({ allowTransparency: true, minimumContrastRatio: 4.5, smoothScrollDuration: 0 })
    for (const file of ['TerminalView.tsx', 'DevConsole.tsx'])
      expect(readFileSync(join(__dirname, file), 'utf8'), file).toMatch(/new Terminal\(\{[^}]*\.\.\.TERMINAL_OPTIONS/)
  })

  it('takes its three scrollbar slider colours from the scrollbar tokens', () => {
    const real = window.getComputedStyle
    const computed: Record<string, string> = {
      'var(--scrollbar-thumb)': 'rgba(237, 237, 237, 0.2)',
      'var(--scrollbar-thumb-hover)': 'rgba(237, 237, 237, 0.32)',
      'var(--scrollbar-thumb-active)': 'rgba(237, 237, 237, 0.4)'
    }
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => {
      const asked = (el as HTMLElement).style.getPropertyValue('color')
      return { ...real(el), color: computed[asked] ?? '' } as CSSStyleDeclaration
    })
    const theme = terminalTheme(false)
    expect(theme.scrollbarSliderBackground).toBe(computed['var(--scrollbar-thumb)'])
    expect(theme.scrollbarSliderHoverBackground).toBe(computed['var(--scrollbar-thumb-hover)'])
    expect(theme.scrollbarSliderActiveBackground).toBe(computed['var(--scrollbar-thumb-active)'])
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
