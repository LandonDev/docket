# tc-computer on Windows

The computer-use service on a Windows host: the wire of docs/computer-protocol.md over UI
Automation. §29 there is its account.

- `src/generated/` is written by `bun scripts/gen-rust-computer.ts` from src/shared/computer; never edit it.
- `src/server.rs` (framing, admission, cancel, exits), `src/service.rs` (the methods), `src/locks.rs`,
  `src/book.rs` (element indices), `src/text.rs` (the observation) are platform-free: `cargo test` runs
  them on the box against a fake desktop (`tests/wire.rs`), and `tests/fixtures.rs` round-trips every
  wire fixture through the generated types.
- `src/platform/windows.rs` is the desktop over UI Automation: apps, the tree, the `ax` tier.
- Build: `bun scripts/build-tc-computer-win.ts` (cargo-xwin, x86_64-pc-windows-msvc, the CRT linked in).
- Proof in the rig: `bun scripts/e2e-computer-win.ts`.
