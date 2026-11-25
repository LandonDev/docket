import Foundation
import TempCodeContract

/// What a message is about, as the model reads it: the desktop's `chipLine`
/// and `withContextChips` (src/renderer/src/work/canvas/chips.ts), word for word.
public enum ChipWords {
    public static func line(_ chip: ContextChip) -> String {
        // One line, whatever the label holds: a label that ran onto a second line would read as his own words.
        let label = chip.label.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        let head = "About this \(noun(chip.kind)): \(label) (\(refWords(chip)))"
        let under = under(chip)
        guard !under.isEmpty else { return head }
        return head + "\n" + under.split(separator: "\n", omittingEmptySubsequences: false).map { "> \($0)" }.joined(separator: "\n")
    }

    /// What the line quotes under it (`chipUnder`): a selection's words, else its quote or a mention's excerpt; for a
    /// file, where it is and never a word from inside it.
    static func under(_ chip: ContextChip) -> String {
        if chip.kind == .file {
            guard let w = chip.where else { return "" }
            return "In \(w.name) (place \(w.place)) at \(w.path).\(w.shared == true ? " Others can open it." : "")"
        }
        return (chip.kind == .selection ? chip.quote : (chip.quote ?? chip.excerpt))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    /// The desktop's `CHIP_NOUN` (src/shared/work/canvas.ts).
    public static func noun(_ kind: ContextChip.Kind) -> String {
        switch kind {
        case .doc: "document"
        case .held: "held act"
        case .chat: "conversation"
        case .msform: "Microsoft form"
        default: kind.rawValue
        }
    }

    /// The kind a sent line's noun names (the inverse of `noun`), for the bubble's glyph.
    public static func kind(ofNoun noun: String) -> ContextChip.Kind {
        switch noun {
        case "document": .doc
        case "held act": .held
        case "conversation": .chat
        case "Microsoft form": .msform
        default: ContextChip.Kind(rawValue: noun)
        }
    }

    /// The message as sent: the chips' lines, then his words; a slash command stays first.
    public static func message(_ chips: [ContextChip], text: String) -> String {
        guard !chips.isEmpty else { return text }
        let lines = chips.map(line).joined(separator: "\n")
        if text.isEmpty { return lines }
        return text.hasPrefix("/") ? "\(text)\n\n\(lines)" : "\(lines)\n\n\(text)"
    }

    /// Where a chip points, in words a model acts on (`chipRefWords`): a file's or a form's source as JSON with its
    /// brackets escaped, so a name with brackets in it still reads back as one chip.
    public static func refWords(_ chip: ContextChip) -> String {
        if chip.kind == .file || chip.kind == .msform {
            return jsonWords(chip.ref).replacingOccurrences(of: "(", with: "\\u0028").replacingOccurrences(of: ")", with: "\\u0029")
        }
        switch chip.ref {
        case .object(let lifeos): return "LifeOS \(lifeos.table.rawValue) \(lifeos.id)"
        case .canvasSource(.lifeos(let source)): return "LifeOS \(source.table.rawValue) \(source.id)"
        case .canvasSource(.file(let file)): return file.path
        case .canvasSource(let source): return jsonWords(source)
        case .object2(let item): return "canvas item \(item.id)"
        case .object3(let row): return "Work \(row.pillar.rawValue) \(row.id)"
        case .unknown(let value): return jsonWords(value)
        }
    }

    private static func jsonWords(_ value: some Encodable) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        return (try? encoder.encode(value)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }

    /// A LifeOS task, mail thread or event as a chip.
    public static func lifeos(_ kind: ContextChip.Kind, table: ContextChip.RefCase0.Table, id: String, label: String) -> ContextChip {
        ContextChip(kind: kind, label: label, ref: .object(.init(at: "lifeos", table: table, id: id)))
    }

    /// A whole file, for Ask with nothing picked in it.
    public static func item(_ item: CanvasItem) -> ContextChip {
        ContextChip(kind: .item, label: item.title, ref: .canvasSource(item.source))
    }

    /// Words picked in an item, for Ask.
    public static func selection(in item: CanvasItem, quote: String, label: String? = nil) -> ContextChip {
        ContextChip(kind: .selection, label: label ?? item.title, ref: .canvasSource(item.source), quote: quote)
    }
}
