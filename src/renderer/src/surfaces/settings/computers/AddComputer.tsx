import { useCallback, useState } from "react";
import { RadioChoice, RadioGroup } from "../../../components/ui/radio-group";
import { DialogFooter } from "../../../chrome/ConfirmDialog";
import { Modal, ModalBody } from "../../../chrome/Modal";
import type { AddComputerAsk } from "../../../lib/settings/addComputer";
import { thisDesktopInLine } from "../../../lib/native";
import { useSetupLink, type UseSetupLinkProps } from "../../setup/UseSetupLink";
import { DeviceWay, type MadeKey, type MadeLink } from "./device";
import { Ends, FrameContext, useFrame, type Frame } from "./frame";
import { LinkWay } from "./link";
import { SetupWay, SetupWayView, type SetupWayViewProps } from "./setup";

/**
 * Add a computer… and Add… as one dialog (docs/agents/settings.md "Add a computer"). With no way it starts on the
 * choice of four, each a line of its own, then Continue; opened with a way it starts one step later, on that way:
 * sign a device in to a computer, set up a new computer, link this Mac to another computer, or use a setup link on
 * this Mac. Each way keeps the requests and checks of the dialog it replaced.
 */

export type Way = NonNullable<AddComputerAsk["way"]>;

export type AddComputerProps = {
  ask?: AddComputerAsk;
  onClose: () => void;
  /** A sign-in, a key, a setup link or a linked computer was made or taken back: lists that show them read again. */
  onChanged?: () => void;
  /** Start the device way on a bot. */
  bot?: boolean;
  /** Where a way starts, for ui:preview's fixtures: a link or key already made, a setup view's own data. */
  preview?: { inLine?: string; made?: MadeLink; madeKey?: MadeKey; setup?: Omit<SetupWayViewProps, "onClose">; useLink?: UseSetupLinkProps["phase"] };
};

export function AddComputerDialog({ ask = {}, onClose, onChanged = () => {}, bot, preview }: AddComputerProps) {
  const [way, setWay] = useState<Way | null>(ask.way ?? null);
  const [frame, setFrame] = useState<Frame>({ title: "Add a computer" });
  const setFrameOnce = useCallback((next: Frame) => setFrame((prev) => (sameFrame(prev, next) ? prev : next)), []);
  return (
    <Modal
      onClose={onClose}
      busy={frame.busy}
      title={frame.title}
      description={frame.endsAt ? <Ends at={frame.endsAt} /> : frame.description}
      size="sm"
      data-add-computer={way ?? "choose"}
    >
      <FrameContext.Provider value={setFrameOnce}>
        {way === null ? (
          <Choose onClose={onClose} onPick={setWay} />
        ) : way === "device" ? (
          <DeviceWay computer={ask.computer} bot={bot} onClose={onClose} onChanged={onChanged} made={preview?.made} madeKey={preview?.madeKey} inLine={preview?.inLine} />
        ) : way === "setup" ? (
          preview?.setup ? <SetupWayView {...preview.setup} onClose={onClose} /> : <SetupWay onClose={onClose} onChanged={onChanged} />
        ) : way === "link" ? (
          <LinkWay computer={ask.computer} onClose={onClose} onChanged={onChanged} />
        ) : (
          <UseLinkWay onClose={onClose} phase={preview?.useLink} />
        )}
      </FrameContext.Provider>
    </Modal>
  );
}

const sameFrame = (a: Frame, b: Frame): boolean => a.title === b.title && a.description === b.description && a.endsAt === b.endsAt && !!a.busy === !!b.busy;

/** The four ways, each with its line. */
export function wayChoices(): { value: Way; label: string; description: string }[] {
  const here = thisDesktopInLine();
  return [
    { value: "device", label: `Sign a device in to ${here}`, description: "A phone, a browser, or a computer that already runs Docket" },
    { value: "setup", label: "Set up a new computer", description: "Give it the box, your accounts, LifeOS and your Work folders. You pick them before the link is made." },
    { value: "link", label: `Link ${here} to another computer`, description: "Paste the link, or the address and key, that computer made" },
    { value: "use-link", label: `Use a setup link on ${here}`, description: `Paste the link another computer made for ${here}` },
  ];
}

function Choose({ onClose, onPick }: { onClose: () => void; onPick: (way: Way) => void }) {
  const [picked, setPicked] = useState<Way>("device");
  useFrame({ title: "Add a computer" });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onPick(picked);
      }}
    >
      <ModalBody>
        <RadioGroup aria-label="Add a computer" value={picked} onValueChange={(value) => setPicked(value as Way)} className="gap-2">
          {wayChoices().map((choice) => (
            <RadioChoice key={choice.value} value={choice.value} label={choice.label} description={choice.description} />
          ))}
        </RadioGroup>
      </ModalBody>
      <DialogFooter onCancel={onClose} confirmLabel="Continue" />
    </form>
  );
}

/** Use a setup link on this Mac: the computer's side of a setup link, its title naming this Mac until the setup starts. */
function UseLinkWay({ onClose, phase }: { onClose: () => void; phase?: UseSetupLinkProps["phase"] }) {
  const { title, pending, at, body } = useSetupLink({ onClose, phase });
  useFrame({ title: at === "steps" ? title : `Use a setup link on ${thisDesktopInLine()}`, busy: pending });
  return body;
}
