import Foundation
import TempCodeContract

/// What the phone draws for a thread's item (milestone 47): the hosted
/// editor in a web view for a LifeOS document or sheet, the phone's own
/// view for the rest, and a sentence where neither can open it.
public enum ItemBody: Equatable, Sendable {
    /// `/w/open` on the host that serves LifeOS's documents, through `work.guests.ticket`.
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
            guard case .lifeos(let source) = item.source, let table = hostedTable(source.table) else {
                return .unavailable(item.kind == .sheet ? "This sheet opens on the computer that has it." : "This document opens on the computer that has it.")
            }
            return .hosted(.init(at: "lifeos", table: table, id: source.id))
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
        case .unknown:
            return .unavailable("This item opens on the computer.")
        }
    }

    private static func hostedTable(_ table: LifeosSource.Table) -> Methods.WorkGuestsTicket.Params.Source.Table? {
        switch table {
        case .docs: .docs
        case .sheets: .sheets
        default: nil
        }
    }

    /// The hosted kinds take a guest link from their More menu.
    public var guestSource: Methods.WorkGuestsCreate.Params.Source? {
        guard case .hosted(let source) = self else { return nil }
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
