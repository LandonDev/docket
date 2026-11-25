import { describe, expect, it } from 'vitest'
import { lastEditorOption, microsoftDisplayName } from './lastEditor'

/** His name as a Word file's last editor (lastEditor.ts): given only where the pin takes it and the name is known. */
describe('the last editor a Word file names', () => {
  const taking = { lastEditorOf: () => '' }

  it('is his display name, trimmed, where the pinned work-kit takes one', () => {
    expect(lastEditorOption('  Landon Johnson ', taking)).toEqual({ lastEditor: 'Landon Johnson' })
    expect(lastEditorOption('x'.repeat(300), taking).lastEditor).toHaveLength(255)
  })

  it('is left unset where no name is known, and where the pin has no writer that takes one', () => {
    expect(lastEditorOption(null, taking)).toEqual({})
    expect(lastEditorOption('   ', taking)).toEqual({})
    expect(lastEditorOption('Landon Johnson', {})).toEqual({})
  })

  it('is unknown on every host today: no host reads his Microsoft display name', () => {
    expect(microsoftDisplayName()).toBeNull()
    expect(lastEditorOption(microsoftDisplayName(), taking)).toEqual({})
  })
})
