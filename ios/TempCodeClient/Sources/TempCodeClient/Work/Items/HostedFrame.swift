import Foundation
import Observation
import TempCodeContract

/// The hosted editor's native frame (the iPhone plan's section 4, M3c): the phone opens the owner's page with
/// `chrome=none`, so the page draws no title or role bar of its own, and the two talk over one bridge with a
/// closed set of messages (src/hosted/guest/frame.ts holds the page's side). The page says when it has first
/// drawn, what it offers, and the format of the words under the caret; the phone asks it to set a format, find
/// words, undo and redo. Nothing else crosses: a message outside the set is dropped on either side.
public enum HostedBridge {
    /// The name of the page's message handler (`window.webkit.messageHandlers.tcFrame`).
    public static let handler = "tcFrame"

    /// The ticket's address with `chrome=none` in its fragment. The fragment never reaches a server, so the host
    /// is unchanged; a page from before the bridge ignores it and draws its own bar, as it always did.
    public static func framed(_ address: String) -> String {
        guard !address.contains("chrome=none") else { return address }
        return address.contains("#") ? address + "&chrome=none" : address + "#chrome=none"
    }
}

/// What the page can do for the frame, as its `drawn` said.
public struct HostedOffers: Equatable, Sendable {
    public var format: Bool
    public var find: Bool
    public var undo: Bool

    public static let none = HostedOffers(format: false, find: false, undo: false)

    public init(format: Bool, find: Bool, undo: Bool) {
        self.format = format
        self.find = find
        self.undo = undo
    }
}

/// A list the format row toggles.
public enum HostedList: String, Sendable, CaseIterable {
    case bullet, number, check

    public var title: String {
        switch self {
        case .bullet: "Bulleted List"
        case .number: "Numbered List"
        case .check: "Checklist"
        }
    }

    public var symbol: String {
        switch self {
        case .bullet: "list.bullet"
        case .number: "list.number"
        case .check: "checklist"
        }
    }
}

/// The words under the caret, as the page last said.
public struct HostedEditState: Equatable, Sendable {
    /// The editor holds the focus: the keyboard is up.
    public var editing: Bool
    /// The line's named style ("Body", "Heading 1"); nil where the lines picked differ.
    public var style: String?
    /// The styles the page offers, in its order.
    public var styles: [String]
    public var bold: Bool
    public var italic: Bool
    public var list: HostedList?
    public var undo: Bool
    public var redo: Bool

    public static let idle = HostedEditState(editing: false, style: nil, styles: [], bold: false, italic: false, list: nil, undo: false, redo: false)

    public init(editing: Bool, style: String?, styles: [String], bold: Bool, italic: Bool, list: HostedList?, undo: Bool, redo: Bool) {
        self.editing = editing
        self.style = style
        self.styles = styles
        self.bold = bold
        self.italic = italic
        self.list = list
        self.undo = undo
        self.redo = redo
    }
}

/// Words found in the page: how many, and which is picked (from 1; 0 when none is).
public struct HostedFound: Equatable, Sendable {
    public var query: String
    public var count: Int
    public var at: Int

    public init(query: String, count: Int, at: Int) {
        self.query = query
        self.count = count
        self.at = at
    }
}

/// What the page says.
public enum HostedFrameMessage: Equatable, Sendable {
    case drawn(HostedOffers)
    case state(HostedEditState)
    case found(HostedFound)

    /// The longest style name or query the frame takes from the page.
    static let longest = 200
    static let mostStyles = 40

    /// Reads one message; anything outside the set, or a value of the wrong kind, is nil.
    public static func parse(_ body: JSONValue) -> HostedFrameMessage? {
        switch body["kind"]?.stringValue {
        case "drawn":
            guard body["v"]?.intValue == 1, let offers = body["offers"], offers.objectValue != nil else { return nil }
            return .drawn(HostedOffers(format: offers["format"]?.boolValue == true, find: offers["find"]?.boolValue == true, undo: offers["undo"]?.boolValue == true))
        case "state":
            guard let editing = body["editing"]?.boolValue, let bold = body["bold"]?.boolValue, let italic = body["italic"]?.boolValue,
                  let undo = body["undo"]?.boolValue, let redo = body["redo"]?.boolValue, let styles = body["styles"]?.arrayValue else { return nil }
            let names = styles.prefix(mostStyles).compactMap(\.stringValue).filter { !$0.isEmpty && $0.count <= longest }
            let style = body["style"]?.stringValue.flatMap { $0.count <= longest ? $0 : nil }
            let list = body["list"]?.stringValue.flatMap(HostedList.init(rawValue:))
            return .state(HostedEditState(editing: editing, style: style, styles: names, bold: bold, italic: italic, list: list, undo: undo, redo: redo))
        case "found":
            guard let query = body["query"]?.stringValue, let count = body["count"]?.intValue, let at = body["at"]?.intValue, count >= 0, at >= 0, at <= count else { return nil }
            return .found(HostedFound(query: query, count: count, at: at))
        default:
            return nil
        }
    }
}

/// What the frame asks of the page.
public enum HostedCommand: Equatable, Sendable {
    case bold, italic
    case style(String)
    case list(HostedList)
    case search(String)
    case next, previous, clearFind
    case undo, redo

    public var body: JSONValue {
        func message(_ fields: [String: String]) -> JSONValue { .object(fields.mapValues(JSONValue.string)) }
        switch self {
        case .bold: return message(["kind": "format", "what": "bold"])
        case .italic: return message(["kind": "format", "what": "italic"])
        case .style(let name): return message(["kind": "format", "what": "style", "style": name])
        case .list(let list): return message(["kind": "format", "what": "list", "list": list.rawValue])
        case .search(let query): return message(["kind": "find", "what": "search", "query": query])
        case .next: return message(["kind": "find", "what": "next"])
        case .previous: return message(["kind": "find", "what": "previous"])
        case .clearFind: return message(["kind": "find", "what": "clear"])
        case .undo: return message(["kind": "undo"])
        case .redo: return message(["kind": "redo"])
        }
    }

    /// The script the web view runs: the page's own receiver, when it has one, and nothing otherwise.
    public var script: String {
        let json = (try? JSONEncoder().encode(body)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        return "window.tcFrame && window.tcFrame.receive(\(json))"
    }
}

/// One hosted page's side of the bridge, as the native frame reads it. The web view hands every message in
/// (`receive`) and runs what `run` asks; the bar, More and the format row read the rest.
@MainActor @Observable
public final class HostedFrame {
    /// The page has drawn its first paint: the web view fades in.
    public private(set) var drawn = false
    public private(set) var offers = HostedOffers.none
    public private(set) var state = HostedEditState.idle
    public private(set) var found: HostedFound?
    /// Runs a script in the page; set by the web view once it holds the page.
    @ObservationIgnored public var evaluate: ((String) -> Void)?
    /// Hears each find answer (the system's find bar is told its count changed).
    @ObservationIgnored public var onFound: ((HostedFound) -> Void)?

    public init() {}

    /// A message from the page.
    public func receive(_ body: JSONValue) {
        switch HostedFrameMessage.parse(body) {
        case .drawn(let said)?:
            offers = said
            drawn = true
        case .state(let said)?:
            if state != said { state = said }
        case .found(let said)?:
            found = said
            onFound?(said)
        case nil:
            break
        }
    }

    /// A page that says nothing (one from before the bridge, a page that failed to start its script) is shown
    /// once it has loaded: it is never held hidden.
    public func loaded() {
        drawn = true
    }

    /// A new page in the same view (a fresh ticket): nothing of the last one stands.
    public func reset() {
        drawn = false
        offers = .none
        state = .idle
        found = nil
    }

    /// Asks the page; nothing goes where the page did not offer it.
    public func run(_ command: HostedCommand) {
        guard allows(command) else { return }
        evaluate?(command.script)
    }

    public func allows(_ command: HostedCommand) -> Bool {
        switch command {
        case .bold, .italic, .list: offers.format
        case .style(let name): offers.format && state.styles.contains(name)
        case .search, .next, .previous, .clearFind: offers.find
        case .undo, .redo: offers.undo
        }
    }

    /// The format row shows while he is typing in a page that offers formats.
    public var formatRow: Bool { offers.format && state.editing }
    /// More's Undo and Redo: only when there is something to undo or redo.
    public var canUndo: Bool { offers.undo && state.undo }
    public var canRedo: Bool { offers.undo && state.redo }
}
