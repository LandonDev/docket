// Fixtures for `bun run ui:preview src/renderer/src/chrome/CommandPopover.preview.tsx#SlashMenuPreview`.
// Static capture shows the visible rows. Typing and keyboard selection need interaction.
import { previewSession } from "../lib/previewHost.preview";

const cmd = (name: string, description: string, source: string, scope = "user") => ({ name, description, source, scope });

export default [
  {
    name: "The slash menu open on /re",
    props: {
      active: 0,
      matches: {
        mode: "command",
        rows: [
          cmd("review", "Review the current diff for correctness bugs", "command"),
          cmd("release", "Cut and publish a release", "command", "project"),
          cmd("refactor", "Restructure code without changing behaviour", "skill"),
          cmd("research", "Investigate a question across the codebase", "skill"),
        ],
      },
    },
  },
  { name: "No match on /zzz", props: { active: 0, typed: "/zzz", matches: { mode: "command", rows: [] } } },
  { name: "Commands could not load", props: { active: 0, typed: "/", matches: { mode: "command", rows: [], failed: true } } },
  {
    name: "Files, threads and notes",
    props: {
      active: 1, typed: "@notes",
      matches: { mode: "file", rows: [
        { kind: "file", file: { name: "notes.ts", path: "/projects/field-notes/src/notes.ts", relative: "src/notes.ts" } },
        { kind: "thread", session: previewSession({ id: "preview-at-thread", title: "Speed up the notes list" }) },
        { kind: "note", file: { name: "Notes for the next release", path: "release-notes", relative: "Notes for the next release" } },
      ] },
    },
  },
  { name: "An @ while the project's files are read", props: { active: 0, typed: "@", matches: { mode: "file", rows: [], loading: true } } },
];
