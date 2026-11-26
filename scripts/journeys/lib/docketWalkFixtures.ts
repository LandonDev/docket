import type { AgentEvent } from '../../../src/shared/events'

const MARKDOWN = `## What I found

The gateway test fails one run in five because **two profiles share a port**. Three things matter:

1. \`gateway.test.ts\` binds 8787 before the fake provider is up.
2. The retry loop in \`routeByHeadroom\` never backs off.
3. A stale socket is left open when the first probe times out.

| File | Lines | Change |
| --- | --- | --- |
| src/main/server/gateway.ts | 212 to 240 | wait for the listener |
| src/main/server/gatewayCore.ts | 88 | back off 50 ms |

\`\`\`ts
export async function listen(port: number): Promise<Server> {
  const server = createServer(handler)
  await once(server.listen(port, '127.0.0.1'), 'listening')
  return server
}
\`\`\`

> The fix is small. I have not run the whole suite.

Next I will add the test and run it twenty times.`

export const transcriptTurn = (n: string): AgentEvent[] => [
  { type: 'user-text', text: 'Find out why the practice gateway test is flaky.' },
  { type: 'thinking', text: 'The failure is intermittent, so it is a race. I should read the test first, then the listener.', delta: false, msgId: 'm1' + n, blockIndex: 0 },
  { type: 'tool-call', callId: 'c1' + n, name: 'Read', input: { file_path: '/srv/work/acme-site/src/main/server/gateway.test.ts' } },
  { type: 'tool-result', callId: 'c1' + n, output: 'import { describe, it } from "vitest"\n// 240 lines', isError: false },
  { type: 'tool-call', callId: 'c2' + n, name: 'Grep', input: { pattern: 'routeByHeadroom', path: 'src/main/server' } },
  { type: 'tool-result', callId: 'c2' + n, output: 'src/main/server/gatewayCore.ts:88', isError: false },
  { type: 'tool-call', callId: 'c3' + n, name: 'Bash', input: { command: 'NODE_ENV=test bunx vitest run src/main/server/gateway.test.ts', description: 'Run the gateway test' } },
  { type: 'tool-result', callId: 'c3' + n, output: ' FAIL  src/main/server/gateway.test.ts > routes by headroom\nError: listen EADDRINUSE: address already in use 127.0.0.1:8787\n Test Files  1 failed (1)\n      Tests  1 failed | 11 passed (12)', isError: true },
  { type: 'tool-call', callId: 'c4' + n, name: 'Edit', input: { file_path: '/srv/work/acme-site/src/main/server/gateway.ts', old_string: "  server.listen(port, '127.0.0.1')\n  return server", new_string: "  await once(server.listen(port, '127.0.0.1'), 'listening')\n  return server" } },
  { type: 'tool-result', callId: 'c4' + n, output: 'The file was updated.', isError: false },
  { type: 'assistant-text', text: MARKDOWN, delta: false, msgId: 'm2' + n, blockIndex: 1 }
]
