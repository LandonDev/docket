import { describe, expect, it } from 'vitest'
import { hostAliases, originAliases } from './publicHosts'

describe('hostAliases', () => {
  it('gives both public names for either', () => {
    expect(hostAliases('tempcode.landonhale.com')).toEqual(['tempcode.landonhale.com', 'docket.landonhale.com'])
    expect(hostAliases('Docket.LandonHale.com.')).toEqual(['tempcode.landonhale.com', 'docket.landonhale.com'])
  })

  it('keeps any other name alone, the guest origin among them', () => {
    expect(hostAliases('share.landonhale.com')).toEqual(['share.landonhale.com'])
    expect(hostAliases('x.tempcode.landonhale.com')).toEqual(['x.tempcode.landonhale.com'])
    expect(hostAliases('127.0.0.1')).toEqual(['127.0.0.1'])
  })
})

describe('originAliases', () => {
  it('adds the other public name with scheme, port and path kept', () => {
    expect(originAliases('https://tempcode.landonhale.com')).toEqual(['https://tempcode.landonhale.com', 'https://docket.landonhale.com'])
    expect(originAliases('https://docket.landonhale.com')).toEqual(['https://docket.landonhale.com', 'https://tempcode.landonhale.com'])
    expect(originAliases('wss://TempCode.landonhale.com:8443/ws')).toEqual(['wss://TempCode.landonhale.com:8443/ws', 'wss://docket.landonhale.com:8443/ws'])
  })

  it('keeps another origin, and text that is no URL, alone', () => {
    expect(originAliases('https://share.landonhale.com')).toEqual(['https://share.landonhale.com'])
    expect(originAliases('http://127.0.0.1:7677')).toEqual(['http://127.0.0.1:7677'])
    expect(originAliases('')).toEqual([''])
  })
})
