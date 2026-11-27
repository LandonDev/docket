import { Bone, Bones } from "../../components/bones";

/** What the page's bones are drawn from (docs/agents/loading-bones.md "Samples"): a meeting's title and time, and its people. */
const SAMPLE_TITLE = "Launch review with Starboard Games";
const SAMPLE_WHEN = "Thursday, Nov 27 · 2:00 – 3:00 PM";
const SAMPLE_PEOPLE = ["Dana Lee", "Omar Haddad", "Priya Raman"];

/**
 * The page's bones, at its own insets and in its type: the title and its line, then the people, which every page has.
 * Drawn from sample words in the page's own classes (PrepView.tsx `PrepPageBody`, `PersonRow`), since the frame draws
 * them while the view's chunk is still on its way (work/shell/WorkViewPage.tsx `bones`), and the page's own wait draws
 * the same. What only some pages have (a brief, tasks, files) is left out.
 */
export function PrepSkeleton() {
  return (
    <Bones label="Loading the meeting's page">
      <div className="mx-auto w-full max-w-[720px] ps-7 pe-6 py-6">
        <header className="flex flex-col gap-0.5">
          <h1 className="text-base leading-6 font-semibold tracking-[-0.01em] text-foreground">{SAMPLE_TITLE}</h1>
          <p className="text-xs text-muted-foreground">{SAMPLE_WHEN}</p>
        </header>
        <section className="mt-6">
          <h2 skullet-own="" className="mb-1 text-xs font-medium text-muted-foreground">
            People
          </h2>
          {SAMPLE_PEOPLE.map((name) => (
            <div key={name} className="-mx-2 flex min-h-8 items-center gap-2 border border-transparent px-2 py-1.5 text-[13px] leading-5">
              <Bone className="-my-0.5 size-6 self-start rounded-full" />
              <span className="truncate text-foreground">{name}</span>
            </div>
          ))}
        </section>
      </div>
    </Bones>
  );
}

/** The lines of a brief or an outcome on its way, at the reading measure and the brief's own type. */
const SAMPLE_LINES = ["The store page still says early access, and launch is in two weeks.", "Dana wants the crash numbers for the last three builds.", "Key art for the launcher is due Thursday."];

/** Where what a thread is writing will land: its lines drawn from a sample in the brief's type (PrepView.tsx `Words`). */
export function TextBones({ label }: { label: string }) {
  return (
    <Bones label={label} className="mt-4">
      <div data-writing={label} className="flex max-w-[65ch] flex-col gap-2 text-sm leading-[22px] text-foreground">
        {SAMPLE_LINES.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
    </Bones>
  );
}
