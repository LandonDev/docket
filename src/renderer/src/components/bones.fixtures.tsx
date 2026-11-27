// bun run ui:preview src/renderer/src/components/bones.fixtures.tsx#BonesOf --shot --fresh
// The loading bones (docs/agents/loading-bones.md): a list drawn from a sample beside the same list loaded, so a
// bone can be seen to stand where its words land; then the bone on each ground it lies on.
import { FileText } from "@renderer/chrome/icons";
import { Bone, Loaded, Region } from "./bones";

type Note = { id: string; title: string; line: string; when: string };

/** A sample is a fixed literal shaped like real work: nobody reads the words, their lengths give the bones their shape. */
const SAMPLE_NOTES: Note[] = [
  { id: "sample:1", title: "Release notes for the next build", line: "What changed, and what to check first", when: "2h" },
  { id: "sample:2", title: "Call with the box's host", line: "Three things to ask about the tunnel", when: "5h" },
  { id: "sample:3", title: "Ideas for the rail", line: "Fewer rows, the same reach", when: "1d" },
  { id: "sample:4", title: "Reading list", line: "Two papers and a long thread", when: "3d" },
];
const NOTES: Note[] = [
  { id: "n1", title: "Skullet across Docket", line: "One bone for each line of text, glyph and block", when: "now" },
  { id: "n2", title: "The held list", line: "A line a folder, emptied as each is converted", when: "1h" },
  { id: "n3", title: "What looks different in dark", line: "The sweep, the shapes and the reveal", when: "4h" },
  { id: "n4", title: "Proof", line: "Light and dark, the shell and one list", when: "1d" },
];

/** The piece both the bones and the content are drawn from. */
function NoteRows({ notes }: { notes: Note[] }) {
  return (
    <ul className="flex flex-col gap-0.5 p-1">
      {notes.map((note) => (
        <li key={note.id} className="flex items-start gap-2 rounded-md px-2 py-2">
          <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="truncate text-[13px] leading-5 text-foreground">{note.title}</p>
            <p className="truncate text-xs leading-4 text-muted-foreground">{note.line}</p>
          </div>
          <time className="shrink-0 text-xs leading-5 text-muted-foreground">{note.when}</time>
        </li>
      ))}
    </ul>
  );
}

export function BonesOf({ what, ground, on }: { what: "list" | "loaded" | "ground"; ground?: string; on?: "stage" | "matte" }) {
  if (what === "ground") {
    return (
      <div className={`grid h-28 place-items-center ${ground}`}>
        <Region loading hold={0} on={on} bones={<Bone className="h-16 w-48" />} />
      </div>
    );
  }
  return (
    <div className="w-80 rounded-xl border border-border bg-card">
      <Loaded data={what === "loaded" ? NOTES : null} sample={SAMPLE_NOTES} hold={0} label="Loading notes">
        {(notes) => <NoteRows notes={notes} />}
      </Loaded>
    </div>
  );
}

export default [
  { name: "a list, waiting: its rows drawn from a sample", props: { what: "list" } },
  { name: "the same list, loaded", props: { what: "loaded" } },
  { name: "a block on the page", props: { what: "ground", ground: "bg-background" } },
  { name: "a block on stage", props: { what: "ground", ground: "bg-(--stage)", on: "stage" } },
  { name: "a block on matte", props: { what: "ground", ground: "bg-matte", on: "matte" } },
];
