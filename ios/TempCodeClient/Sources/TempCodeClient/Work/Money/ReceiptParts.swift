import Foundation

/// A receipt's bytes in the parts `work.money.receive` takes: at most 2 MiB
/// each, in order (the host's `MONEY_PART_BYTES`, an attachment's chunk).
public enum ReceiptParts {
    public static let maxBytes = 2 * 1024 * 1024

    /// The parts, the last one shorter; empty bytes are one empty part, so the host still hears of it.
    public static func cut(_ data: Data, max: Int = maxBytes) -> [Data] {
        guard !data.isEmpty else { return [Data()] }
        let step = Swift.max(1, max)
        return stride(from: 0, to: data.count, by: step).map { start in
            let from = data.startIndex + start
            return Data(data[from..<Swift.min(from + step, data.endIndex)])
        }
    }
}

/// What he types in Amount, as whole cents: "48.17", "$1,204.50", "12".
public enum ReceiptAmount {
    /// The host's ceiling: a billion dollars.
    static let maxCents = 100_000_000_000

    /// Whole cents, or nil for an empty field or anything that is not a sum
    /// above nothing with at most two places.
    public static func cents(_ text: String) -> Int? {
        var t = text.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("$") { t = String(t.dropFirst()).trimmingCharacters(in: .whitespaces) }
        let halves = t.split(separator: ".", omittingEmptySubsequences: false)
        guard (1...2).contains(halves.count) else { return nil }
        let whole = String(halves[0])
        let fraction = halves.count == 2 ? String(halves[1]) : ""
        guard let dollars = Self.dollars(whole), fraction.count <= 2, fraction.allSatisfy(\.isASCIIDigit) else { return nil }
        guard !whole.isEmpty || !fraction.isEmpty else { return nil }
        let cents = dollars * 100 + (Int((fraction + "00").prefix(2)) ?? 0)
        return (1...maxCents).contains(cents) ? cents : nil
    }

    /// The whole dollars: plain digits, or digits grouped in threes by commas.
    private static func dollars(_ whole: String) -> Int? {
        if whole.isEmpty { return 0 }
        let groups = whole.split(separator: ",", omittingEmptySubsequences: false)
        guard groups.allSatisfy({ !$0.isEmpty && $0.allSatisfy(\.isASCIIDigit) }) else { return nil }
        if groups.count > 1, !(1...3).contains(groups[0].count) || groups.dropFirst().contains(where: { $0.count != 3 }) { return nil }
        let digits = groups.joined()
        guard digits.count <= 10 else { return nil }
        return Int(digits)
    }

    /// Cents as the field shows them: "10.43".
    public static func text(_ cents: Int) -> String {
        "\(cents / 100).\(cents % 100 < 10 ? "0" : "")\(cents % 100)"
    }
}

private extension Character {
    var isASCIIDigit: Bool { isASCII && isNumber }
}
