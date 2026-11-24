import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { carrierFetchExpression, carrierLets, inheritCarrierTargets } from './service'

/**
 * The pages a carrier session owns (review 2) and the request it makes from inside one (review 24), on their own:
 * ownership passes down every opener, no other session may see an owned page, and the in-page request runs only on
 * the origin the host checked and follows no redirect.
 */

describe("the carrier's pages", () => {
  it('pass to every page opened from one, at any depth, and are forgotten once gone', () => {
    const owned = new Map([['results', 'tc-carrier-a']])
    inheritCarrierTargets(
      [
        { targetId: 'results' },
        { targetId: 'excel', openerId: 'results' },
        { targetId: 'sharepoint', openerId: 'excel' },
        { targetId: 'his', openerId: 'somewhere-else' },
        { targetId: 'mine' }
      ],
      owned
    )
    expect(Object.fromEntries(owned)).toEqual({ results: 'tc-carrier-a', excel: 'tc-carrier-a', sharepoint: 'tc-carrier-a' })
    inheritCarrierTargets([{ targetId: 'excel', openerId: 'results' }], owned)
    expect(Object.fromEntries(owned)).toEqual({ excel: 'tc-carrier-a' })
  })

  it("are seen by their own carrier session alone: never by a thread, by no session at all, or by another carrier", () => {
    const owned = new Map([['excel', 'tc-carrier-a']])
    expect(carrierLets('excel', 'tc-carrier-a', owned)).toBe(true)
    expect(carrierLets('excel', 'thread-1', owned)).toBe(false)
    expect(carrierLets('excel', undefined, owned)).toBe(false)
    expect(carrierLets('excel', 'tc-carrier-b', owned)).toBe(false)
    // a page no carrier owns is everyone's to see, as before
    expect(carrierLets('his', 'thread-1', owned)).toBe(true)
    expect(carrierLets('his', 'tc-carrier-a', owned)).toBe(true)
  })
})

describe("the carrier's in-page request", () => {
  const run = async (expression: string, page: { origin: string }, answer: { status?: number; redirected?: boolean; type?: string; url?: string; text?: string }) => {
    const asked: { url: string; init: Record<string, unknown> }[] = []
    const fetch = async (url: string, init: Record<string, unknown>) => {
      asked.push({ url, init })
      return { status: answer.status ?? 200, redirected: answer.redirected ?? false, type: answer.type ?? 'basic', url: answer.url ?? url, text: async () => answer.text ?? '{}', arrayBuffer: async () => new ArrayBuffer(0) }
    }
    const value = await (runInNewContext(expression, { location: page, fetch, URL, btoa, Uint8Array, String }) as Promise<unknown>)
    return { value, asked }
  }
  const SITE = 'https://purdue0.sharepoint.com'
  const url = `${SITE}/sites/RecWell/_api/web/GetFileById('x')`

  it('asks with no redirect followed, as the signed-in page itself, and answers its status and words', async () => {
    const { value, asked } = await run(carrierFetchExpression(url, SITE), { origin: SITE }, { text: '{"Name":"a.xlsx"}' })
    expect(value).toEqual({ status: 200, text: '{"Name":"a.xlsx"}' })
    expect(asked[0]!.init).toMatchObject({ credentials: 'include', redirect: 'error', method: 'GET' })
  })

  it('asks nothing once the live page is on another origin', async () => {
    const { value, asked } = await run(carrierFetchExpression(url, SITE), { origin: 'https://evil.example' }, {})
    expect(value).toEqual({ status: -1 })
    expect(asked).toEqual([])
  })

  it('answers 0, and none of the body, for a response that was redirected or ended on another origin', async () => {
    for (const answer of [{ redirected: true }, { type: 'opaqueredirect', status: 0 }, { url: 'https://login.microsoftonline.com/x' }])
      expect((await run(carrierFetchExpression(url, SITE), { origin: SITE }, { ...answer, text: 'secret' })).value, JSON.stringify(answer)).toEqual({ status: 0 })
  })
})
