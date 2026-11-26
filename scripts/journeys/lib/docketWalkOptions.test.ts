import { describe, expect, it } from 'vitest'
import { pictureName, SIZES, walkOptions } from './docketWalkOptions'

describe('Docket walk options', () => {
  const scenes = ['01-start', '06-approval']
  it('walks all keys and themes by default in the three supported sizes', () => {
    expect(walkOptions([], scenes)).toEqual({
      out: undefined, only: new Set(), passes: ['owner', 'device', 'read'], themes: ['dark', 'light']
    })
    expect(SIZES.map(({ width, height }) => [width, height])).toEqual([[1440, 900], [1000, 700], [800, 520]])
  })

  it('accepts scene names with or without their number and deduplicates them', () => {
    expect(walkOptions(['--theme', 'light', '--pass', 'read', '--out', './pics', '--only', 'start, 06-approval,start'], scenes)).toEqual({
      out: './pics', only: new Set(scenes), passes: ['read'], themes: ['light']
    })
  })

  it.each([['--pass', 'admin'], ['--theme', 'auto'], ['--only', 'missing'], ['--out', ''], ['extra']])('rejects %s %s before starting an instance', (...args) => {
    expect(() => walkOptions(args, scenes)).toThrow()
  })

  it('names normal and failed pictures after the pass, theme, scene and size', () => {
    expect(pictureName('device', 'dark', '06-approval', 'mid')).toBe('device-dark-06-approval-mid.png')
    expect(pictureName('read', 'light', '06-approval', 'narrow', true)).toBe('read-light-06-approval-narrow-FAILED.png')
  })
})
