import { AddComputerDialog } from "../../computers/AddComputer";

/** The old page's key for a bot: the device way of Add a computer…, on a bot. */
export function NewKeyDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => Promise<void> }) {
  return <AddComputerDialog ask={{ way: "device" }} bot onClose={onClose} onChanged={() => void onChanged()} />;
}
