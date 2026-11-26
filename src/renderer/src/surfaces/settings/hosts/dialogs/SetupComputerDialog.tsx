import { AddComputerDialog } from "../../computers/AddComputer";

/** The old page's Set up a computer…: the setup way of Add a computer…. */
export function SetupComputerDialog({ onClose }: { onClose: () => void }) {
  return <AddComputerDialog ask={{ way: "setup" }} onClose={onClose} />;
}
