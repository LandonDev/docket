import { describe, expect, it } from 'vitest'
import { isTempCodeBrowserHost, isTempCodeOrigin, type TempCodeOrigins } from './tempcodeOrigins'

const origins: TempCodeOrigins = {
  listenerPorts: [7677, 17117],
  lanAddresses: ['192.168.1.25', '2001:db8:0:0::15', 'box.local'],
  tunnelHosts: ['box.example'],
  remoteRoutes: ['https://box.example', 'wss://peer.example:8443/ws', 'ws://192.168.1.55:7677/ws']
}

describe('TempCode browser origins', () => {
  it.each([
    'http://localhost:7677/ui',
    'http://LOcalhost.:7677/pair',
    'http://other.localhost:7677/',
    'http://127.5.2.3:7677/',
    'http://127.1:7677/',
    'ws://2130706433:7677/ws',
    'http://[::ffff:127.0.0.1]:7677/ui',
    'ws://[::1]:17117/ws',
    'http://0.0.0.0:7677',
    'http://[::]:7677',
    'http://192.168.1.25:7677',
    'http://[2001:db8::15]:7677',
    'http://box.local:7677',
    'wss://BOX.example.:443/ws',
    'http://box.example/pair',
    'https://box.example:8443/pair',
    'https://peer.example:8443/pair',
    'http://192.168.1.55:7677/ui',
    'view-source:https://box.example/ui',
    'blob:https://box.example/fake'
  ])('refuses %s', (url) => expect(isTempCodeOrigin(url, origins)).toBe(true))

  it.each([
    'http://localhost:7678/ui',
    'http://192.168.1.25:80/',
    'https://127.example:7677/',
    'https://box.example.evil.test/',
    'https://box.example@ordinary.test/',
    'https://peer.example/',
    'https://ordinary.test/',
    'not a URL'
  ])('allows %s', (url) => expect(isTempCodeOrigin(url, origins)).toBe(false))
})

describe('the box’s two public names', () => {
  const saved = (route: string): TempCodeOrigins => ({
    listenerPorts: [7677],
    lanAddresses: [],
    tunnelHosts: [new URL(route).hostname],
    remoteRoutes: [route]
  })

  it.each([
    ['https://tempcode.landonhale.com', 'https://tempcode.landonhale.com/ui'],
    ['https://tempcode.landonhale.com', 'https://docket.landonhale.com/ui'],
    ['https://tempcode.landonhale.com', 'wss://docket.landonhale.com/ws'],
    ['https://tempcode.landonhale.com', 'https://docket.landonhale.com/w/addin/taskpane.html'],
    ['https://docket.landonhale.com', 'https://tempcode.landonhale.com/g/x'],
    ['https://docket.landonhale.com', 'https://docket.landonhale.com/pair']
  ])('saved as %s, refuses %s', (route, url) => expect(isTempCodeOrigin(url, saved(route))).toBe(true))

  it('refuses either name where only a linked peer announced the other', () => {
    const local: TempCodeOrigins = { listenerPorts: [7677], lanAddresses: [], remoteRoutes: [], linkedEndpoints: [saved('https://tempcode.landonhale.com')] }
    expect(isTempCodeOrigin('https://docket.landonhale.com/ui', local)).toBe(true)
    expect(isTempCodeOrigin('https://tempcode.landonhale.com/ui', local)).toBe(true)
  })

  it('makes no alias of the guest origin or a lookalike', () => {
    const box = saved('https://tempcode.landonhale.com')
    expect(isTempCodeOrigin('https://share.landonhale.com/g/x', box)).toBe(false)
    expect(isTempCodeOrigin('https://docket.landonhale.com.evil.test/', box)).toBe(false)
    expect(isTempCodeOrigin('https://docket.example/', saved('https://box.example'))).toBe(false)
  })

  it('answers the listener’s browser pages on both names, never another port of the tunnel', () => {
    const box = saved('https://tempcode.landonhale.com')
    expect(isTempCodeBrowserHost('tempcode.landonhale.com', 'https', box)).toBe(true)
    expect(isTempCodeBrowserHost('docket.landonhale.com', 'https', box)).toBe(true)
    expect(isTempCodeBrowserHost('docket.landonhale.com:8443', 'https', box)).toBe(false)
    expect(isTempCodeBrowserHost('share.landonhale.com', 'https', box)).toBe(false)
  })
})
