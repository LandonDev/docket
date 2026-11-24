import Foundation
import TempCodeContract

/// What the phone draws for a thread's item (milestone 47): the hosted
/// editor in a web view for a document or a sheet (LifeOS's, or one kept as
/// a file, which its host opens or refuses in its own words), the phone's
/// own view for the rest, and a sentence where neither can open it.
public enum ItemBody: Equatable, Sendable {
    /// `/w/open` through `work.guests.ticket`: on the host that serves LifeOS's documents for a LifeOS row, on
    /// the file's own host for a document or sheet kept as a file (named by its item).
    case hosted(Methods.WorkGuestsTicket.Params.Source)
    case pdf, slides, media, meeting, browser, form, dashboard
    /// A version list and a compare against now.
    case history(CanvasSource)
    /// A held draft: its mail, read from LifeOS.
    case mail(draftId: String)
    /// Not on the phone: the words say why.
    case unavailable(String)

    public static func of(_ item: CanvasItem) -> ItemBody {
        switch item.kind {
        case .document, .sheet:
            switch item.source {
            case .lifeos(let source):
                if let table = hostedTable(source.table) { return .hosted(.object(.init(at: "lifeos", table: table, id: source.id))) }
            case .file:
                // Its host says whether the hosted editor opens it (a .tcdoc, a .tcsheet in a place of his own).
                return .hosted(.object1(.init(at: "item", itemId: item.id)))
            default:
                break
            }
            return .unavailable(elsewhere(item.kind))
        case .pdf: return .pdf
        case .slides: return .slides
        case .media: return .media
        case .meeting: return .meeting
        case .browser: return .browser
        case .form: return .form
        case .dashboard: return .dashboard
        case .history: return .history(item.source)
        case .mail:
            if case .lifeos(let source) = item.source, source.table == .outbox { return .mail(draftId: source.id) }
            return .unavailable("This mail opens in Mail.")
        case .file:
            // A thread's canvas seats no `file` item until it has the tools for them (F5); the Files place opens it in Quick Look.
            return .unavailable("This file opens in Files.")
        case .unknown:
            return .unavailable("This item opens on the computer.")
        }
    }

    /// Where a document or sheet opens when the phone cannot.
    static func elsewhere(_ kind: CanvasItem.Kind) -> String {
        kind == .sheet ? "This sheet opens on the computer that has it." : "This document opens on the computer that has it."
    }

    /// The item is a file its own host opens, not a LifeOS row: it takes no guest link, and a refusal is the host's to word.
    public var isFileKept: Bool {
        if case .hosted(.object1) = self { return true }
        return false
    }

    private static func hostedTable(_ table: LifeosSource.Table) -> Methods.WorkGuestsTicket.Params.SourceCase0.Table? {
        switch table {
        case .docs: .docs
        case .sheets: .sheets
        default: nil
        }
    }

    /// The hosted kinds take a guest link from their More menu.
    public var guestSource: Methods.WorkGuestsCreate.Params.Source? {
        guard case .hosted(.object(let source)) = self else { return nil }
        return .init(at: source.at, table: source.table == .sheets ? .sheets : .docs, id: source.id)
    }
}

/// The pager's segment label: the item's name, cut to fit the bar.
public enum ItemLabel {
    public static func short(_ title: String, limit: Int = 18) -> String {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > limit else { return trimmed.isEmpty ? "Item" : trimmed }
        return String(trimmed.prefix(limit - 1)).trimmingCharacters(in: .whitespaces) + "…"
    }
}

/// Why the hosted editor did not open (the phone-files plan, PF4). A file's host may refuse it in words of
/// its own (a Word file, a file others can open, a computer no phone reaches): those words stand, and there
/// is nothing to try again. A key that may only read is told so, whatever the item: the editor needs a key that
/// may act, and Try Again would be refused for ever. Anything else is a page that did not answer.
public enum HostedFailure: Equatable, Sendable {
    case refused(String)
    case unreachable

    public static let readOnly = "This key can read but not open the editor. Open it on your computer."

    public static func of(_ error: any Error, item: CanvasItem) -> HostedFailure {
        if case .refused(_, forbidden: true) = ActionError.wrap(error) { return .refused(readOnly) }
        guard ItemBody.of(item).isFileKept, case .refused(let message, _) = ActionError.wrap(error) else { return .unreachable }
        // Another host of his has the file, or a host from before files opened here: the phone says where it opens.
        if message.hasPrefix("served elsewhere") || message.hasPrefix("bad request") { return .refused(ItemBody.elsewhere(item.kind)) }
        return .refused(message)
    }
}
