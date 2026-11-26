import { describe, expect, it } from 'vitest'
import { repoKey } from './repoKey'

describe('repoKey', () => {
  it('takes the old and new slug of the renamed repo as one, in any case', () => {
    expect(repoKey('LandonDev/temp-code')).toBe('landondev/docket')
    expect(repoKey(' landondev/TEMP-CODE ')).toBe('landondev/docket')
    expect(repoKey('LandonDev/docket')).toBe('landondev/docket')
  })

  it('keeps every other repo as it is, lowercased, and none as null', () => {
    expect(repoKey('LandonDev/LifeOS')).toBe('landondev/lifeos')
    expect(repoKey('someone/temp-code')).toBe('someone/temp-code')
    expect(repoKey('  ')).toBeNull()
    expect(repoKey(null)).toBeNull()
  })
})
