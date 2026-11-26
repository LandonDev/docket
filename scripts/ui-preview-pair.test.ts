import { describe, expect, it } from 'vitest'
import { pairPreview } from './ui-preview-pair'

describe('the pairing preview', () => {
  it('holds a blank field or shows the example linked code', async () => {
    expect(await pairPreview('Blank', false)).toContain('aria-label="Pairing code"')
    expect(await pairPreview('Linked', true)).toContain('<div id="code">GUIDE-MAP01</div>')
  })

  it('runs refusal, rate-limited and one-time key states on fake replies', async () => {
    expect(await pairPreview('Refused', false)).toContain('class="failed"')
    expect(await pairPreview('RateLimited', false)).toContain('Too many tries. Try again in 2 min.')
    const key = await pairPreview('KeyShownOnce', true)
    expect(key).toContain('preview-only-key-never-valid')
    expect(key).toContain('Shown once.')
  })
})
