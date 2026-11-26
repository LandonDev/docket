# Renderer retention

These bounds apply to renderer caches and logs. They leave the normal
interface and persisted event history as they are.

| Owner | Bound and removal rule | Unit tests |
| --- | --- | --- |
| `lib/tcserver/store.ts` history head | Keep every persisted row. Replace each tool call's ephemeral partial input in its first replay slot, so interleaved calls keep their order. Release the buffer when the head settles, resets or unloads. | `lib/tcserver/store.test.ts`: 200 previews, persisted rows, and the same full fold for open and completed calls |
| `chrome/lightboxStore.ts` | A 64 MiB LRU, counting two bytes per data URL character. Hits refresh recency; null, failed and oversized results stay out of the cache. Concurrent reads of one attachment share a request. | `chrome/lightboxStore.test.ts`: eviction, retry, shared reads and oversized images |
| `lib/hostJobs.ts` | Keep the last `HOST_LOG_CAP` code units (512 × 1024, the host's existing string-length cap) plus one `Earlier log output was removed.` line. Bound snapshots and appends; reset removes the line. The constant lives in `src/shared/contract-host.ts`. | `lib/hostJobs.test.ts`: tail, one marker, reset, snapshot and oversized append |
| `lib/devServers.ts` | Remove logs when a replacement or refresh removes their run, or when their host leaves. A host refresh still keeps finished run rows for their logs until a replacement removes them. Stop subscriptions on host removal and ignore late host refreshes and log reads. | `lib/devServers.test.ts`: replacement, host and target refresh, removal and late replies |
| `lib/threadResources.ts`, `lib/macBridgeRules.ts` | Use `registry.onLink`'s existing-link replay once, without a second loop over those links. | Each owner's test: two open links each attach once; resource reads happen once per link |
| `lib/perfMarks.ts` | Keep at most 200 `tc:` marks. Count names as marks arrive; on overflow clear all occurrences of the oldest name, as required by `performance.clearMarks(name)`. No per-mark timeline scan. Other marks stay; listeners hear every call. | `lib/perfMarks.test.ts`: 1,000 distinct and repeated marks, listener delivery and no scans |
| `lib/markdownCache.ts`, `lib/renderCache.ts` (and the parse worker's) | The settled markdown trees, 48 MiB of estimated bytes each (`treeBytes`), not source characters; LRU. | renderCache and markdownCache tests |
| `lib/tcserver/store.ts` kept transcripts | The mounted set, its children and a master's threads, and the last `KEEP_RECENT` (6) shown under `RECENT_ROW_BUDGET` rows; a running transcript outside them unloads like a settled one (its meta tells the rail how it runs); only a send on its way keeps a transcript's rows. A loaded remote transcript's raw rows have no bound yet (a bound was built and withdrawn, `.temp-code/plans/landed/PERF-docket.md`). | store.test.ts "the mounted set" |
| `lib/fileIndex.ts` | A project's file list for 4 checkouts by host and cwd; asked again after 30 s or the window's git-changed event; dropped on a key change or the host leaving. | fileIndex.keep.dom.test.tsx |
| `lib/tcserver/catalog.ts` | A host's model catalog for 60 s; forced on a new socket, dropped with the host, never kept on a failure. | catalog tests |
| `lib/workspaceSessions.ts` | The column's row cache by scope, for the catalog's scopes; a removed workspace's goes. | workspaceSessions.test.ts |

Paths in the table are under `src/renderer/src/` unless stated otherwise.
These are local bounds, not a total renderer memory budget. Persisted rows
and finished dev-run rows still follow their owners' history rules. The
image budget excludes decoded images held by mounted elements and reads
that have yet to settle.
