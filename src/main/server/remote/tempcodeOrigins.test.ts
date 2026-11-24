import { describe, expect, it } from 'vitest'
import { isTempCodeOrigin, type TempCodeOrigins } from './tempcodeOrigins'

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
