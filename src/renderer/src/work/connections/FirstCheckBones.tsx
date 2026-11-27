import { Bones } from "../../components/bones";
import { PageRow, PageSection } from "../../components/page";
import { StatusMark } from "../../components/ui/status";

/**
 * A row's state line as a block in the description, its detail wrapping: a narrow window cuts none of the fix's words.
 * The glyph keeps the word's first 16px line (1px over its 14px), never the middle of a wrapped block. Here, so the
 * bones draw the line the page's rows do without loading the page.
 */
export const STATE_LINE = "flex [&>[data-slot=status-detail]]:whitespace-normal [&>[data-slot=status-glyph]]:mt-px [&>[data-slot=status-glyph]]:self-start";

/** Six connections of one section, in the shape the page's rows take: a title, then its state and its line. Only their
 *  lengths count, so no word here is a state line's (lib/stateLinesGuard.test.ts). */
const SAMPLE_ROWS = [
  { title: "LifeOS", line: "maya.chen@example.com" },
  { title: "Microsoft 365", line: "Purdue University, its own sign-in" },
  { title: "Office add-in", line: "Two add-ins paired" },
  { title: "Google", line: "maya.chen@example.com" },
  { title: "Teams files", line: "3 libraries" },
  { title: "Windows VM", line: "Stopped, its disk is kept" },
];

/**
 * Connections before its first answer, and its chunk on the way (surfaces/SettingsView.tsx): a section's heading over
 * six rows drawn from a sample, so the first section lands where they stood. Most rows have no press, so the bones draw
 * none. A file of its own, so the settings chunk draws them without loading the page.
 */
export function FirstCheckBones() {
  return (
    <Bones label="Checking connections">
      <PageSection title="Microsoft">
        {SAMPLE_ROWS.map((row) => (
          <PageRow key={row.title} title={row.title} description={<StatusMark className={STATE_LINE} state="done" word="Working" detail={row.line} still />} />
        ))}
      </PageSection>
    </Bones>
  );
}
