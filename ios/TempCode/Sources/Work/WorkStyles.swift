import SwiftUI
import TempCodeClient
import TempCodeContract

/// Work's few drawing tokens (docs/IOS-DESIGN.md, "Work on the phone"): the
/// six sector hues, used only for a Work workspace's dot and the Outbox's
/// bands, and the glyph of each kind of held act.
extension Tint {
    /// A sector's hue (LifeOS's six; any other key draws the quiet gray).
    static func sector(_ key: String?) -> Color {
        guard let key, let pair = sectorHues[key] else { return quiet }
        return Color(UIColor { $0.userInterfaceStyle == .dark ? pair.dark : pair.light })
    }

    /// The prototype kit's oklch values (kit2.css `--sec-*`), in sRGB, light and dark.
    private static let sectorHues: [String: (light: UIColor, dark: UIColor)] = [
        "cosmic": (UIColor(red: 0.476, green: 0.457, blue: 0.771, alpha: 1), UIColor(red: 0.617, green: 0.606, blue: 0.905, alpha: 1)),
        "hypixel": (UIColor(red: 0.788, green: 0.442, blue: 0.321, alpha: 1), UIColor(red: 0.902, green: 0.574, blue: 0.459, alpha: 1)),
        "purdue": (UIColor(red: 0.744, green: 0.599, blue: 0.275, alpha: 1), UIColor(red: 0.834, green: 0.700, blue: 0.415, alpha: 1)),
        "ref": (UIColor(red: 0.313, green: 0.596, blue: 0.421, alpha: 1), UIColor(red: 0.460, green: 0.712, blue: 0.549, alpha: 1)),
        "unify": (UIColor(red: 0.226, green: 0.538, blue: 0.703, alpha: 1), UIColor(red: 0.413, green: 0.682, blue: 0.836, alpha: 1)),
        "life": (UIColor(red: 0.719, green: 0.412, blue: 0.562, alpha: 1), UIColor(red: 0.832, green: 0.543, blue: 0.680, alpha: 1))
    ]
}

/// A Work workspace's sector, as one 8 pt dot. It leads a Work workspace's
/// row in the 28 pt mark slot and an Outbox band's title; it is never a tile.
/// It grows with the text, up to 14 pt, so at accessibility sizes it is not a
/// speck beside a three-line title (IOS-DESIGN "Large text").
struct SectorDot: View {
    let sector: String?
    var size: CGFloat = 8
    @ScaledMetric(relativeTo: .footnote) private var scale: CGFloat = 1

    var body: some View {
        let side = max(size, min(size * scale, 14))
        Circle()
            .fill(Tint.sector(sector))
            .frame(width: side, height: side)
            .accessibilityHidden(true)
    }
}

/// The mark column, its mark centred on the first line of a title-step text: a hidden line of that step
/// gives the column the title's first baseline and its line's height. A row that uses it aligns on
/// `.firstTextBaseline` and puts its separator back at the title (`separatorAtTextEdge`), since the hidden
/// line is the row's first text.
struct FirstLineMark<Mark: View>: View {
    @ViewBuilder let mark: Mark

    var body: some View {
        ZStack {
            Text(verbatim: "A").textStep(.title).hidden()
            mark
        }
        .frame(width: Layout.glyphWidth + Layout.markWidth)
    }
}

enum WorkGlyph {
    /// The Outbox's own glyph: Home's row, the empty list.
    static let outbox = "paperplane"

    /// What a held act does, as one SF Symbol.
    static func of(_ kind: OutboxItem.Kind) -> String {
        switch kind {
        case .mailSend, .officeMailSend: "envelope"
        case .calendarOp, .officeCalendarOp: "calendar"
        case .teamsPost: "bubble.left.and.text.bubble.right"
        case .chatReply: "bubble.left"
        case .shareGuestLink: "link"
        case .shareGoogle: "person.2"
        case .formPublish, .msformMake, .msformPublish: "list.bullet.rectangle"
        case .frameioPost: "film"
        case .portalSubmit: "globe"
        case .computerAct: "macwindow"
        case .addonCall: "puzzlepiece.extension"
        case .officeEdit, .googleEdit: "doc.text"
        case .fileAct: "doc"
        case .unknown: "paperplane"
        }
    }
}

extension EnvironmentClient {
    /// A Work workspace's name and sector on this host, or Work Chats' (nil id).
    func workPlace(_ workspaceId: String?) -> (name: String, sector: String?) {
        guard let workspaceId, workspaceId != OutboxModel.workChatsKey, let workspace = workspaces.first(where: { $0.id == workspaceId }) else { return ("Work Chats", nil) }
        return (workspace.name, workspace.sector)
    }
}

/// "9:12 AM" today, "Nov 18" before.
enum HeldTime {
    static func of(_ ms: Int, now: Date = .now) -> String {
        let date = Date(timeIntervalSince1970: Double(ms) / 1000)
        return Calendar.current.isDate(date, inSameDayAs: now)
            ? date.formatted(date: .omitted, time: .shortened)
            : date.formatted(.dateTime.month(.abbreviated).day())
    }
}

extension View {
    /// A text action in a row (Undo, Remove): the word keeps its size, the hit area reaches 44 pt.
    func rowActionHit() -> some View {
        frame(minWidth: Layout.rowHeight, minHeight: Layout.rowHeight).contentShape(Rectangle())
    }
}
