/**
 * Work's glyphs: Hugeicons under the chrome's naming, made with the chrome's
 * own wrapper so the stroke is one. A module of its own because the chrome's
 * catalog (chrome/icons.tsx) is in the first paint and nothing of Work is
 * (docs/agents/work.md "The first paint"): a glyph only a Work screen draws
 * goes here, one the chrome already has is imported from there.
 */
import BubbleChatIcon from "@hugeicons/core-free-icons/BubbleChatIcon";
import Calendar03Icon from "@hugeicons/core-free-icons/Calendar03Icon";
import DashboardSquare01Icon from "@hugeicons/core-free-icons/DashboardSquare01Icon";
import Doc01Icon from "@hugeicons/core-free-icons/Doc01Icon";
import Image01Icon from "@hugeicons/core-free-icons/Image01Icon";
import Mail01Icon from "@hugeicons/core-free-icons/Mail01Icon";
import Mic01Icon from "@hugeicons/core-free-icons/Mic01Icon";
import Pdf01Icon from "@hugeicons/core-free-icons/Pdf01Icon";
import Presentation01Icon from "@hugeicons/core-free-icons/Presentation01Icon";
import Table01Icon from "@hugeicons/core-free-icons/Table01Icon";
import TaskDone01Icon from "@hugeicons/core-free-icons/TaskDone01Icon";
import TextSelectionIcon from "@hugeicons/core-free-icons/TextSelectionIcon";
import WorkHistoryIcon from "@hugeicons/core-free-icons/WorkHistoryIcon";
import { wrap } from "../chrome/icons";

export const Mail = wrap(Mail01Icon, "Mail");
/** A document in the block editor. */
export const Doc = wrap(Doc01Icon, "Doc");
/** A sheet. */
export const Table = wrap(Table01Icon, "Table");
export const Pdf = wrap(Pdf01Icon, "Pdf");
export const Slides = wrap(Presentation01Icon, "Slides");
/** Images and video share the media kind. */
export const Media = wrap(Image01Icon, "Media");
/** A meeting or a recording. */
export const Mic = wrap(Mic01Icon, "Mic");
export const Dashboard = wrap(DashboardSquare01Icon, "Dashboard");
export const Task = wrap(TaskDone01Icon, "Task");
/** An event on the agenda. */
export const Calendar = wrap(Calendar03Icon, "Calendar");
/** A selection in an item, on its chip. */
export const Selection = wrap(TextSelectionIcon, "Selection");
/** An item's versions. */
export const History = wrap(WorkHistoryIcon, "History");
/** Ask: the selection goes to the thread. */
export const Ask = wrap(BubbleChatIcon, "Ask");
