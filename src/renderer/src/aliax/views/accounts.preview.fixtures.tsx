import { base } from './accounts.fixtures'

export default [
  { name: 'The page: Claude Code, Codex with a limited account, Meta keys, Cursor not installed', props: base },
  // The waits beside it (docs/agents/loading-bones.md): the services' read out, then every row's report out through a Refresh.
  { name: 'The services on their way: the page drawn from its sample', props: { ...base, waiting: true } },
  { name: 'A Refresh: each row waits in the shape its last report landed in', props: { ...base, usage: {}, layout: base.usage } }
]
