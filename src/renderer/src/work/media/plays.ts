import { playFor, VIEWER_DEFAULT_PLAYS, type MediaPlay, type MediaVersion } from "@shared/contract-work-media";

/**
 * What this viewer's `<video>` decodes, asked of the element itself, so the
 * host makes a proxy only for what it cannot play: HEVC plays on the Mac
 * through VideoToolbox and nowhere Chromium lacks a decoder; ProRes plays
 * in neither (the formats research). Asked once.
 */
const PROBES: Array<[string, string]> = [
  ["h264", 'video/mp4; codecs="avc1.640028"'],
  ["h264-hi", 'video/mp4; codecs="avc1.6e0028"'],
  ["hevc", 'video/mp4; codecs="hvc1.1.6.L120.90"'],
  ["vp9", 'video/webm; codecs="vp09.00.40.08"'],
  ["av1", 'video/mp4; codecs="av01.0.08M.08"'],
  ["prores", 'video/quicktime; codecs="apcn"'],
];

let plays: string[] | null = null;

export function viewerPlays(): string[] {
  if (plays) return plays;
  const video = typeof document === "undefined" ? null : document.createElement("video");
  if (!video?.canPlayType) return [...VIEWER_DEFAULT_PLAYS];
  plays = PROBES.filter(([, type]) => video.canPlayType(type) === "probably").map(([key]) => key);
  // An element that answers nothing (a test's) is taken for the default.
  if (plays.length === 0) plays = [...VIEWER_DEFAULT_PLAYS];
  return plays;
}

/** What this viewer shows of a version: the original where it decodes it, else the host's proxy or picture. */
export const shownPlay = (v: Pick<MediaVersion, "plays" | "probe">): MediaPlay | null => playFor(v, viewerPlays());
