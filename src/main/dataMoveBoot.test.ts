import { afterEach, describe, expect, it } from 'vitest'
import type { DataMove } from './dataMove'
import { dataMoveBoot, doctorDataMove } from './dataMoveBoot'

const slot = globalThis as { __tempcodeDataMove?: DataMove }

describe('dataMoveBoot', () => {
  afterEach(() => {
    delete slot.__tempcodeDataMove
  })

  it('is null, and doctor.get says nothing, in a process boot.js did not start', () => {
    expect(dataMoveBoot()).toBeNull()
    expect(doctorDataMove()).toEqual({})
  })

  it('hands doctor.get what boot.ts left: the folder, the database, what moved and what stayed', () => {
    slot.__tempcodeDataMove = {
      v: 1,
      userData: '/Users/me/Library/Application Support/Docket',
      setPath: true,
      db: 'docket.db',
      did: ['renamed temp-code.db to docket.db in /Users/me/Library/Application Support/Docket, with a link at the old name'],
      held: []
    }
    expect(doctorDataMove()).toEqual({
      dataMove: {
        userData: '/Users/me/Library/Application Support/Docket',
        db: 'docket.db',
        did: ['renamed temp-code.db to docket.db in /Users/me/Library/Application Support/Docket, with a link at the old name'],
        held: []
      }
    })
  })
})
