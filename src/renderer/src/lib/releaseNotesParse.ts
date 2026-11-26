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
    markdown: match
      ? release.markdown.slice(match[0].length).trimStart()
      : release.markdown,
  };
}
