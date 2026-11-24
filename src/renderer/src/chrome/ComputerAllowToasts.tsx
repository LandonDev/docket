import { useEffect, useRef, useState } from "react";
import { isWebMode } from "../lib/nativeWeb";
import type { SetupLinkRow } from "@server/shared/contract-devices";
import { allowComputer, denyComputer, onDevicesPush, readSetupLinks, type AllowNotice } from "../lib/devicesClient";
import { loadToast, useToastSync } from "./toastSync";

/**
 * The giver's Allow notice (docs/agents/pc-setup.md "Allow, on the Mac"): a
 * computer claimed a setup link and its proof checked out. "Purdue laptop
 * wants to join", the three words its own screen shows, Allow and Remove;
 * held until answered, and shown again after a reload from `devices.setup.links`.
 * Only the desktop hears it (the methods are local).
 */
export function ComputerAllowToasts() {
  const [notices, setNotices] = useState<AllowNotice[]>([]);
  useEffect(() => {
    if (isWebMode()) return;
    const put = (notice: AllowNotice) => setNotices((prev) => [...prev.filter((n) => n.pairingId !== notice.pairingId), notice]);
    const drop = (pairingId: string) => setNotices((prev) => prev.filter((n) => n.pairingId !== pairingId));
    // A link's claim waits for Allow, else its notice goes (answered in another window, refused or ended).
    const land = (link: SetupLinkRow) => (link.state === "asking" && link.words ? put({ pairingId: link.pairingId, name: link.name, words: link.words }) : drop(link.pairingId));
    const off = onDevicesPush({ allow: put, link: land });
    // A reloaded window shows a claim still waiting; a host from before the setup link has none.
    void readSetupLinks().then(({ links }) => links.forEach(land), () => {});
    return off;
  }, []);
  return <AllowToasts notices={notices} onAnswered={(pairingId) => setNotices((prev) => prev.filter((n) => n.pairingId !== pairingId))} />;
}

export function AllowToasts({ notices, onAnswered }: { notices: AllowNotice[]; onAnswered: (pairingId: string) => void }) {
  const answered = useRef(onAnswered);
  answered.current = onAnswered;
  useToastSync(
    notices,
    (notice) => `computer-allow:${notice.pairingId}`,
    (toast, { pairingId, name, words }, id) => {
      const answer = (work: (pairingId: string) => Promise<unknown>, failed: string) => () => {
        answered.current(pairingId);
        void work(pairingId).catch(() => void loadToast().then((t) => t.error(failed)));
      };
      toast(`${name} wants to join`, {
        id,
        description: words.join(" · "),
        duration: Infinity,
        action: { label: "Allow", onClick: answer(allowComputer, `${name} was not allowed`) },
        cancel: { label: "Remove", onClick: answer(denyComputer, `${name} was not removed`) },
      });
    },
    (notice) => JSON.stringify([notice.name, notice.words]),
  );
  return null;
}
