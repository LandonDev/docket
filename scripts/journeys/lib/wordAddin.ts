import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { words, type Pair } from './shape'
import { until } from './window'

const PART = 'word/document.xml'

export function wordFixture(file: string, before: string, after: string) {
  const read = () => {
    const parts = unzipSync(readFileSync(file))
    if (!parts[PART]) throw new Error('The dummy Word file has no document part')
    return { parts, xml: strFromU8(parts[PART]) }
  }
  return {
    paragraphs() {
      return Array.from(read().xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g),
        ([, paragraph]) => Array.from(paragraph!.matchAll(/<w:t(?:\s[^>]*)?>(.*?)<\/w:t>/g), ([, text]) => text).join(''))
    },
    edit(args: { tracked?: boolean; edit?: { find?: string; replace?: string } }) {
      if (args.tracked !== false || args.edit?.find !== before || args.edit?.replace !== after) {
        throw new Error('The dummy add-in accepts only this journey’s plain Word edit')
      }
      const { parts, xml } = read()
      if (xml.split(before).length !== 2) throw new Error('The dummy Word phrase does not stand in exactly one place')
      parts[PART] = strToU8(xml.replace(before, after))
      writeFileSync(file + '.tmp', zipSync(parts))
      renameSync(file + '.tmp', file)
      return 1
    }
  }
}

/** A dummy document behind the real Work add-in protocol. The cloud address is a key for the file, never visited. */
export async function openWordAddin(pair: Pair, file: string, address: string, before: string, after: string) {
  const host = pair.box
  const { code } = await pair.rpc<{ code: string }>(host, 'work.office.addin.pair')
  const fixture = wordFixture(file, before, after)
  const calls: string[] = []
  let keyId: string | undefined
  let ready = false
  let failure = ''
  const socket = new WebSocket('ws://127.0.0.1:' + host.workPort + '/w/office')
  const send = (body: object) => socket.send(JSON.stringify(body))
  socket.onopen = () => send({ t: 'pair', code, name: 'Journey Word', app: 'word', platform: 'web' })
  socket.onerror = () => { failure = 'The isolated Work service refused the dummy add-in socket' }
  socket.onclose = ({ reason }) => { failure = reason || failure || 'The dummy Word socket closed' }
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(String(data)) as { t: string; id?: string | number; op?: string; args?: Parameters<typeof fixture.edit>[0] }
    if (message.t === 'paired') keyId = String(message.id)
    if (message.t === 'welcome') {
      send({ t: 'file', file: { key: address, name: basename(file) } })
      ready = true
    }
    if (message.t !== 'call' || !message.op) return
    calls.push(message.op)
    try {
      const value = message.op === 'word.read' ? fixture.paragraphs() : message.op === 'word.edit' ? fixture.edit(message.args ?? {}) : undefined
      if (value === undefined) throw new Error('The dummy Word add-in does not handle ' + message.op)
      send({ t: 'result', id: message.id, value })
    } catch (error) {
      send({ t: 'result', id: message.id, error: words(error) })
    }
  }
  pair.later(async () => socket.close())
  await until('the dummy Word add-in to pair on box', 15_000, async () => {
    if (failure) throw new Error(failure)
    if (!ready) return false
    const { keys } = await pair.rpc<{ keys: { id: string; live: boolean }[] }>(host, 'work.office.addin.list')
    return keys.some((key) => key.id === keyId && key.live)
  }, pair.abort.signal)
  return calls
}
