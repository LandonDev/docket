import { describe, expect, it } from 'vitest'
import { titleSeed } from './titleSeed'

describe('the line a new thread is first named by', () => {
  it('is his own first words, never the line that says what the message is about', () => {
    const text = 'About this file: Practice plan.pdf ({"at":"file","host":"env_box","path":"/w/Practice plan.pdf"})\n\nWhat does page 3 say?'
    expect(titleSeed(text)).toBe('What does page 3 say?')
    expect(titleSeed('About this task: Book the ballroom (LifeOS tasks k1)\n> Call Dana first\n\nDraft the mail')).toBe('Draft the mail')
  })

  it('is the thing itself when he sent the chip alone', () => {
    expect(titleSeed('About this file: Budget (final).xlsx ({"at":"file","host":"h","path":"/w/Budget (final).xlsx"})')).toBe('Budget (final).xlsx')
    expect(titleSeed('About this mail: Lunch on Friday (LifeOS mailThreads mt1)\nAbout this task: Book it (LifeOS tasks k1)')).toBe('Lunch on Friday')
  })

  it('leaves a plain message as it was: its first line', () => {
    expect(titleSeed('  Plan the spring LAN\nwith a budget')).toBe('Plan the spring LAN')
    expect(titleSeed('/review the diff\n\nAbout this file: a.ts ({"at":"file","path":"/a.ts"})')).toBe('/review the diff')
    expect(titleSeed('')).toBe('')
  })
})
