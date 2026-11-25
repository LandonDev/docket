import Foundation
import TempCodeContract

/// What a link can be for (contract-work-guests.ts `GuestSource`): a LifeOS document, sheet or project, or a
/// TempCode document or sheet kept as a file, named by its host and its path there.
public enum ShareSource: Hashable, Sendable {
    public enum Table: String, Sendable { case docs, sheets, projects }

    case lifeos(Table, id: String)
    case file(host: String, path: String)

    /// The item's source, where Share can make a link for it: a LifeOS document or sheet, or a `.tcdoc` or
    /// `.tcsheet` file. The host may still refuse a file in its own words (a place others open, a computer no
    /// guest can reach): the sheet then says them in the form's place.
    public static func of(_ item: CanvasItem) -> ShareSource? {
        guard item.kind == .document || item.kind == .sheet else { return nil }
        switch item.source {
        case .lifeos(let source):
            switch source.table {
            case .docs: return .lifeos(.docs, id: source.id)
            case .sheets: return .lifeos(.sheets, id: source.id)
            default: return nil
            }
        case .file(let source):
            let file = ShareSource.file(host: source.host, path: source.path)
            return file.table == nil ? nil : file
        default:
            return nil
        }
    }

    /// What kind of item it is (`guestTableOf`): a file by its name, nil for a file no link can be for.
    public var table: Table? {
        switch self {
        case .lifeos(let table, _): return table
        case .file(_, let path):
            let name = path.lowercased()
            return name.hasSuffix(".tcdoc") ? .docs : name.hasSuffix(".tcsheet") ? .sheets : nil
        }
    }

    /// The roles a link to it can have (`guestRolesOf`): a project's views; a sheet's view or edit (sheets keep no
    /// comments); a document's all three, kept in LifeOS or as a file (a `.tcdoc`'s comments go through its
    /// computer's app).
    public var roles: [GuestLinkDraft.Role] {
        if table == .projects { return [.view] }
        if table == .sheets { return [.view, .edit] }
        return GuestLinkDraft.Role.allCases
    }

    /// The ledger's ref for a Create link on this item: one press on its way per item.
    public var ref: String {
        switch self {
        case .lifeos(let table, let id): "guest:\(table.rawValue):\(id)"
        case .file(let host, let path): "guest:file:\(host):\(path)"
        }
    }

    var createSource: Methods.WorkGuestsCreate.Params.Source {
        switch self {
        case .lifeos(let table, let id): .object(.init(at: "lifeos", table: .init(rawValue: table.rawValue), id: id))
        case .file(let host, let path): .object1(.init(at: "file", host: host, path: path))
        }
    }

    var forItemSource: Methods.WorkGuestsForItem.Params.Source {
        switch self {
        case .lifeos(let table, let id): .object(.init(at: "lifeos", table: .init(rawValue: table.rawValue), id: id))
        case .file(let host, let path): .object1(.init(at: "file", host: host, path: path))
        }
    }
}

/// The phone's Share sheet's rules (the desktop's ShareSheet.tsx, fb35a39d8): Ends as four choices, the item's live
/// links with their one line of facts, the line a host's refusal is said in, and Purdue's line.
public enum ShareRules {
    /// Ends: a day, a week, thirty days (the default), ninety.
    public static let ends = [1, 7, 30, 90]
    public static let defaultDays = 30

    /// Beside Create link in a Purdue workspace: its file is university data.
    public static let purdueLine = "Purdue's data: this shares it outside Purdue."

    /// Why a file is not shared by link (`SHARE_REFUSALS`), each saying what to do instead; held to the host's by
    /// scripts/ios-share-fixture.test.ts.
    public static let refusals = [
        "Guest links open TempCode documents. Save As a TempCode document to share this one.",
        "Guest links open TempCode sheets. Save As a TempCode sheet to share this one.",
        "This file lives in Teams. Share it from Teams.",
        "This document is a Teams file opened here. Share it from Teams.",
        "This file lives in Google Drive. Share it from Google.",
        "This file is in a place others open. Share it from there.",
        "That file is not there any more.",
        "This document is saved to another file as it changes, so a guest can view it but not edit it.",
        "That file is not the one the thread asked to share any more. Nothing was made.",
        "Guests reach files on the box only. Keep this file in a workspace on the box to share it.",
        "Guest links open TempCode documents and sheets only.",
    ]

    /// The refusal a host's words hold, whatever came before it: said as the sheet's line, not as a failure.
    public static func refusal(in message: String) -> String? {
        refusals.first { message.contains($0) }
    }

    /// The host that keeps this item's links, when the one asked said another does (`served elsewhere: <env>`).
    public static func elsewhere(_ message: String) -> String? {
        guard let range = message.range(of: "served elsewhere: ") else { return nil }
        let rest = message[range.upperBound...].prefix { !$0.isWhitespace && $0 != "," && $0 != ")" }
        return rest.isEmpty ? nil : String(rest)
    }

    /// The day `days` from now, at the time it is now.
    public static func expiresAt(days: Int, now: Date = Date()) -> Date {
        now.addingTimeInterval(Double(days) * 24 * 60 * 60)
    }

    /// A link that still opens: not revoked, not past its end.
    public static func isLive(_ link: GuestLinkRow, now: Date = Date()) -> Bool {
        link.revokedAt == nil && Double(link.expiresAt) > now.timeIntervalSince1970 * 1000
    }

    /// The item's live links, newest first.
    public static func live(_ links: [GuestLinkRow], now: Date = Date()) -> [GuestLinkRow] {
        links.filter { isLive($0, now: now) }.sorted { $0.createdAt > $1.createdAt }
    }

    /// "Edit · made Nov 20 · opened Nov 22, 3:10 PM · until Dec 20": what the guest may do (only where an item has
    /// more than one role) and the link's days, in one line.
    public static func facts(_ link: GuestLinkRow, roles: Int, calendar: Calendar = .current, locale: Locale = .current) -> String {
        func date(_ ms: Int) -> Date { Date(timeIntervalSince1970: Double(ms) / 1000) }
        let style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        func day(_ ms: Int) -> String { date(ms).formatted(style.month(.abbreviated).day()) }
        // The clock's narrow space reads as a space.
        func time(_ ms: Int) -> String { date(ms).formatted(style.hour().minute()).replacingOccurrences(of: "\u{202F}", with: " ") }
        let seen = link.open > 0 ? "in it now" : link.lastOpenedAt.map { "opened \(day($0)), \(time($0))" } ?? "not opened yet"
        let role = GuestLinkDraft.Role(rawValue: link.role.rawValue)?.title
        return [roles > 1 ? role : nil, "made \(day(link.createdAt))", seen, "until \(day(link.expiresAt))"].compactMap { $0 }.joined(separator: " · ")
    }

    /// A fresh key for one press of Create link: the host answers a repeat of it once, never making a second link.
    public static func newAttempt() -> String { PendingPress.newAttempt() }

    /// What a Create link answered: the address, shown once; or, for a repeat of its key, the link with no address.
    public enum Made: Equatable, Sendable {
        case address(String, link: GuestLinkRow)
        /// The link was made by an earlier try of this press; its address is not kept anywhere.
        case again(GuestLinkRow)
    }

    public static func made(_ answer: Methods.WorkGuestsCreate.Output) -> Made {
        if let url = answer.url, answer.again != true { return .address(url, link: answer.link) }
        return .again(answer.link)
    }

    /// Said where a repeat of the press found the link already made.
    public static let againWords = "The link was made. Its address showed once: Replace Address makes a new one."
    /// The ledger's ref for Replace Address on one link: one press on its way per link.
    public static func rekeyRef(_ linkId: String) -> String { "guest-link:\(linkId)" }
    /// The host's words for a press its restart cut off (guests/attempts.ts `ATTEMPT_CUT`).
    public static let cutWords = "The host restarted while making the link. Look in its live links before making another."
    /// Replace Address whose answer was lost, while the host is read back by its attempt key.
    public static let rekeyCheckingWords = "Checking whether the address was replaced."
    /// A lost Replace Address read back as done: the new address showed nowhere.
    public static let rekeyedWords = "The address was replaced. It showed once: Replace Address makes another."

    /// A Create whose answer was lost, while the host is read back by its attempt key.
    public static let checkingWords = "Checking whether the link was made."
    /// The serving host or its key changed while the owner's check asked: nothing was made.
    /// Share may close only once no press on a link is out: a Create or Replace Address answers with the address
    /// once, and only this sheet can show it, so Cancel, Done and the swipe wait for the answer or the refusal.
    public static func mayClose(creating: Bool, linkBusy: String?) -> Bool { !creating && linkBusy == nil }

    public static let movedWords = "Nothing was made: the link’s computer changed. Press Create again."
}

extension PressTruth {
    /// What the host says of a Create link by its attempt key: made; never heard (his to press again); refused in
    /// its words; may have gone. Nil while the host is still making it.
    public static func guest(_ answer: GuestAttempt) -> PressTruth? {
        switch answer.state {
        case .made: return .done
        case .none: return .waiting(rev: nil)
        case .making: return nil
        case .refused: return .failed(answer.words ?? "")
        case .unknown, .unrecognized: return .mayHaveGone
        }
    }
}
