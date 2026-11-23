import { describe, expect, it } from 'vitest'
import { chosenHost, decideOffer, fellBackLine, insecureLine, refusedLine, routeIsSecure, shortSubject, versionLine, type OfferFacts } from './codeUpdate'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const facts = (patch: Partial<OfferFacts> = {}): OfferFacts => ({ chosen: true, refusal: null, commit: B, release: 12, running: null, staged: null, failed: null, ...patch })

describe('decideOffer', () => {
  it('takes a newer commit from the chosen host', () => {
    expect(decideOffer(facts())).toEqual({ kind: 'take' })
    expect(decideOffer(facts({ running: { commit: A, release: 11 } }))).toEqual({ kind: 'take' })
    expect(decideOffer(facts({ staged: { commit: A, release: 11 } }))).toEqual({ kind: 'take' })
  })

  it('a host that is not the chosen one offers nothing, whatever else is true', () => {
    expect(decideOffer(facts({ chosen: false }))).toEqual({ kind: 'skip', why: 'not the host this Mac takes code from' })
    expect(decideOffer(facts({ chosen: false, refusal: 'needs a full release: node_modules changed' })).kind).toBe('skip')
  })

  it('skips what is here already and what is older', () => {
    expect(decideOffer(facts({ running: { commit: B, release: 12 } })).kind).toBe('skip')
    expect(decideOffer(facts({ staged: { commit: B, release: 12 } })).kind).toBe('skip')
    expect(decideOffer(facts({ running: { commit: A, release: 12 } }))).toEqual({ kind: 'skip', why: 'older than the code running' })
    expect(decideOffer(facts({ staged: { commit: A, release: 13 } }))).toEqual({ kind: 'skip', why: 'older than the code staged' })
    expect(decideOffer(facts({ refusal: 'this build is 1.0.12 already' }))).toEqual({ kind: 'skip', why: 'this build is 1.0.12 already' })
  })

  it('refuses with boot’s own line when the base differs', () => {
    expect(decideOffer(facts({ refusal: 'needs a full release: node_modules changed' }))).toEqual({ kind: 'refuse', line: 'needs a full release: node_modules changed' })
  })

  it('does not take a commit that did not start here a second time', () => {
    expect(decideOffer(facts({ failed: B }))).toEqual({ kind: 'refuse', line: 'this code did not start here' })
    expect(decideOffer(facts({ failed: A }))).toEqual({ kind: 'take' })
  })
})

describe('the words', () => {
  it('says an unencrypted link in one plain line', () => {
    expect(insecureLine('The box')).toBe('Code updates need an encrypted link to The box.')
  })

  it('cuts a subject to its first sentence, else its first words', () => {
    expect(shortSubject('Reload writes the file. After Keep Both the record names Roster.')).toBe('Reload writes the file')
    expect(shortSubject('Fix the rail')).toBe('Fix the rail')
    expect(shortSubject('one\ntwo')).toBe('one')
    const long = shortSubject('A file that took another’s place in a tab is never opened twice by either of the two rows that name it', 40)
    expect(long.length).toBeLessThanOrEqual(40)
    expect(long.endsWith('…')).toBe(true)
    expect(long).toBe('A file that took another’s place in a…')
  })

  it('says the version with the commit of the staged code it runs', () => {
    expect(versionLine('1.0.371')).toBe('1.0.371')
    expect(versionLine('1.0.371', null)).toBe('1.0.371')
    expect(versionLine('1.0.371', '3f9c2ab' + 'f'.repeat(33))).toBe('1.0.371 + 3f9c2ab')
  })

  it('says a fallback and a refusal in one plain line', () => {
    expect(fellBackLine(A, '1.0.371')).toBe('Code update aaaaaaa did not start. Running 1.0.371.')
    expect(refusedLine(A, 'needs a full release: node_modules changed')).toBe('Code update aaaaaaa needs a full release: node_modules changed.')
    expect(refusedLine(A, 'main/index.js is not the file the manifest names')).toBe('Code update aaaaaaa was not taken: main/index.js is not the file the manifest names.')
  })
})

describe('chosenHost', () => {
  const box = { id: 'env-box', name: 'The box' }
  const other = { id: 'env-other', name: 'Another' }

  it('with nothing set takes the only admin host and pins it; with several or none, no host', () => {
    expect(chosenHost(null, [box])).toEqual({ host: 'env-box', pin: 'env-box' })
    expect(chosenHost(undefined, [box, other])).toEqual({ host: null })
    expect(chosenHost(null, [])).toEqual({ host: null })
  })

  it('once set, stays with that host: a host saved later is never taken', () => {
    expect(chosenHost('env-box', [box, other])).toEqual({ host: 'env-box' })
    expect(chosenHost('env-box', [other])).toEqual({ host: null })
  })

  it('off is no host', () => {
    expect(chosenHost('off', [box])).toEqual({ host: null })
  })
})

describe('routeIsSecure', () => {
  it('passes TLS and this machine, and nothing the network can read', () => {
    expect(routeIsSecure('wss://tempcode.example.com/ws')).toBe(true)
    expect(routeIsSecure('ws://127.0.0.1:7677/ws')).toBe(true)
    expect(routeIsSecure('ws://localhost:7677/ws')).toBe(true)
    expect(routeIsSecure('ws://box.local:7677/ws')).toBe(false)
    expect(routeIsSecure('ws://192.168.1.20:7677/ws')).toBe(false)
    expect(routeIsSecure('ws://100.101.102.103:7677/ws')).toBe(false)
    expect(routeIsSecure('http://example.com')).toBe(false)
    expect(routeIsSecure('not a url')).toBe(false)
    expect(routeIsSecure(null)).toBe(false)
  })
})
