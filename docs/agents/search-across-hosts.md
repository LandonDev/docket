# Search across hosts: one query, every host, an FTS5 index per host

- The search surface (src/renderer/src/surfaces/SearchView.tsx on
  src/renderer/src/lib/crossHostSearch.ts) asks every connected host the
  same query in parallel (threads by title and transcript, files by
  `search.project` in the host's copy of the paired project, notes by
  `notes.search`), streams each host's rows as it answers, ranks without
  looking at the host (match quality from the hosts' bm25 ranks plus
  recency), folds a file at the same relative path in both copies of a
  linked project (src/renderer/src/lib/projectPairs.ts: one `linkId`, else
  the linker's own rule of same GitHub repo, else same folder name, for rows
  it has not stamped yet) into one row on the newer copy (`search.project`
  matches carry `mtime`), folds each file's name and matching lines into
  one row (`foldFileHits`: the first line, `+N more` for the others; a name
  hit opens at its first line), folds a thread's message hits on one host
  into one row the same way (`foldMessageHits`: its best match, which opens
  there, `+N more`), draws a message or note snippet as prose
  (`plainSnippet`: no markdown marks; `snippetAround` cuts on a word's
  edge), searches a loaded thread's person's and model's words alone as the
  host's index does (`turnText`; tool rows and plans are not messages), leads a thread hit with its tinted type
  glyph (`ConversationHit.threadType`, chat when absent), marks each hit
  with the host glyph when more than one host is paired, and, with two or more hosts paired, says "box"
  then "1.2 s" in muted per host at the foot, no colon (`hostTimingWord`;
  "skipped" when offline, "failed" in red, the reason in its tooltip). Filters are typed in the box (`host:` and `type:` take a
  comma list, `project:` a name) or ticked in the field's filter menu
  (chrome/SearchFiltersMenu.tsx), which writes the same tokens
  (`setQueryToken`); no other chrome. Each host token first matches a whole
  name or id; `mac` on macOS names the local host alone. Substrings apply
  only when that token has no exact match. A command may open search with
  tokens already typed (`initialQuery`: `type:note`, `type:file`). A
  filter with no words lists its scope instead of searching (`browseHits`:
  the newest threads, this project's recent files, each online host's
  notes, the recent projects; no host search, spinner or foot). Enter
  opens where the hit lives, ⌘↩ in a new pane; nothing in the list
  animates.
- What it costs a key: the threads and loaded transcripts it ranks in
  memory are read when the query changes, not on every push, so a streamed
  frame rescans nothing and a meta push starts no host search. The hosts
  are asked 200 ms after the last key; a newer query aborts the older one's
  asks, and each host drops them with `request.cancel` (interactive-lane.md).
  The fan-out settles at the latest `HOST_DEADLINE_MS` (2 s) after it
  starts: a host still searching then holds no spinner or "No results", and
  its rows join the list when they come (its foot still reads "…" until
  then). This project's file names come from the kept list (lib/fileIndex.ts:
  four checkouts by host and cwd, asked again behind the paint when older
  than 30 s or named by the window's git-changed event, dropped when the
  link's key changes; names for ranking only, every open still goes through
  the host's checks); a partner host's list is kept a minute. Ranking lower-cases
  each path once a list and splits the query once a key (fuzzy.ts
  `loweredPaths`, `prepareQuery`); Go to File and `@` rank past 5,000 paths
  on the deferred query (lib/rankQuery.ts).
- `session.search` runs on an FTS5 index per host (src/main/server/
  turnIndex.ts): `events_fts` / `cold.events_fts` over turn text, rowid
  `(ordinal << 32) | seq` through `turn_index`, filled on every event
  flush for ready sessions, backfilled newest first in the background after
  boot (`Store.backfillTurnIndex`, kicked after the cold mover and hourly),
  carried by the hot/cold moves, dropped on delete and `forgetSessions`,
  with a scan of the not-yet-ready sessions unioned in meanwhile and the
  old scan as the whole answer when SQLite lacks FTS5. Hits carry `rank`
  (bm25). On the box's database (426 MB hot, 3.9 GB cold) a query went from
  0.5 s / 5 s to 2-72 ms / 3-338 ms; the backfill took 15 s. Measure on a
  copy with `bun run script:measure-turn-index <copy>`; proof
  `bun run script:e2e-cross-host-search`. docs/box.md "Search across hosts".
- The phone runs the same fan-out, merge, fold and filters in
  `ios/TempCodeClient/Sources/TempCodeClient/Client/CrossHostSearch.swift`
  (pure, Swift Testing in CrossHostSearchTests.swift), emitting thread 4's
  row model (`SearchRows.swift`) as an `AsyncStream<SearchAnswer>` the
  Search tab iterates; `notes.search` is in the phone's subset for it.