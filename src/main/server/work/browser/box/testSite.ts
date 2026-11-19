import { createServer, type Server } from 'node:http'

/**
 * A test site served on the box's loopback for the box browser's proofs: a
 * portal's form over two screens and a final screen with its submit, as a
 * real portal is shaped (labels, a password field, a review page).
 */

const page = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main>${body}</main></body></html>`

export const SITE_PAGES: Record<string, string> = {
  '/': page(
    'Expense portal',
    `<h1>New expense</h1>
     <form action="/review" method="get">
       <label for="name">Name</label><input id="name" name="name">
       <label for="amount">Amount</label><input id="amount" name="amount">
       <label for="pw">Password</label><input id="pw" name="pw" type="password">
       <label><input type="checkbox" name="receipt"> Receipt attached</label>
       <button type="submit">Next</button>
     </form>`
  ),
  '/review': page(
    'Review expense',
    `<h1>Review</h1>
     <p id="summary"></p>
     <form action="/done" method="post"><button type="submit">Submit expense</button></form>
     <script>const q = new URLSearchParams(location.search); document.getElementById('summary').textContent = q.get('name') + ' — ' + q.get('amount')</script>`
  ),
  '/chat': page('Team chat', '<form action="/sent" method="post"><textarea name="m" aria-label="Message"></textarea><button type="submit">Send</button></form>'),
  '/done': page('Expense submitted', '<h1>Submitted</h1><p>Your expense was submitted.</p>')
}

export interface TestSite {
  url: string
  /** every POST the site took: a submit that went through */
  posts: string[]
  close(): Promise<void>
}

export function serveTestSite(pages: Record<string, string> = SITE_PAGES): Promise<TestSite> {
  const posts: string[] = []
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!
    if (req.method === 'POST') posts.push(path)
    const html = pages[path]
    res.writeHead(html ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html ?? 'not found')
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      resolve({ url: `http://127.0.0.1:${port}`, posts, close: () => new Promise((r) => server.close(() => r())) })
    })
  )
}
