# Files and editors plan review

Revise the plan before the build starts. I read the six reports, the project rules and SEAMS. Plan line numbers refer to `.temp-code/plan-cBclQIRDtvVS.md`. Code checks use master `34b350f24`. The explorers used `b8d2a44f7`.

## P0 · Hold, fence and save truth

1. **M1 and M6, lines 198–223 and 321–324. Land the hold fix before any linked-save change.** Draining a private agent write can put its unapproved result in the first export. Reserve the shared state before export. Bind text and formatting commits to that state. If an agent write already landed, require review of the resulting revision before publishing it. Keep the hold on migrated Word documents, their old paths and recovered drafts. Keep existing exact-request checks. Also cover the audit's other C1 case at lines 314–318. Bind held Drive and VM mutations to the reviewed file and destination at the holder, or refuse when the provider cannot prove them. [Audit C1, lines 177–183]

2. **M4, lines 270–279 and 296. Preserve the host checks behind the new buttons.** Row and bulk Download and Quick Look must use the same authorized read or copy routes as an open tab. A far shared original has no direct Download under `acts.ts:350–371`. Keep the button unavailable there unless an existing copy route can serve it. Fix the stray stat call at its caller. For Teams templates, use the existing Files create door with the owner's press and an admitted destination. The template API currently restricts placement to the workspace and refuses a model or peer on shared writes. Keep that refusal. Test both a read-only key and an agent caller. [Files place 3, 4 and 14]

3. **M3 and M11, lines 150–151, 163–164, 234–249 and 382–390. Separate dirty, durable and uploaded.** Resolve the conflict between “Saving… while frames are unsent” and “only after 600 ms in flight.” While edits wait, use a draft word or a clearly marked prior save time. ⌘S starts a flush. Only its matching receipt can advance Saved. If Word needs his Save to Teams press, say so. Put the holder-side receipt work in the first correctness batch. Until the VM and OneDrive can confirm the same bytes, show the disk receipt or unknown. A path-level in-sync flag cannot support In Teams. [Audit A2, lines 99–107]

4. **M2, lines 168–169 and 225–231. Journal during editing.** A write made at quit cannot survive a crash before quit. Define the record key by workspace, holder, file identity and base. Isolate the store from sync folders, guest pages and agent tools. Readmit on recovery and bind Retry to the owner and destination. Keep drafts on refusal. Land the store and text path first, then add sheet, deck and doc adapters in separate slices. Prove abrupt exit, tab switch and second-window close with two pending edits, plus a changed base. [Audit A3, lines 109–113]

5. **M7 and M10, lines 159–160, 174–175, 346–347 and 375–380. Keep the boundary on sharing and Word rendering.** “Share in Teams” should open a verified, tenant-bound file page. A local copy or unknown address gets the existing refusal. Check in Word changes the current shared-file rule in `work-docs.md:506`. Require an owner press and prove the approved tenant and actual holder at dispatch. The box and its VM are distinct for this check. Keep the LibreOffice view if no eligible renderer is ready. The local Purdue rule also applies to recovery, search and previews. Use dummy data and the approved tenant and tools. “Switch Anyway” must keep the current seat or a recoverable draft when sync is uncertain. Use a confirmation for Revoke. Undo would make an old address usable again. [Docs/PDF/media B2, L4, L9 and L17]

## P1 · Put daily work and data loss first

6. **M0 and M3, lines 189–192 and 243–245. Keep J24 as a failing product test.** Waiting 5.5 seconds proves the notice after a fresh read. It hides the stale folder that the owner sees when his Purdue laptop drops off. Revalidate the visible far folder on a holder reach change or a short bounded refresh. Preserve the cached rows with their age and the actual holder name. Add a laptop-online, mapped-drive-away case beside the whole-host drop. [Journeys J24, lines 62–80]

7. **M1 and M6, lines 203–225 and 309–329. Fix recovery and destructive races before general polish.** Move the SharePoint exception, Trash's edit watermark, live handoff and workbook conflict recovery ahead of M4. Add the missing C2 cases to the save and move slices. Keep the copy record on a failed read or a concurrent final write. Preserve the source if a cross-volume move cannot establish that its files are still the ones copied. Bind Reload to the version in its question. [Audit B1, B3–B7 and C2]

8. **M3–M9, lines 250–259 and 300–373. Move common editor fixes forward.** Put sheet Preview, deck stage and cursors, editable notes, and live Word's 25–35 second reload fix next to room and first paint. Move video stall and scrub feedback there too. Promote formula-bar commit before reload to M2, and ship sheet Find before Freeze and tab reorder. Add a deck Find task or mark its deferral. Add Fit and zoom acceptance for the full stage, and a VM-window action when the app presents there and that route exists. Give the workspace-column fold a named handoff to the sister plan. [Sheets/decks S2, S7, D1–D3 and D15. Docs/PDF/media L3 and M1–M2. Window walk 6–8]

9. **M3–M10, lines 156–158, 266, 275, 290, 305 and 367–380. Close the smaller gaps explicitly.** Item 20 promises Escape on narrow History but has no task. Item 31 still needs a short one-folder Move dialog and a ruling on Reload versus Keep Both. Keep ⌘P as Print in a focused editor that handles it. Go to owns it in the Files browser. Add the name-only coverage case to content search so a VM library with no content index reports its limits. [Files place, lines 145–157 and 297–302. Window walk 12. Work-editors keyboard rules]

## P1 · Decisions and slice size

10. **Decisions 3, 4 and 16, lines 145–149, 172–173 and 221–223. Preserve backups, choices and attribution.** Split the Word store migration from backup suppression. Keep old files through restart and read-back and classify every old and new record as shared. Skip a backup only with proof of an unchanged package at the holder. Keep existing per-file autosave choices and use an explicit opt-in for others. Bound the author change to files the owner writes through the editor. Preserve original authors and leave the modifier unset if the workspace account is unknown. Move the Word metadata fix ahead of general workbook features. The walk saw the bad name on every Word edit.

11. **Decision 15 and M1, lines 170–171 and 195–200. Preserve identifiers and supported formats.** Fix plain typed numbers at the input boundary. Keep explicit text and rich runs, and avoid guessing dates or coercing leading-zero IDs. Test real typed numbers, text, formulas and ambiguous dates on each writer. Save As can default to the original format when that writer exists. The list has no legacy binary .doc writer. Name the .docx fallback and keep an edited copy if the original folder is unavailable. [Sheets audit C3. `src/shared/work/saveAs.ts:9–18`]

12. **M0, M4, M6–M9 and M13, lines 125–133, 183–192 and 261–373. Give the builder smaller landings.** Baseline each surface as it comes up so all preview fixtures and five new failing journeys do not delay the first fix. Split M4 by verb, M6 by writer or holder, and M7/M8 by editor. Name the first test and the safe fallback for each. Split required kit fixes from the power features while keeping a planned pin. Fix the council's exit rule. If Sol is absent, record the missing score and leave that surface unscored. A rare loss or approval fault still blocks completion.

## P1 · Running threads and proof rules

13. **iPhone, lines 96–100, 203–208, 325–327, 378–379 and 414–415. Agree who lands the schema and generated Swift together.** The generator writes under `ios/`, which this plan excludes. Optional fields still change generated types and client behavior. Test older clients that omit a Replace version. The host should return a fresh conflict. Claim the real host overlap too, especially Sheets held edits and guest attempts. Reuse the rekey attempt support on master `34b350f24`. Leave hosted guest pages with the phone build. [SEAMS, lines 247 and 254]

14. **VM and queue, lines 51–67, 88–92, 101–102 and 382–392. Update the proof instructions.** SEAMS records the VM screen build landed at `895abd77dc`. Its deployment and release are separate. The listed `e2e-box-vm-edit.ts` targets the deployed box on port 7677 and its real VM OneDrive even though its Electron window has a scratch `WINVM_DIR`. Use an isolated host and VM with explicit endpoints and a dummy folder, under a fresh `VM YES`. Follow the scratch-overlay, load and teardown rules. Until then, leave native and cloud proof open. Use `heavy --tc` for typecheck and queue heavy proofs. Stop only owned PIDs. Keep the dark guard, the renderer formatter ban and the Mac live-go-ahead rule.

## Six code spot checks

| Plan line | Code | Result and change |
| --- | --- | --- |
| 195 | `sheets/mutations.ts:120–144` | Rich runs take the literal path where supported. Other paths can refuse rich text. Fix the plain typing packet and test both writers. |
| 198 | `files/verbs.ts:307–316`, `files/policy.ts:48–56,159–161`, `files/copies.ts:539–549` | The post-create lookup is real. The exact cached-miss cause is unproved. Inject a lookup failure and keep the holder's creation receipt and operation ID. |
| 201 | `slides/edit/TypingBox.tsx:189–193`, `edit/session.ts:407–415` | Escape cancels the box, timer and failure. Put the keep path in the handler and test a failed save. |
| 234 | `work/docs/host.ts:358–389` | Line 386 requests durable storage. It supplies no stored time for the status line. Add revision-bound acknowledgement evidence. |
| 245 | `files/store.ts:1258–1281`, `files/farLink.ts:39–47` | Cache reuse and lack of far pushes both hold. Test a folder left open through a holder drop. |
| 321 | `docs/tools.ts:163–172,193–204`, `files/saveAs.ts:196–211` | The private verdict predates the link write for text and formatting. Guard both commits and the first export. |

## Decisions made while you were away

- Tracked only this report under the ignored `.temp-code` directory so it could land through `merge_branch`.
