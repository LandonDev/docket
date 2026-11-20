import type { CaptureViewProps } from "./CaptureView";

/** The capture window's states for `bun run ui:preview src/renderer/src/work/capture/CaptureView.tsx#CaptureView`. */
const base: Omit<CaptureViewProps, "onText" | "onSector" | "onRemoveFile" | "onFile"> = {
  text: "",
  files: [],
  sector: "purdue",
  status: "ready",
  error: null,
  canFile: false,
};

export const fixtures = [
  { name: "Empty, on the last sector", props: base },
  { name: "Words", props: { ...base, text: "Book the arena for the spring LAN\nAsk about the second court and the parking", canFile: true } },
  {
    name: "Files, unsorted",
    props: {
      ...base,
      sector: "unsorted",
      text: "Receipts from the trip",
      canFile: true,
      files: [
        { id: "a", name: "Hotel receipt.pdf", path: "/a" },
        { id: "b", name: "Pasted image.png", path: "/b" },
      ],
    },
  },
  { name: "No workspace for the file", props: { ...base, sector: "cosmic", files: [{ id: "a", name: "Loot table.xlsx", path: "/a" }], error: "No Cosmic workspace on this computer to keep the file in" } },
  { name: "LifeOS away", props: { ...base, text: "Call the ref assigner", status: "offline", canFile: true } },
  { name: "Dragging a file", props: { ...base, dragging: true } },
];
