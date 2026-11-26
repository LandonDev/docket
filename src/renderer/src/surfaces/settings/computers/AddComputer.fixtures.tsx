import QRCode from "qrcode";
import type { AddComputerProps } from "./AddComputer";

/**
 * Add a computer… for `bun run ui:preview src/renderer/src/surfaces/settings/computers/AddComputer.tsx#AddComputerDialog
 * --fresh --shot`: the choice of four, each way's first step, a device's link with its code, a bot's key, set up's list
 * and its link. The dialog is left open, so the preview draws it in place, in a window (`stage`) only as tall as that
 * dialog needs at 400px wide.
 */

const url = "https://docket.landonhale.com/pair#KDRT4-82139";
const qr = await QRCode.toDataURL(url, { margin: 1, width: 192, color: { dark: "#000000", light: "#ffffff" } });
const endsAt = Date.now() + 582_000;
const close = () => {};
const workspaces = [
  { id: "w1", name: "Purdue Esports" },
  { id: "w2", name: "Hypixel" },
];

const fixtures: { name: string; props: AddComputerProps }[] = [
  { name: "Add a computer", props: { onClose: close, preview: { stage: 500 } } },
  { name: "Sign a device in", props: { onClose: close, ask: { way: "device" }, preview: { inLine: "this Mac", stage: 600 } } },
  { name: "Sign a device in to the box", props: { onClose: close, ask: { way: "device" }, preview: { inLine: "the box", stage: 600 } } },
  {
    name: "The link and its code",
    props: {
      onClose: close,
      ask: { way: "device" },
      preview: {
        inLine: "the box",
        stage: 340,
        made: { pairing: { id: "pairing-1", name: "iPhone", audience: "client", caps: ["read", "operate"], createdAt: 0, expiresAt: endsAt, consumedAt: null, consumedBy: null }, code: "KDRT4-82139", url, qr },
      },
    },
  },
  { name: "A key for a bot", props: { onClose: close, ask: { way: "device" }, bot: true, preview: { inLine: "the box", stage: 640 } } },
  {
    name: "The bot's key",
    props: {
      onClose: close,
      ask: { way: "device" },
      preview: { inLine: "the box", stage: 380, madeKey: { key: { id: "key-1" } as never, token: "tc_8F2KQ.vX0mR7yLq4wN2pTj9sDc", webhookSecret: "whsec_Qm4Zr8LxT2vN6pYc" } },
    },
  },
  { name: "Set up a new computer", props: { onClose: close, ask: { way: "setup" }, preview: { stage: 540, setup: { workspaces, lifeosSignedIn: true } } } },
  {
    name: "Set up: the link",
    props: {
      onClose: close,
      ask: { way: "setup" },
      preview: {
        stage: 300,
        setup: { workspaces, lifeosSignedIn: true, made: { link: "https://docket.landonhale.com/setup#v1.KDRT4-82139.q8Zr", expiresAt: Date.now() + 14 * 60_000 + 52_000, pairingId: "pairing-2" } },
      },
    },
  },
  { name: "Link this Mac to another computer", props: { onClose: close, ask: { way: "link" }, preview: { stage: 420 } } },
  { name: "Use a setup link on this Mac", props: { onClose: close, ask: { way: "use-link" }, preview: { stage: 300 } } },
];

export default fixtures;
