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
import Message01Icon from "@hugeicons/core-free-icons/Message01Icon";
import News01Icon from "@hugeicons/core-free-icons/News01Icon";
import Mic01Icon from "@hugeicons/core-free-icons/Mic01Icon";
import Pdf01Icon from "@hugeicons/core-free-icons/Pdf01Icon";
import ReceiptIcon from "@hugeicons/core-free-icons/ReceiptIcon";
import Presentation01Icon from "@hugeicons/core-free-icons/Presentation01Icon";
import Share08Icon from "@hugeicons/core-free-icons/Share08Icon";
import Table01Icon from "@hugeicons/core-free-icons/Table01Icon";
import TaskDone01Icon from "@hugeicons/core-free-icons/TaskDone01Icon";
import TextSelectionIcon from "@hugeicons/core-free-icons/TextSelectionIcon";
import WorkHistoryIcon from "@hugeicons/core-free-icons/WorkHistoryIcon";
import Video01Icon from "@hugeicons/core-free-icons/Video01Icon";
import VolumeHighIcon from "@hugeicons/core-free-icons/VolumeHighIcon";
import VolumeOffIcon from "@hugeicons/core-free-icons/VolumeOffIcon";
import FullScreenIcon from "@hugeicons/core-free-icons/FullScreenIcon";
import ZoomInAreaIcon from "@hugeicons/core-free-icons/ZoomInAreaIcon";
import ZoomOutAreaIcon from "@hugeicons/core-free-icons/ZoomOutAreaIcon";
import Comment01Icon from "@hugeicons/core-free-icons/Comment01Icon";
import Download01Icon from "@hugeicons/core-free-icons/Download01Icon";
import FileExportIcon from "@hugeicons/core-free-icons/FileExportIcon";
import TaskAdd01Icon from "@hugeicons/core-free-icons/TaskAdd01Icon";
import Briefcase01Icon from "@hugeicons/core-free-icons/Briefcase01Icon";
import UserIcon from "@hugeicons/core-free-icons/UserIcon";
import KanbanIcon from "@hugeicons/core-free-icons/KanbanIcon";
import CloudIcon from "@hugeicons/core-free-icons/CloudIcon";
import File01Icon from "@hugeicons/core-free-icons/File01Icon";
import Link01Icon from "@hugeicons/core-free-icons/Link01Icon";
import HashtagIcon from "@hugeicons/core-free-icons/HashtagIcon";
import FolderAddIcon from "@hugeicons/core-free-icons/FolderAddIcon";
import FolderTransferIcon from "@hugeicons/core-free-icons/FolderTransferIcon";
import GalleryThumbnailsIcon from "@hugeicons/core-free-icons/GalleryThumbnailsIcon";
import GridViewIcon from "@hugeicons/core-free-icons/GridViewIcon";
import Home01Icon from "@hugeicons/core-free-icons/Home01Icon";
import LayoutLeftIcon from "@hugeicons/core-free-icons/LayoutLeftIcon";
import LayoutThreeColumnIcon from "@hugeicons/core-free-icons/LayoutThreeColumnIcon";
import LeftToRightListBulletIcon from "@hugeicons/core-free-icons/LeftToRightListBulletIcon";
import LeftToRightListNumberIcon from "@hugeicons/core-free-icons/LeftToRightListNumberIcon";
import ListViewIcon from "@hugeicons/core-free-icons/ListViewIcon";
import RedoIcon from "@hugeicons/core-free-icons/RedoIcon";
import TextAlignLeftIcon from "@hugeicons/core-free-icons/TextAlignLeftIcon";
import TextBoldIcon from "@hugeicons/core-free-icons/TextBoldIcon";
import TextColorIcon from "@hugeicons/core-free-icons/TextColorIcon";
import TextFontIcon from "@hugeicons/core-free-icons/TextFontIcon";
import TextItalicIcon from "@hugeicons/core-free-icons/TextItalicIcon";
import TextUnderlineIcon from "@hugeicons/core-free-icons/TextUnderlineIcon";
import Undo02Icon from "@hugeicons/core-free-icons/Undo02Icon";
import Upload01Icon from "@hugeicons/core-free-icons/Upload01Icon";
import { wrap } from "../chrome/icons";

/** LifeOS's mark, as the approved prototypes draw it (`b-lifeos`): a ring with a meridian and two parallels. Hugeicons has no LifeOS, so it is drawn here in the same shape Hugeicons gives, and takes the one stroke. */
const LifeosMark = [
  ["circle", { cx: "12", cy: "12", r: "9", stroke: "currentColor", strokeWidth: "1.5", key: "0" }],
  ["path", { d: "M12 3v18M4.5 8.5c4 2.5 11 2.5 15 0M4.5 15.5c4-2.5 11-2.5 15 0", stroke: "currentColor", strokeLinecap: "round", strokeWidth: "1.5", key: "1" }],
] as const;

export const Mail = wrap(Mail01Icon, "Mail");
/** A sender that is a mailing list or a program, where a face would go (Mail). */
export const News = wrap(News01Icon, "News");
/** A chat conversation (Messages): a chip, an `@` row. Not Work Chats' bubbles, which are threads. */
export const Chat = wrap(Message01Icon, "Chat");
/** A document in the block editor. */
export const Doc = wrap(Doc01Icon, "Doc");
/** A sheet. */
export const Table = wrap(Table01Icon, "Table");
export const Pdf = wrap(Pdf01Icon, "Pdf");
/** Money: its row in the column, a receipt with no picture, File as receipt. */
export const Receipt = wrap(ReceiptIcon, "Receipt");
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
/** The media kind's own: a video, sound on and off, full screen, zoom, a comment. */
export const Video = wrap(Video01Icon, "Video");
export const Volume = wrap(VolumeHighIcon, "Volume");
export const VolumeOff = wrap(VolumeOffIcon, "VolumeOff");
export const FullScreen = wrap(FullScreenIcon, "FullScreen");
export const ZoomIn = wrap(ZoomInAreaIcon, "ZoomIn");
export const ZoomOut = wrap(ZoomOutAreaIcon, "ZoomOut");
export const Comment = wrap(Comment01Icon, "Comment");
/** A task in LifeOS: what a meeting's task is once it is filed. */
export const Lifeos = wrap(LifeosMark, "Lifeos");
/** A task waiting to be made: a suggestion that is not in LifeOS yet, and "Make task". */
export const TaskAdd = wrap(TaskAdd01Icon, "TaskAdd");
/** A copy of the file saved to disk: Download recording, Save a copy. */
export const Download = wrap(Download01Icon, "Download");
/** The item written out in another form: Export transcript. */
export const Export = wrap(FileExportIcon, "Export");
/** Share on a document's or a sheet's bar: the prototype kit's `share` (Share08). */
export const Share = wrap(Share08Icon, "Share");
/** A LifeOS project. */
export const Project = wrap(Briefcase01Icon, "Project");
/** A person in LifeOS. */
export const Person = wrap(UserIcon, "Person");
/** A card on a project's board. */
export const Card = wrap(KanbanIcon, "Card");
/** A Teams file OneDrive keeps in the cloud until it is opened. */
export const Cloud = wrap(CloudIcon, "Cloud");
/** A file no other glyph names. */
export const File = wrap(File01Icon, "File");
/** A thing linked to a project: Link a document, Link a file or item. */
export const Link = wrap(Link01Icon, "Link");
/** A chat channel in Messages, where a person would show their face. */
export const Hash = wrap(HashtagIcon, "Hash");

// The Files place: a page's shapes in its view switch, and the verbs' rows in New and a file's menu.
/** Home, the first row of the Files place's sidebar. */
export const Home = wrap(Home01Icon, "Home");
export const ListShape = wrap(ListViewIcon, "ListShape");
export const GridShape = wrap(GridViewIcon, "GridShape");
export const ColumnsShape = wrap(LayoutThreeColumnIcon, "ColumnsShape");
export const GalleryShape = wrap(GalleryThumbnailsIcon, "GalleryShape");
export const BesideShape = wrap(LayoutLeftIcon, "BesideShape");
export const FolderAdd = wrap(FolderAddIcon, "FolderAdd");
export const MoveTo = wrap(FolderTransferIcon, "MoveTo");
export const Upload = wrap(Upload01Icon, "Upload");
export const PutBack = wrap(Undo02Icon, "PutBack");

/** A deck's format row (the slides kind): his own Redo (Undo is the chrome's), the character group, the lists. */
export const Redo = wrap(RedoIcon, "Redo");
export const Bold = wrap(TextBoldIcon, "Bold");
export const Italic = wrap(TextItalicIcon, "Italic");
export const Underline = wrap(TextUnderlineIcon, "Underline");
export const TextColour = wrap(TextColorIcon, "TextColour");
export const Font = wrap(TextFontIcon, "Font");
export const Bullets = wrap(LeftToRightListBulletIcon, "Bullets");
export const Numbers = wrap(LeftToRightListNumberIcon, "Numbers");
export const Align = wrap(TextAlignLeftIcon, "Align");
