import { parseArgs } from 'node:util'

export const PASSES = ['owner', 'device', 'read'] as const
export type Pass = typeof PASSES[number]
export const THEMES = ['dark', 'light'] as const
export type Theme = typeof THEMES[number]
export const SIZES = [
  { width: 1440, height: 900, name: 'wide' },
  { width: 1000, height: 700, name: 'mid' },
  { width: 800, height: 520, name: 'narrow' }
] as const
export type Size = typeof SIZES[number]['name']

function selection<T extends string>(value: string | undefined, choices: readonly T[], all: string, option: string): readonly T[] {
  if (value === undefined || value === all) return choices
  const choice = choices.find(item => item === value)
  if (choice) return [choice]
  throw new Error(`--${option} takes ${[...choices, all].join('|')}`)
}

export function walkOptions(args: string[], scenes: readonly string[]) {
  const { values } = parseArgs({
    args,
    options: { out: { type: 'string' }, only: { type: 'string' }, pass: { type: 'string' }, theme: { type: 'string' } }
  })
  if (values.out === '') throw new Error('--out needs a directory')
  const only = values.only?.split(',').map(value => value.trim())
  const selected = new Set<string>()
  for (const choice of only ?? []) {
    const scene = scenes.find(name => name === choice || name.slice(3) === choice)
    if (!scene) throw new Error(`Unknown scene: ${choice}`)
    selected.add(scene)
  }
  return {
    out: values.out,
    only: selected,
    passes: selection(values.pass, PASSES, 'all', 'pass'),
    themes: selection(values.theme, THEMES, 'both', 'theme')
  }
}

export function pictureName(pass: Pass, theme: Theme, scene: string, size: Size, failed = false): string {
  return `${pass}-${theme}-${scene}-${size}${failed ? '-FAILED' : ''}.png`
}
