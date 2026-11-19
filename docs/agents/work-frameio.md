# Work: Frame.io

Milestone 48 of the Work plan. A Frame.io V4 file opens in the media canvas
([work-media.md](work-media.md)) from Frame.io's own rendition, with every
version of its stack and Frame.io's comments on their frames. An agent's
comment at a frame, or a new version for the stack, waits in the Outbox as a
held `frameio.post` ([work-outbox.md](work-outbox.md)) and goes on the
person's press. Frame.io's webhooks fire routines
([work-routines.md](work-routines.md)). [work.md](work.md) says how a pillar
is mounted.

Built against Frame.io's documented V4 API and a fake that answers in its
shapes; **nobody has signed in to a real Frame.io yet**. "The live test"
below is the first thing to run when the owner does.

## Files

| Part | Where |
|---|---|
| The wire, the status, the held payload | `src/shared/contract-work-frameio.ts` |
| The module: methods, the adapter's registration, the receiver, deleted threads | `src/main/server/work/frameio/index.ts` |
| The Adobe sign-in, the tokens in the vault, where Frame.io is (`frameioConfig`) | `auth.ts` |
| The V4 REST client | `api.ts` |
| One host's state, its two tables, the status | `live.ts` |
| A comment and a note, each into the other; `FRAME_BASE` | `map.ts` |
| The source adapter, opening a stack, keeping comments in step | `media.ts` |
| `frameio.post`: a comment, or an upload into a stack | `post.ts` |
| Webhooks: signing, the receiver, the trigger source | `hooks.ts` |
| The agent's tools | `tools.ts` |
| The fake Frame.io and Adobe IMS | `fakeFrameio.ts`, used by `frameio.test.ts` |
| Settings → Work's two rows and their dialogs | `src/renderer/src/work/frameio/FrameioRow.tsx` (`FrameioRows`, for the page to mount) |

## Sign-in

Adobe IMS OAuth for an **OAuth Native App** credential made in the Adobe
Developer Console with Frame.io added as a product (the owner's step; Frame.io
says any Frame.io plan may make one, and the Adobe ID must be the one he signs
in to Frame.io with). PKCE with S256, no client secret; scopes
`openid,email,profile,offline_access,additional_info.roles`
(`offline_access` brings the refresh token).

- `work.frameio.signIn {clientId, redirectUri?}` (admin) makes the verifier
  and state and answers Adobe's `/ims/authorize/v2` address. The default
  redirect is `http://127.0.0.1:7697/frameio/callback`, Adobe's documented
  loopback for a Native App: the host listens there for ten minutes, so a
  browser on the host itself finishes on its own.
- A browser on another machine (the box's sign-in, opened on the Mac) lands
  on a page that does not load; the person pastes that address and
  `work.frameio.finish {url}` takes its code, checked against the state.
- `/ims/token/v3` trades the code and verifier for the tokens; `/v4/me` names
  the user. The tokens sit sealed in this host's vault as one bare secret,
  `~frameio-tokens` on the `addon` service, as LifeOS's device token does,
  with each webhook's signing secret beside them.
- A token with under a minute left is refreshed first; a 401 refreshes once
  and tries again; a 429 waits what Retry-After says (at most 10 s), once.
- `signOut` deletes the webhooks it made and forgets the tokens.

## The API

`https://api.frame.io/v4`, called directly (the SDKs declare no licence).
Lists page by `links.next`'s `after` cursor, 100 a page, `include` sent again
on every page. Errors are `{errors: [{detail}]}` and become "Frame.io
answered 404: …". Paths used: `/me`, `/accounts`,
`/accounts/{a}/workspaces`, `…/workspaces/{ws}/projects`,
`/projects/{p}`, `/folders/{f}/children`, `/version_stacks/{vs}` and
`/children`, `/files/{id}` (with `include=media_links.…`),
`/files/{id}/comments` (GET with `include=owner,replies`, POST),
`/comments/{id}`, `/folders/{f}/files/local_upload`, `/files/{id}/status`,
`/files/{id}/move`, `/folders/{f}/version_stacks`,
`/workspaces/{ws}/webhooks`, `/webhooks/{id}`.

## In the canvas

`work.frameio.open {sessionId, account, fileId}` and the `frameio_open` tool:

- A file in a version stack opens the whole stack as one media item, oldest
  first (by `created_at`), v1 named for its own file and the item titled by
  the newest. The item's source is the oldest file; each version's source is
  `{at: 'frameio', account, fileId}`. Opening it again opens the same item.
- The item is **shared** (`MediaStore.setShared`): the agent's notes on it
  wait for the person, and the mode shows "Agent suggests".
- The adapter (`frameioMedia`, registered from `start`) reads the file with
  its media links and **downloads** the rendition into Work's media root,
  `<userData>/work-media/frameio-<fileId>/`: a video's `high_quality`
  transcode (H.264 MP4, best ready, up to 2160p), else `efficient`; a JPEG,
  PNG, WebP, GIF or AVIF picture's original, any other picture's
  high-quality still. The renderer may load no outside address, and
  Frame.io's links expire within a day, so the media host serves the copy
  like any other. It is fetched again when Frame.io's file size changes.
  ffprobe reads the copy for the frame table; Frame.io keeps no frame rate.
- Comments come in as notes: at open, after a post, on any webhook about the
  file, and on `frameio_refresh`. New comments are added; changed words,
  resolved marks and a new frame or pin follow in place, so a note keeps its
  id and the replies made on it in TempCode (the anchor is written to
  `work_media_notes` directly: `MediaStore.editNote` takes no anchor); a
  comment deleted in Frame.io goes, with what hangs on it. Notes made in
  TempCode are left alone. Mark sizes count in the rendition's height, kept
  in `meta.json` beside the copy, and a change of height alone is not a move. The media pillar never calls an adapter's
  `notes`, so this pillar keeps them itself (`syncComments`); the adapter
  has none.

### Comments ↔ notes (`map.ts`)

| Frame.io | Note |
|---|---|
| `timestamp` (frames) | `anchor.frame` = `timestamp − FRAME_BASE`; a `HH:MM:SS:FF` timecode counts from 00:00:00:00 |
| `duration` | `anchor.durationFrames` when over 1 |
| `anchor {x, y}` | `anchor.pin` |
| `annotation` (stringified JSON) | `anchor.shapes`: `rect`, `line`, `arrow` (`x, y` and its run `w, h`); anything with a `points` list reads as a pen stroke, anything else is left out |
| `size` (pixels) | `width` = size ÷ the rendition's height |
| `completed_at` | `resolved` |
| `owner` | `by`: `owner` when it is the signed-in user, else `external:frameio:<user id>`; `external.author` is the name |
| `replies` | notes with `parentId`, on the parent's anchor |

`FRAME_BASE` is 1: V4's migration guide says the timestamp counts "starting
from 1"; V2 counted from 0. Unproven on a real account.

Sending, an oval goes as its box and a drawn stroke as straight lines, since
V4 documents neither; the held item's words say so. A region becomes a
`rect`.

## Held

`frameio.post` is the pillar's one act kind, `store: 'host'`, no matcher (no
grant ever covers posting to a review others read). Its payload
(`FrameioPost`) is exactly what goes:

- `comment`: the file (one version), the words, the frame in TempCode's
  count, its run, pin, shapes, and the picture's height. `frameio_comment`
  makes it from `at`/`until`/`region`/`text`, or from one of the agent's
  waiting notes (`note`, as `media_note` made it). The note shows on the
  item as waiting. On the press the host POSTs it (`timestamp` = frame +
  `FRAME_BASE`), drops the waiting note and reads the comments again, so the
  posted comment comes back as Frame.io's, the person's own. Discarded in
  the Outbox, it takes its waiting note with it.
- `version`: a file on the host and the version it goes on top of. Held, the
  file is copied into `<userData>/work-frameio/held/<id>/`, and only from the
  folders the media host shows, by its real path (`mediaServes`: a link that
  points out is refused), so the bytes pressed are the bytes named and the
  summary names the full path. On the press: `local_upload` into the stack's folder, each
  part `PUT` to the address Frame.io gave (`x-amz-acl: private`), the
  upload status polled up to ten minutes, then `move` into the stack (the
  migration guide's way), or a new stack of the two when the file stood
  alone. The item gains the version; the copy goes once it is sent,
  discarded or stale.

A post with Frame.io signed out, or a file gone (404), is stale and nothing
goes. Replies cannot be posted: V4 has no route for them.

## Webhooks

A routine whose trigger is `{on: 'file', source: {at: 'frameio', …}, by:
'someone-else'}` is armed by the routines engine through this pillar's
`triggers` (`frameioTrigger`). Arming:

- needs a sign-in and the host's **public https address**
  (`work.frameio.setPublicUrl`, Settings → Work), else it says why it waits;
- makes one webhook per Frame.io workspace (found from the file's project;
  routines arming together wait on one making), retried with a growing wait
  while it fails,
  for `comment.created`, `comment.updated`, `comment.deleted`,
  `comment.completed`, `comment.uncompleted` and `file.versioned`, pointed at
  `<public address>/frameio/hook`. Frame.io gives the signing secret only
  then; it is kept with the tokens. A new address, or a new sign-in, deletes
  the old webhooks and every armed routine makes its own again.

The receiver listens on `127.0.0.1:7696` (`TEMP_CODE_FRAMEIO_HOOK_PORT`, 0 for
any free port), and only once a webhook exists. **The tunnel must route the public
address's `/frameio/hook` to it**; nothing routes it today. A delivery must be
signed by one of the webhooks' secrets within five minutes, or it gets a 401;
the same delivery twice (a replay, or two webhooks' copies) is taken once.
It answers 200 at once and then reads what the delivery names (it carries
only ids): a comment's file, a version's file. A new version joins every open
item showing its stack, or the lone file it was stacked on (a file's stack is
read again on `file.versioned`; a lone file's is never cached). Every open
item showing that file or its stack reads its comments again; the routines watching any version
of the stack fire, with words such as "Dana Lee commented in Frame.io: “…”",
unless the person did it himself (`user.id` is his).

## Tools

`frameio_browse` (accounts, workspaces, projects, folders, stacks),
`frameio_open`, `frameio_comment` (held), `frameio_add_version` (held),
`frameio_refresh`. The media tools (`media_info`, `media_frames`,
`media_note`) work on the item as on any media item.

## Proving it

`NODE_ENV=test bunx vitest run src/main/server/work/frameio` runs the pillar
on a real database with the outbox, the canvas, the jobs and the media pillar,
against `FakeFrameio` (Adobe's token route with PKCE checks, the V4 routes
above in their shapes, pages cut at two rows, signed webhook deliveries
sent where a tunnel would send them). ffprobe is faked; the copy it reads
must be the bytes the fake served.

## The live test

When the owner signs in, before trusting any frame:

1. Make the credential: Adobe Developer Console → a project → add Frame.io →
   OAuth Native App. Add `http://127.0.0.1:7697/frameio/callback` as a
   redirect if the console takes it (Adobe's own page says redirects must
   be https even for localhost; if it refuses, use the `adobe+<hash>://`
   redirect it offers and paste the address back). Sign in from Settings →
   Work on the Mac first (its browser is local), then on the box (paste).
2. **Frames from 0 or 1.** In Frame.io's web player, leave a comment on the
   very first frame of a video in the review account and one at a frame you
   can name (step with the arrow keys). `frameio_open` it; `media_info`
   lists each note's frame. The first-frame comment must say frame 0. If it
   says −1 (shown as 0, clamped) for the first and one less than you named
   for the second, `FRAME_BASE` is 0: change that one number in `map.ts`
   and the test that pins it.
3. **The drawing format.** Draw one rectangle, one arrow, one line and one
   freehand stroke on a comment. Read it raw:
   `GET /v4/accounts/{a}/comments/{id}` (or log `c.annotation` in
   `syncComments`). Check the arrow's `w`/`h` are its x and y runs (V2's
   guide swaps them in its words), what the freehand tool is called and how
   its points are written; fix `shapesOf` and `annotationOf` to match.
4. Post one held comment with a region from a thread and look at it in
   Frame.io's player: same frame, same box.
5. Whether the token lasts an hour or a day and whether a refresh token
   comes back for a Native App (Adobe and Frame.io disagree): sign in, wait
   past an hour, browse.
6. Webhooks: route the tunnel's `/frameio/hook` to `127.0.0.1:7696` on the
   box, set the public address, make a routine on a Frame.io file, and
   comment from another account (or a share link).

## Not built, or not proven

- Nothing ran against a real Frame.io or Adobe account.
- The Settings rows are not mounted: `settings.tsx` is milestone 8's.
  Until a follow-up mounts `FrameioRows`, sign-in is only reachable through
  `work.frameio.signIn`/`finish` on the wire.
- No screen of its own to browse Frame.io: an agent browses and opens with
  the tools. The held post shows in the Outbox's generic view.
- A rendition is downloaded whole before it plays; a long 4K cut takes as
  long as its download.
- `comment.deleted` cannot be read back, so every open item of the account
  reads its comments again; a busy workspace costs a few calls per event
  even for files nothing watches.
- An upload that fails after its bytes went (the status wait, the move)
  leaves the file loose in the folder, and a second press uploads again.
- Whether Adobe's Native App credential takes an `http://127.0.0.1`
  redirect at all (the live test's first step).
- Ids an agent passes are checked to be ids (`seg` in `api.ts`) before they
  enter a path.
