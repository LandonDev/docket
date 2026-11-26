import type { ReactNode } from "react";
import { formatReleaseDate, NO_RELEASE_NOTES, releaseNotesTitle } from "../lib/releaseNotes";
import { listedNotes, presentReleaseNotes, type ReleaseNotesPresentation } from "../lib/releaseNotesParse";
import { AgentMarkdown } from "../surfaces/AgentMarkdown";
import { Modal } from "./Modal";

type Props = {
  version: string;
  /** Notes from the update feed for a version this build does not bundle. */
  markdown?: string;
  onClose: () => void;
};

/**
 * Use the running build's notes by default. Feed notes with a changelog
 * heading drop that heading. Plain notes show as written, or as a list when
 * they are commit subjects joined by "; " (`listedNotes`).
 */
function resolveNotes(
  version: string,
  markdown?: string,
): ReleaseNotesPresentation | null {
  if (markdown == null) return presentReleaseNotes(version);
  return (
    presentReleaseNotes(version, markdown) ?? {
      version,
      date: null,
      markdown: listedNotes(markdown),
    }
  );
}

export function WhatsNewBody({
  version,
  markdown,
}: {
  version: string;
  markdown?: string;
}) {
  const notes = resolveNotes(version, markdown);
  const title = releaseNotesTitle(version);

  return (
    <article aria-label={title} className="px-5 py-4">
      {notes?.markdown ? (
        <AgentMarkdown
          className="whats-new-md"
          text={notes.markdown}
          streaming={false}
        />
      ) : (
        <p className="text-sm text-muted-foreground">{NO_RELEASE_NOTES}</p>
      )}
    </article>
  );
}

/** The frame's one line: the release in medium weight, then its date
 *  regular and muted 4px after it (docs/DESIGN.md "Typography"). */
export function whatsNewLine(version: string, date: string | null): ReactNode {
  return (
    <span className="flex min-w-0 gap-1">
      <span className="font-medium text-foreground">Release {version}</span>
      {date ? <span data-release-date>{date}</span> : null}
    </span>
  );
}

export function WhatsNewDialog({ version, markdown, onClose }: Props) {
  const notes = resolveNotes(version, markdown);
  const date = notes?.date ? formatReleaseDate(notes.date) : null;

  return (
    <Modal
      onClose={onClose}
      title="What's new"
      description={whatsNewLine(version, date)}
      size="md"
      className="max-h-[min(72vh,640px)]"
    >
      <WhatsNewBody version={version} markdown={markdown} />
    </Modal>
  );
}
