# The phone in light: what was checked, and what is left

The phone was checked in light, not redesigned (the plan of 2026-11-19).
A helper on the Mac ran the simulator proof's shell, threads and work sets
headless on an iPhone 17 Pro (iOS 27.0) and read the 66 light shots; ratios
are measured from the PNGs. Work screens 30 to 46 were read from a sheet of
thumbnails, not one by one: they showed only the patterns below, and a small
item on one of them could have been missed. Floors: text 4.5:1, a glyph 3:1.

## Fixed

Row 12. `Tint.warningText` and `Tint.destructiveText`
(ios/TempCode/Sources/Design/Tokens.swift) were the system's
increased-contrast orange and red in light, which measure 4.1:1 on
`Surface.group`, under the 4.5:1 their own comment claimed. Light is now a
step darker (`#b04a00`, `#c8102e`: 4.9:1 and 5.3:1 there). Dark keeps the
system's. Parse-checked on the box; not built or shot again.

The Outbox's band headers (w50; Work/OutboxScreen.swift `BandHeader`). The
workspace name and the count used the hierarchical meta and stamp steps,
which inside a list's section header nest under its dimming: 1.7:1 and
1.3:1 on `Surface.chrome` in light. Both now draw in `Color(.label)` through
`textStep`'s `tint`, keeping their two type steps (meta semibold, stamp):
18.8:1 in light and 17:1 in dark on the chrome fill. `secondaryLabel` would
measure only 3.3:1 there in light. Rows 3 and 13 (the stamp and meta steps
everywhere else) stay the owner's call. Parse-checked on the box; not shot.

## Left for the owner

The rest comes from three things, and each is a design choice about the
phone's light look, not a slip in one value:

- **Apple's own label roles.** `TextStep.meta` is the system's secondary
  label (3.2:1 to 3.9:1) and `TextStep.stamp` its tertiary (1.7:1 to 1.8:1):
  rows 1 to 7 and 13. A fix is a light value for each step (`#636366`,
  `#6e6e73`), which flattens the two steps toward each other.
- **A status word in a fill's colour.** Words and counts drawn in
  `Tint.success`, `.warning`, `.info` and `.destructive` (the system's green,
  orange, blue and red): rows 8 to 11, 14, 16 and 18. A fix is a text tint
  beside each fill tint, as warning and destructive already have, and its use
  where the colour is a word.
- **Shared values.** The Purdue sector dot (row 17) is LifeOS's hue, as on
  the desktop, where it is a named exception. The accent (row 19) is the
  system's blue. Rows 20 to 22 are in work-kit, which this work did not touch.

One check in the work set failed that is not a colour: "Away went on and off
from the phone (never on)". The slides check did not run (no python-pptx on
the Mac).

## The findings

Paths are under ios/TempCode/Sources. "Smallest fix" is the helper's; each
changes light only.

| # | Shot | Element | Ink / ground | Ratio | Source (current) | Smallest fix |
|---|---|---|---|---|---|---|
| 1 | orch-*, impl-board | model mark "low"/"High" | #dfdfdf / #fff | 1.33 | Thread/Master/MasterStyles.swift:92 `.foregroundStyle(.secondary)` nested in `.textStep(.stamp)` = quaternary | drop the nested `.secondary` (and see #3) |
| 2 | orch-fleet, impl-board | section count "3/3", "2" | #d7d7dc / #f2f2f7 | 1.29–1.70 | Design/LiveText.swift CountText → .stamp, in SectionHeader | follows #3 |
| 3 | every shot | stamps (4m, 5m), repo, host, env ids, model, branch, search footer, diff path and line numbers, settings version, task counts "1/3" "0 of 2", chevrons | #bfbfbf–#c5c5c7 / #fff or #f2f2f7 | 1.70–1.84 | Design/Tokens.swift:162 `TextStep.stamp` = `.tertiary`; also `Color(.tertiaryLabel)` at Design/ThreadRow.swift:95, Shell/SearchRowViews.swift:127, Shell/InboxStore.swift:134, Hosts/HostDot.swift:31 | stamp step in light: #6e6e73 (5.07 on #fff, 4.54 on #f2f2f7); dark keeps tertiaryLabel |
| 4 | orch-fleet, impl-board | section header "Running", "Waiting", "Changes" | #bbbbc1 / #f2f2f7 | 1.71 | Design/SectionHeader.swift:23 `.textStep(.meta)` drawn dimmed on Surface.chrome | same token as #3 for the header title |
| 5 | archived | branch "master" in header | #e2e2e3 / #fff | 1.29 | Design/SectionHeader.swift:31 `.tertiary` | follows #3 |
| 6 | 07, 07b, every thread shot | composer "This key can read but not act" | #c1c1c3 / #fff | 1.75 | Thread/Composer.swift:553 reason passed as TextField `prompt` | draw `blocked` as `.textStep(.meta)` Text, keep placeholder for the empty draft only |
| 7 | 01b | shelf chip "Master" | #b9b9bb / #eeeeef | 1.69 | shelf chip label, tertiary | follows #3 |
| 8 | 03, 03b | status words: "Approved" green, "Changes requested" orange, "Your review" blue, "Checks failing" red | #34c759, #ff8d28, #0088ff, #ff383c / #fff | 2.22, 2.31, 3.52, 3.57 | Shell/InboxStore.swift:129–133 tone → Tint.success/.warning/.info/.destructive (Tokens.swift:11–17) | add `successText` (#1e7b34) and `infoText` (#0066cc, 5.0 on #f2f2f7) and use the *Text tints for words |
| 9 | orch-fleet | "Waiting for approval" on needs-you band | #ff8d28 / #fff6ee | 2.16 | Tint.warning on Surface.needsYou (Tokens.swift:15, 47) | Tint.warningText |
| 10 | 03c, impl-board, chat-chip, orch-fleet | diff counts "+16" "+140" "+12", "+" sign | #34c759 / #fff or #f2f2f7 | 1.95–2.22 | Thread/DiffStyles.swift:83 DiffPalette uses Tint.success | `successText` light #1e7b34 (5.3 on #fff, 4.8 on #f2f2f7) |
| 11 | 03c | diff "−6", "−" sign | #ff383c / #f2f2f7 | 3.12–3.20 | DiffStyles.swift DiffPalette uses Tint.destructive | Tint.destructiveText |
| 12 | 01b | card "Done:…" and "…hit its 5-hour limit" | #c55300, #e9152d / #f2f2f7 | 4.08 | Tokens.swift:27–28 `legible()`; comment claims 4.5 on group | darker light values: #b04a00, #c8102e (4.9 and 5.3 on #f2f2f7) |
| 13 | 01, 01b, 03, 03c, 05, chat-chip, orch-fleet, impl-board | secondary text on #f2f2f7 / #fff: Home status card, workspace titles, inbox notice, settings footers, "Lines 118–143", "Orchestrating", "5m 13s", done task titles, error card body | #79797b–#8a8a8e | 3.24–3.89 | system `.secondary` (TextStep.meta, Tokens.swift:161) | meta step in light: #636366 (5.9 on #fff, 5.3 on #f2f2f7) |
| 14 | 01, 01b, 03, impl-board, chat-chip | glyphs: green task glyph, check marks, orange dot and pause, progress bar fill | #34c759, #ff8d28 / #fff or #f2f2f7 | 1.99–2.31 | Tint.success/.warning (Tokens.swift:13, 15) | success and warning glyphs use the *Text tints in light |
| 15 | 01, archived, orch-fleet | quiet/asleep dot, queued ring, spinner | #aeaeb2, #a4a4a7 / #fff | 2.21–2.49 | Tint.quiet = systemGray2 (Tokens.swift:23); spinner default tint | Tint.quiet light → #7c7c80 (4.2 on #fff, 3.7 on #f2f2f7) |
| 16 | impl-board | pass dot | #10b981 / #f2f2f7 | 2.27 | pass colour from data, Thread/BoardStyles.swift:27 | darken pass hues in light by 20% lightness |
| 17 | w01-home | Purdue sector dot | #be9946 / #fff | 2.68 | Work/WorkStyles.swift:18 purdue light (0.744, 0.599, 0.275) | light (0.627, 0.498, 0.184) = #a07f2f, 3.77; dark unchanged |
| 18 | w03, w08, w15 | "Discard" button | #ff383c / #fcfcfc | 3.48 | Work/OutboxItemScreen.swift:239 `Button(role: .destructive)` (system red) | `.foregroundStyle(Tint.destructiveText)` |
| 19 | w15, w16 | accent text "Undo"; white on "Post"/"Send" | #007aff / #fff | 4.02 | Assets.xcassets/AccentColor.colorset light (0, 0.478, 1) | light (0, 0.4, 0.8) = #0066cc, 5.6; dark entry unchanged |
| 20 | w22 | mail avatar initials | #686868 / #d1d1d1 | 3.65 | work-kit swift/Sources/LifeKitUI/Kit/PersonAvatar.swift:33 `.secondary` on `.quaternary` | light #545456 (4.95), in work-kit |
| 21 | w23 | mail sector menu "Purdue" | #7fbcff / #fff | 1.99 | work-kit swift/Sources/LifeKitUI/Mail/ThreadView.swift:113 `.secondary` in a Menu label = secondary of the accent | `Color(.secondaryLabel)`, in work-kit |
| 22 | w27 | task open circle; overdue "Yesterday" | #bfdeff, #ff383c / #fff | 1.39, 3.57 | work-kit Kit/TaskRow.swift:88 `.tertiary` in a Button; :135 `Color.late` | `Color(.secondaryLabel)` glyph; late = destructiveText |

Near misses, still under 4.5 for text: "Worked for 1s", "Implementation", "Off", off house rule (w20, Work/HouseRulesScreen.swift:84), read mail senders (w21, w22) #7f7f7f / #fff at 4.00 (fixed by #13).
