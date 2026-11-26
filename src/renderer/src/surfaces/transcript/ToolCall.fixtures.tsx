// bun run ui:preview src/renderer/src/surfaces/transcript/ToolCall.tsx#ToolCall
// Static capture shows separate calls. Opening or editing their bodies needs interaction.
import { ACTION_FIXTURES } from "./ActivityRow.fixtures";

export default ACTION_FIXTURES.filter(({ props }) => ["e1", "r2", "r3", "d1"].includes(props.block.id));
