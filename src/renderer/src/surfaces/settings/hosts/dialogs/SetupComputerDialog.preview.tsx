import { ModalBox } from "../../../setup/UseSetupLink.preview";
import { useSetupComputer } from "./SetupComputerDialog";

/**
 * Set up a computer for `bun run ui:preview
 * src/renderer/src/surfaces/settings/hosts/dialogs/SetupComputerDialog.preview.tsx#SetupComputerPreview`
 * (fixtures beside it), its real body in the Modal's box. Rendered by nothing in the app.
 */
export function SetupComputerPreview(props: Parameters<typeof useSetupComputer>[0]) {
  const { body } = useSetupComputer(props);
  return <ModalBox title="Set up a computer">{body}</ModalBox>;
}
