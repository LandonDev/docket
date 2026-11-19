import { defineChunk } from "../../lib/lazyChunk";
import { Mic } from "../icons";
import { defineCanvasKind } from "../canvas/kind";
import type { MeetingState } from "./MeetingCanvas";

/**
 * The meeting kind of canvas item (docs/agents/work-meetings.md "The
 * canvas"): a recording or a transcript, played and read beside the thread.
 * It claims sound files; a video stays the media kind's unless it is opened
 * as a meeting (`meeting_open`), and so does a transcript file, which no
 * kind claims by its extension.
 */
export const meetingCanvas = defineCanvasKind<MeetingState>({
  kind: "meeting",
  label: "Meeting",
  icon: Mic,
  opens: { mime: ["audio/*"], ext: ["wav", "mp3", "m4a", "aac", "flac", "ogg", "opus", "wma", "aiff", "amr"] },
  phone: "native",
  guestable: false,
  chunk: defineChunk("work-meetings-canvas", () => import("./MeetingCanvas")),
});
