import { describe, expect, it } from "vitest";
import { formatReleaseDate, releaseNotesTitle } from "./releaseNotes";
import { presentReleaseNotes, releaseNotesForVersion, releaseNotesMarkdown } from "./releaseNotesParse";
import { BUNDLED_RELEASE } from "./bundledRelease";

const fixture = `# Changelog

## [Unreleased]

### Added
- Future work.

## [0.1.3] - 2026-09-01

### Fixed
- Newer fix.

## [0.1.2] - 2026-08-31

### Added
- Requested feature.

## [0.1.1]

### Fixed
- Older fix.
`;

describe("releaseNotesForVersion", () => {
  it("uses the running release's notes when no feed notes are given", () => {
    const { version, date, notes } = BUNDLED_RELEASE;
    expect(releaseNotesMarkdown({ version })).toBe(`## [${version}] - ${date}\n\n${notes}`);
  });

  it("uses the supplied feed notes even when the version matches the running release", () => {
    const { version } = BUNDLED_RELEASE;
    expect(presentReleaseNotes(version, `## [${version}]\n\nFeed notes.`)).toEqual({
      version,
      date: null,
      markdown: "Feed notes.",
    });
  });

  it("extracts only the requested release", () => {
    const release = releaseNotesForVersion("0.1.2", fixture);

    expect(release?.source).toEqual({ version: "0.1.2" });
    expect(releaseNotesTitle(release!.source.version)).toBe(
      "What's new in release 0.1.2",
    );
    expect(release?.markdown).toContain("## [0.1.2]");
    expect(release?.markdown).not.toContain("## [0.1.3]");
    expect(release?.markdown).not.toContain("## [0.1.1]");
  });

  it.each(["", "   ", "Unreleased", "9.9.9"])(
    "returns null for unavailable version %j",
    (version) => {
      expect(releaseNotesForVersion(version, fixture)).toBeNull();
    },
  );

  it("requires the heading to occupy the complete line", () => {
    const malformed = `## Prefix [0.1.2]\nNo.\n\n## [0.1.2] soon\nStill no.`;
    expect(releaseNotesForVersion("0.1.2", malformed)).toBeNull();
  });

  it.each(["## [0.1.2]\n\nUndated.", "## [0.1.2] - 2026-08-31\n\nDated.", "## 0.1.2\n\nBare.", "## v0.1.2 - 2026-08-31\n\nBare with v.", "## [v0.1.2]\n\nBracketed with v."])(
    "accepts supported heading %j",
    (changelog) => {
      expect(releaseNotesForVersion("0.1.2", changelog)?.markdown).toBe(
        changelog,
      );
    },
  );

  it("drops a bare version heading as it drops a bracketed one, so What's New says the version once", () => {
    expect(presentReleaseNotes("9.1.0", "## 9.1.0\n\n### Files\n\nThe viewer keeps your place.")).toEqual({
      version: "9.1.0",
      date: null,
      markdown: "### Files\n\nThe viewer keeps your place.",
    });
    expect(presentReleaseNotes("9.1.0", "## 9.1.0 - 2026-11-01\n\nNotes.")?.date).toBe("2026-11-01");
    expect(releaseNotesForVersion("9.1.0", "## 9.1.01\n\nNo.")).toBeNull();
  });

  it("extracts the final release through the end of the changelog", () => {
    const release = releaseNotesForVersion("0.1.1", fixture);
    expect(release?.markdown).toContain("Older fix.");
  });

  it("escapes the requested version before matching", () => {
    expect(
      releaseNotesForVersion("0.1.2+test", "## [0.1.2+test]\n\nExact."),
    ).toEqual({
      source: { version: "0.1.2+test" },
      markdown: "## [0.1.2+test]\n\nExact.",
    });
  });
});

describe("releaseNotesMarkdown", () => {
  it("resolves a stored source against a supplied changelog", () => {
    const release = releaseNotesForVersion("0.1.2", fixture);
    expect(releaseNotesMarkdown(release!.source, fixture)).toBe(
      release?.markdown,
    );
  });
});

describe("presentReleaseNotes", () => {
  it("drops the version heading and keeps the dated body", () => {
    expect(presentReleaseNotes("0.1.2", fixture)).toEqual({
      version: "0.1.2",
      date: "2026-08-31",
      markdown: "### Added\n- Requested feature.",
    });
  });

  it("keeps undated releases without a date", () => {
    expect(presentReleaseNotes("0.1.1", fixture)).toEqual({
      version: "0.1.1",
      date: null,
      markdown: "### Fixed\n- Older fix.",
    });
  });

  it("returns null when the version is missing", () => {
    expect(presentReleaseNotes("9.9.9", fixture)).toBeNull();
  });
});

describe("formatReleaseDate", () => {
  it("formats a changelog ISO date", () => {
    expect(formatReleaseDate("2026-09-01")).toBe("1 Sep 2026");
  });

  it.each(["soon", "2026-13-01", "2026-09-1"])(
    "leaves invalid date %j alone",
    (value) => {
      expect(formatReleaseDate(value)).toBe(value);
    },
  );
});
