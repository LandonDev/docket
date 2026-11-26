import { describe, expect, it } from 'vitest'
import { modelLabel } from './viz'

describe('modelLabel', () => {
  it('names a model as the rest of the app does, dated ids too', () => {
    expect(modelLabel('claude-fable-5-1')).toBe('Claude Fable 5.1')
    expect(modelLabel('claude-opus-5-5-20261001')).toBe('Claude Opus 5.5')
  })

  it('names a model this install hides from its picker by the shared catalog', () => {
    expect(modelLabel('gpt-6.1-sol')).toBe('GPT-6.1 Sol')
  })

  it('says an id no catalog knows in title case, never raw', () => {
    expect(modelLabel('claude-mystery-9')).toBe('Mystery 9')
    expect(modelLabel('some-model-latest')).toBe('Some Model')
    expect(modelLabel('gpt-7-2-nova')).toBe('GPT 7.2 Nova')
  })
})
