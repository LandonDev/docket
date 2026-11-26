import { KNOWN_APP_NAMES } from "@shared/appName";
import { BUNDLED_RELEASE } from "./bundledRelease";
import type { ReleaseNotesDocument, ReleaseNotesTabSource } from "./releaseNotes";

/* What's New and the release notes tab use the running build's notes.
   The parser also accepts a Keep a Changelog section from the update feed. */

function bundledReleaseMarkdown(): string {
  return `## [${BUNDLED_RELEASE.version}] - ${BUNDLED_RELEASE.date}\n\n${BUNDLED_RELEASE.notes}`;
}

export function releaseNotesForVersion(
  version: string,
  changelog?: string,
): ReleaseNotesDocument | null {
  const normalized = version.trim();
  if (!normalized || normalized === "Unreleased") return null;
  if (changelog === undefined) {
    return normalized === BUNDLED_RELEASE.version
      ? { source: { version: normalized }, markdown: bundledReleaseMarkdown() }
      : null;
  }

  const escapedVersion = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(
    `^## \\[${escapedVersion}\\](?: - \\d{4}-\\d{2}-\\d{2})?\\r?$`,
    "gm",
  );
  const match = heading.exec(changelog);
  if (!match) return null;

  const nextHeading = /^## /gm;
  nextHeading.lastIndex = match.index + match[0].length;
  const next = nextHeading.exec(changelog);
  const markdown = changelog.slice(match.index, next?.index).trimEnd();

  return {
    source: { version: normalized },
    markdown,
  };
}

export function releaseNotesMarkdown(
  source: ReleaseNotesTabSource,
  changelog?: string,
): string | null {
  return releaseNotesForVersion(source.version, changelog)?.markdown ?? null;
}

export type ReleaseNotesPresentation = {
  version: string;
  date: string | null;
  markdown: string;
};

/** Changelog body for the What's new modal: version heading lives in the chrome. */
export function presentReleaseNotes(
  version: string,
  changelog?: string,
): ReleaseNotesPresentation | null {
  const release = releaseNotesForVersion(version, changelog);
  if (!release) return null;

  const escapedVersion = release.source.version.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const heading = new RegExp(
    `^## \\[${escapedVersion}\\](?: - (\\d{4}-\\d{2}-\\d{2}))?\\r?\\n*`,
  );
  const match = heading.exec(release.markdown);

  return {
    version: release.source.version,
    date: match?.[1] ?? null,
    markdown: listedNotes(
      match ? release.markdown.slice(match[0].length).trimStart() : release.markdown,
    ),
  };
}

/** How many of a release's commit subjects What's New lists before "and N more". */
export const NOTES_LISTED = 20;

/**
 * A release cut by scripts/release.ts carries every commit subject since the
 * last one, joined by "; " into one paragraph. Notes with no heading or list
 * of their own and more than one such part become a list, led without the
 * old "Core" marker under either of the app's names, cut at NOTES_LISTED with
 * "and N more". Notes written as markdown pass as they are.
 */
/** The old releases' leading marker, under either of the app's names. */
const CORE_MARKER = new RegExp(`^(${KNOWN_APP_NAMES.join("|")}) Core;\\s*`);

export function listedNotes(markdown: string, cap = NOTES_LISTED): string {
  const text = markdown.trim();
  if (/^\s*(#|[-*+] |\d+\. )/m.test(text)) return text;
  const body = text.replace(CORE_MARKER, "");
  // A subject's own "; " stays inside it: where subjects end with a stop,
  // only "; " after one parts them.
  const joint = /[.!?];\s/.test(body) ? /(?<=[.!?]);\s+/ : /;\s+/;
  const parts = body
    .split(joint)
    .map((part) => part.trim().replace(/;$/, ""))
    .filter(Boolean);
  if (parts.length < 2) return parts[0] ?? "";
  const rest = parts.length - cap;
  const listed = rest > 0 ? parts.slice(0, cap) : parts;
  const items = listed.map((part) => `- ${part}`).join("\n");
  return rest > 0 ? `${items}\n\nand ${rest} more` : items;
}
