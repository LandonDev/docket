import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { declarations, resolve, themes } from '../../renderer/src/lib/colourMath'

/**
 * The published form is a page of its own with a copy of the app's palette,
 * light by default and dark by the filler's system. Every value it declares
 * is the app's value for that token in that theme.
 */
const here = dirname(__filename)
const app = themes(readFileSync(join(here, '../../renderer/src/index.css'), 'utf8'))
const [lightCss, darkCss] = readFileSync(join(here, 'form.css'), 'utf8').split('@media (prefers-color-scheme: dark)')
const form = { light: declarations(lightCss, ':root'), dark: declarations(darkCss, ':root') }

describe("the form page's palette", () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`equals the app's ${theme} tokens`, () => {
      const colours = [...form[theme]].filter(([name]) => !/^--(dur|ease)-/.test(name))
      expect(colours.length).toBeGreaterThanOrEqual(10)
      for (const [name, value] of colours) expect([name, value]).toEqual([name, resolve(app[theme], `var(${name})`)])
    })
  }

  it('declares the same names in both themes, and moves on the app\'s motion tokens', () => {
    const motion = [...form.light].filter(([name]) => /^--(dur|ease)-/.test(name))
    expect([...form.dark.keys()].sort()).toEqual([...form.light.keys()].filter((name) => !/^--(dur|ease)-/.test(name)).sort())
    for (const [name, value] of motion) expect([name, value]).toEqual([name, app.light.get(name)])
  })
})
