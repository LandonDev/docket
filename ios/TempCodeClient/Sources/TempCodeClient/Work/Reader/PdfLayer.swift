import Foundation
import TempCodeContract

/// What the phone's reader draws over a PDF's pages (docs/agents/work-phone-files.md "Highlights, notes and
/// fields"): his highlights with their notes, and a form's fields with the values the copy that leaves will
/// carry. The file is never written: each is a row on the host (`work.pdf.mark`, `unmark`, `setField`,
/// `review`), and every press answers the view as the host now draws it. Pure: the app maps these onto PDFKit.
public enum PdfBox {
    /// A box as shares of the page (`Bbox`: x0, y0, x1, y1, origin top left) in the page's own space, whose origin
    /// is its bottom left. Nil for a box that is not four numbers or has no area.
    public static func rect(_ box: [Double], page: CGRect) -> CGRect? {
        guard box.count == 4 else { return nil }
        let x0 = min(max(box[0], 0), 1), y0 = min(max(box[1], 0), 1), x1 = min(max(box[2], 0), 1), y1 = min(max(box[3], 0), 1)
        guard x1 > x0, y1 > y0 else { return nil }
        return CGRect(
            x: page.minX + x0 * page.width,
            y: page.maxY - y1 * page.height,
            width: (x1 - x0) * page.width,
            height: (y1 - y0) * page.height
        )
    }

    /// A rect in the page's space as the shares the host keeps, held to the page. Nil for an empty page or a rect
    /// that misses it.
    public static func share(_ rect: CGRect, page: CGRect) -> [Double]? {
        guard page.width > 0, page.height > 0 else { return nil }
        let held = rect.intersection(page)
        guard !held.isNull, held.width > 0, held.height > 0 else { return nil }
        return [
            (held.minX - page.minX) / page.width,
            (page.maxY - held.maxY) / page.height,
            (held.maxX - page.minX) / page.width,
            (page.maxY - held.minY) / page.height
        ]
    }

    /// One box per line of a selection, as `work.pdf.mark` takes them: at most 200, the host's cap.
    public static func quads(lines: [CGRect], page: CGRect) -> [[Double]] {
        Array(lines.compactMap { share($0, page: page) }.prefix(200))
    }
}

/// The reader's own annotations are named, so a tap on one finds its highlight or field again and a new view takes
/// every one of them off before it draws.
public enum PdfLayerName {
    /// What a tap on the page found: one of his highlights, or a field.
    public enum Pick: Hashable, Identifiable, Sendable {
        case mark(String)
        case field(String)

        public var id: String {
            switch self {
            case .mark(let id): "mark:\(id)"
            case .field(let key): "field:\(key)"
            }
        }
    }

    static let markPrefix = "tc-mark:"
    static let fieldPrefix = "tc-field:"

    public static func mark(_ markId: String) -> String { markPrefix + markId }
    public static func field(_ key: String) -> String { fieldPrefix + key }

    /// One the reader drew (never the file's own).
    public static func ours(_ name: String?) -> Bool {
        guard let name else { return false }
        return name.hasPrefix(markPrefix) || name.hasPrefix(fieldPrefix)
    }

    /// The highlight or field a name of ours, or a widget of the file named for one of `fields`, points at.
    public static func pick(name: String?, widget: String? = nil, fields: Set<String> = []) -> Pick? {
        if let name, name.hasPrefix(markPrefix), name.count > markPrefix.count { return .mark(String(name.dropFirst(markPrefix.count))) }
        if let name, name.hasPrefix(fieldPrefix), name.count > fieldPrefix.count { return .field(String(name.dropFirst(fieldPrefix.count))) }
        if let widget, fields.contains(widget) { return .field(widget) }
        return nil
    }
}

/// A form's fields as the reader shows and fills them.
public enum PdfFields {
    /// What a field shows on the page: an agent's value while it waits, else the value the copy will carry.
    public static func shown(_ field: PdfFieldPhone) -> String? {
        if field.state == .proposed, let proposed = field.proposed { return words(proposed) }
        return field.value.flatMap(words)
    }

    /// The fields an agent filled that wait on his word, in reading order: page, then top to bottom, then left to right.
    public static func waiting(_ fields: [PdfFieldPhone]) -> [PdfFieldPhone] {
        fields.filter { $0.state == .proposed }.sorted { a, b in
            if a.page != b.page { return a.page < b.page }
            let ay = a.bbox.count == 4 ? a.bbox[1] : 0, by = b.bbox.count == 4 ? b.bbox[1] : 0
            if ay != by { return ay < by }
            return (a.bbox.first ?? 0) < (b.bbox.first ?? 0)
        }
    }

    /// The review row's count: "1 value to check", "3 values to check".
    public static func waitingWords(_ count: Int) -> String {
        count == 1 ? "1 value to check" : "\(count) values to check"
    }

    /// Where the shown value came from, as one line: "From Purdue profile: “Landon Hale”".
    public static func source(_ field: PdfFieldPhone) -> String? {
        guard let first = field.provenance.first else { return nil }
        guard let quote = first.quote?.trimmingCharacters(in: .whitespacesAndNewlines), !quote.isEmpty else { return "From \(first.label)" }
        return "From \(first.label): “\(quote)”"
    }

    /// He may type his own value: a signature and the day he signed are placed by his press on the computer, where
    /// his drawn signature is (`work.pdf.sign` needs approve and the pad).
    public static func fills(_ field: PdfFieldPhone) -> Bool {
        switch field.type {
        case "text", "checkbox", "choice": true
        case "date": field.state != .needsOwner
        default: false
        }
    }

    /// His typed words as the value `work.pdf.setField` takes: a checkbox's on or off, an empty field null.
    public static func value(_ text: String, for field: PdfFieldPhone) -> Methods.WorkPdfSetField.Params.Value? {
        if field.type == "checkbox" { return .bool(text == checked) }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : .string(trimmed)
    }

    /// A checkbox's words for on, the value `value(_:for:)` reads back.
    public static let checked = "Yes"

    private static func words(_ value: PdfFieldPhone.Value) -> String? {
        switch value {
        case .string(let text): text.isEmpty ? nil : text
        case .bool(let flag): flag ? checked : nil
        case .unknown: nil
        }
    }

    private static func words(_ value: PdfFieldPhone.Proposed) -> String? {
        switch value {
        case .string(let text): text.isEmpty ? nil : text
        case .bool(let flag): flag ? checked : nil
        case .unknown: nil
        }
    }

    /// The field a widget of the file names (its full name), or an overlay's own key.
    public static func field(named name: String?, in fields: [PdfFieldPhone]) -> PdfFieldPhone? {
        guard let name else { return nil }
        return fields.first { $0.key == name }
    }
}
