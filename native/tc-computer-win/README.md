# tc-computer on Windows

The computer-use service on a Windows host: the wire of docs/computer-protocol.md over UI
Automation. §29 there is its account.

- `src/generated/` is written by `bun scripts/gen-rust-computer.ts` from src/shared/computer; never edit it.
- `src/server.rs` (framing, admission, cancel, exits), `src/service.rs` (the methods), `src/locks.rs`,
  `src/book.rs` (element indices), `src/text.rs` (the observation) are platform-free: `cargo test` runs
  them on the box against a fake desktop (`tests/wire.rs`), and `tests/fixtures.rs` round-trips every
  wire fixture through the generated types.
- `src/input.rs` (key combos, text pieces, the coordinate space, which tier expresses a step), `src/capture.rs`
  (shot geometry, scaling, blank and flat, the stream's gate, shot names), `src/clip.rs` (HTML Format, markdown),
  `src/act.rs` (the event tiers, the session hold, paste, screenshots) and `src/stream.rs` (the preview stream) are
  platform-free too; `tests/input.rs` drives them over a fake that records what is posted.
- Live video (§30, "The Windows service"): `src/video/` (the records, the pacer and the still window, Annex B, the
  picture size and NV12, the pipe's threads, and the streams over the desktop's `WindowCapture` and `VideoEncoder`)
  and `src/flow.rs` (screen-relay's flow controller) are platform-free; `tests/video.rs` drives the calls over a fake
  desktop and an in-memory pipe. `src/platform/video.rs` is Windows': the named pipe, Windows.Graphics.Capture (else
  PrintWindow on a timer), the Media Foundation H.264 encoder, and the door's pipe (`pipe_server`, `poke`).
- `src/platform/windows.rs` is the desktop over UI Automation: apps, the tree, the `ax` tier; `src/platform/io.rs`
  is input (posted messages, SendInput, the foreground), the person watch (low-level hooks), capture (PrintWindow,
  WIC), the clipboard and launching.
- `src/door.rs` is `serve --listen ADDR --token-file FILE` (§29.1): loopback only, the token as the first line, one
  host at a time, a bytes connection for video; platform-free, `tests/door.rs` drives it over loopback sockets.
  main.rs gives each host a fresh `serve` child.
- Build: `bun scripts/build-tc-computer-win.ts [--into DIR]` (cargo-xwin, x86_64-pc-windows-msvc, the CRT linked in).
- Proof in the rig: `bun scripts/e2e-computer-win.ts` (`--legs video` for live video alone), and `TC_WIN_RIG=1` for `src/main/server/computer/winRig.hold.test.ts`.
