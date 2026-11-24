import { describe, expect, it } from 'vitest'
import { addressesIn, missingOf, notAnswered } from './msformAnswered'

describe("who hasn't answered", () => {
  it('reads every address from pasted text once, lower-cased', () => {
    expect(addressesIn('Dana Lee <Dana@Example.test>, kai@example.test; dana@example.test\nnot an address\n"Sam" sam.r@school.example.edu')).toEqual([
      'dana@example.test',
      'kai@example.test',
      'sam.r@school.example.edu'
    ])
  })

  it('leaves those who answered out of the list, matched lower-cased, in the list’s order', () => {
    const list = addressesIn('kai@example.test\nDana@example.test\nsam@example.test\nkai@example.test')
    expect(notAnswered(['DANA@example.test', 'someone@else.test'], list)).toEqual(['kai@example.test', 'sam@example.test'])
    expect(notAnswered([], [])).toEqual([])
  })

  it('counts a person of the sector as answered by any of their addresses, and a pasted address once', () => {
    const list = [{ name: 'Maya Chen', emails: ['maya@school.edu', 'MAYA.C@gmail.example'] }, { name: 'Tom Beck', emails: ['tom@school.edu'] }, ...addressesIn('tom@school.edu, new@school.edu').map((e) => ({ emails: [e] }))]
    expect(missingOf(['maya.c@gmail.example'], list)).toEqual([{ name: 'Tom Beck', email: 'tom@school.edu' }, { email: 'new@school.edu' }])
    expect(missingOf(['maya@school.edu', 'tom@school.edu', 'new@school.edu'], list)).toEqual([])
  })
})
