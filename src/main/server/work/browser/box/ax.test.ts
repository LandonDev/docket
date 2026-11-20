import { describe, expect, it } from 'vitest'
import { IndexBook, readTree, type AxNode } from './ax'

/** The box's reader (ax.ts): a long field's value is cut in a whole read, and answered whole in that element's read (§4.4). */
describe('a long field on the box', () => {
  const body = `Hi Dana, ${'the wire details follow. '.repeat(12)}Send it to account 1234.`
  const nodes: AxNode[] = [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Mail' }, childIds: ['2'], backendDOMNodeId: 1 },
    { nodeId: '2', role: { value: 'textbox' }, name: { value: 'Message' }, value: { value: body }, properties: [{ name: 'multiline', value: { value: true } }], backendDOMNodeId: 2 }
  ]
  const field = () => readTree(nodes, new IndexBook(), { page: 'p1', passwords: new Set() }).kept.find((k) => k.line.role === 'text area')!.line

  it('cuts it in a whole read and answers it whole in its own element read', () => {
    expect(body.length).toBeGreaterThan(160)
    expect(field().value).toBe(`${body.slice(0, 160)}…(+${body.length - 160} chars)`)
    const book = new IndexBook()
    const index = readTree(nodes, book, { page: 'p1', passwords: new Set() }).kept.find((k) => k.line.role === 'text area')!.line.index
    expect(readTree(nodes, book, { page: 'p1', passwords: new Set(), root: index }).kept.find((k) => k.line.index === index)!.line.value).toBe(body)
  })
})
