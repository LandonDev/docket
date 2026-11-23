import Foundation
import Observation
import TempCodeContract

/// One change waiting for his Accept or Reject: a document's block or a sheet's cell.
public struct ReviewRow: Identifiable, Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        /// A block's words before and after; an added block has no old words, a removed one no new.
        case block(old: String, new: String)
        /// A cell's value or formula before and after, at its address ("Budget!C4", or "C4").
        case cell(address: String, old: String, new: String)
    }

    public let id: String
    public let kind: Kind
    /// A sheet's change set: its cells came in one agent turn. Nil for a document.
    public let group: String?
    /// The agent's reason, the same for every row of its change.
    public let reason: String?
    /// The host's words when it refused this row's decision; the row stays.
    public internal(set) var refusal: String?
    /// What the host decides it by: a document's branch and block, or a sheet's suggestion.
    let branch: String?
    let target: String

    public init(id: String, kind: Kind, group: String? = nil, reason: String? = nil, refusal: String? = nil) {
        self.init(id: id, kind: kind, group: group, reason: reason, refusal: refusal, branch: nil, target: id)
    }

    init(id: String, kind: Kind, group: String?, reason: String?, refusal: String?, branch: String?, target: String) {
        self.id = id
        self.kind = kind
        self.group = group
        self.reason = reason
        self.refusal = refusal
        self.branch = branch
        self.target = target
    }
}

/// What an agent suggested on one document or sheet, a row per change (PF2):
/// a document's pending branches (`work.history.branches`, a row per block)
/// or a sheet's open suggestions (`work.sheets.open`, a row per cell), in the
/// host's order. A decision the host takes drops its row; one it refuses
/// keeps the row with the host's words. A screen reads again when `rev`
/// moves (the `work.docs` or `work.sheets` push).
@MainActor @Observable
public final class WorkReview {
    public enum Subject: Equatable, Sendable {
        case document(CanvasSource)
        case sheet(itemId: String)
    }

    public let subject: Subject
    public private(set) var rows: [ReviewRow] = []
    /// The host answered at least once.
    public private(set) var loaded = false
    /// The host's words for the last read that failed; nil once one succeeds.
    public private(set) var failure: String?
    /// A document's name in the service, once known (DocName).
    private var doc: String?
    /// Counts the reads, so an answer is taken only from the newest.
    @ObservationIgnored private var loads = 0

    @ObservationIgnored private let work: WorkHost

    public init(work: WorkHost, subject: Subject) {
        self.work = work
        self.subject = subject
        if case .document(let source) = subject { doc = DocName.known(source) }
    }

    public var count: Int { rows.count }
    /// "1 change", "3 changes".
    public var words: String { count == 1 ? "1 change" : "\(count) changes" }

    /// Moves with each `work.docs` push for the document, or `work.sheets` push for the sheet's item.
    public var rev: Int {
        switch subject {
        case .document: doc.flatMap { work.docsRev[$0] } ?? 0
        case .sheet(let itemId): work.sheetsRev[itemId] ?? 0
        }
    }

    /// The call that lists what waits: a host that does not know it has no review on the phone.
    var method: String {
        switch subject {
        case .document: "work.history.branches"
        case .sheet: "work.sheets.open"
        }
    }

    public func load() async {
        guard work.can.has(method) else { return }
        loads += 1
        let mine = loads
        do {
            let read: [ReviewRow]
            switch subject {
            case .document(let source):
                if doc == nil { doc = try await DocName.resolve(source, on: work.socket) }
                read = Self.rows(try await work.socket.request(Methods.WorkHistoryBranches.self, .init(source: source)))
            case .sheet(let itemId):
                read = Self.rows(try await work.socket.request(Methods.WorkSheetsOpen.self, .init(itemId: itemId)))
            }
            // A read that an earlier, slower one overtakes is dropped: the newest answer stands.
            guard mine == loads else { return }
            rows = read
            loaded = true
            failure = nil
        } catch {
            guard mine == loads else { return }
            if HostCan.saysUnknown(error) { return work.can.mark(method) }
            failure = ActionError.wrap(error).message
        }
    }

    /// Accept or reject one row. False when the host refused it: the row stays with its words.
    @discardableResult
    public func decide(_ row: ReviewRow, accept: Bool) async -> Bool {
        do {
            switch subject {
            case .document(let source):
                guard let branch = row.branch else { return false }
                _ = try await work.socket.request(Methods.WorkHistoryDecide.self, .init(source: source, branchId: branch, which: .array([row.target]), accept: accept))
                rows.removeAll { $0.id == row.id }
            case .sheet(let itemId):
                take(try await work.socket.request(Methods.WorkSheetsReview.self, .init(itemId: itemId, which: .object(.init(ids: [row.target])), verdict: accept ? .accept : .reject)))
            }
            return true
        } catch {
            refuse([row.id], ActionError.wrap(error).message)
            return false
        }
    }

    /// Accept or reject every row he sees, and nothing else: the host is sent the rows' own ids, branch by
    /// branch for a document, so a change an agent added since the list was read is never decided unseen.
    /// False when the host refused any: those rows stay with its words.
    @discardableResult
    public func decideAll(accept: Bool) async -> Bool {
        switch subject {
        case .document(let source):
            var branches: [String] = []
            for row in rows { if let branch = row.branch, !branches.contains(branch) { branches.append(branch) } }
            var all = true
            for branch in branches {
                do {
                    let seen = rows.filter { $0.branch == branch }.map(\.target)
                    _ = try await work.socket.request(Methods.WorkHistoryDecide.self, .init(source: source, branchId: branch, which: .array(seen), accept: accept))
                    rows.removeAll { $0.branch == branch && seen.contains($0.target) }
                } catch {
                    refuse(rows.filter { $0.branch == branch }.map(\.id), ActionError.wrap(error).message)
                    all = false
                }
            }
            return all
        case .sheet(let itemId):
            do {
                take(try await work.socket.request(Methods.WorkSheetsReview.self, .init(itemId: itemId, which: .object(.init(ids: rows.map(\.target))), verdict: accept ? .accept : .reject)))
                return true
            } catch {
                refuse(rows.map(\.id), ActionError.wrap(error).message)
                return false
            }
        }
    }

    /// The sheet as the review left it: its open suggestions, a refusal kept on a row still there.
    private func take(_ view: SheetPhoneView) {
        let refusals = Dictionary(rows.compactMap { row in row.refusal.map { (row.id, $0) } }, uniquingKeysWith: { first, _ in first })
        rows = Self.rows(view).map { row in
            var row = row
            row.refusal = refusals[row.id]
            return row
        }
    }

    private func refuse(_ ids: [String], _ words: String) {
        for index in rows.indices where ids.contains(rows[index].id) { rows[index].refusal = words }
    }

    /// A row per block of each branch; the branch's label is its reason.
    static func rows(_ answer: HistoryBranchesPhone) -> [ReviewRow] {
        answer.branches.flatMap { branch in
            branch.diff.rows.map { block in
                ReviewRow(
                    id: "\(branch.id)/\(block.id)",
                    kind: .block(old: block.left?.text ?? "", new: block.right?.text ?? ""),
                    group: nil,
                    reason: branch.label.isEmpty ? nil : branch.label,
                    refusal: nil,
                    branch: branch.id,
                    target: block.id
                )
            }
        }
    }

    /// A row per open suggestion (pending, or one the host found in conflict or orphaned: it refuses an Accept of those
    /// in its own words). The view names a sheet by Univer's id, not its tab's name, so an address is the cell alone.
    static func rows(_ view: SheetPhoneView) -> [ReviewRow] {
        view.suggestions
            .filter { $0.state == .pending || $0.state == .conflict || $0.state == .orphaned }
            .map { suggestion in
                ReviewRow(
                    id: suggestion.id,
                    kind: .cell(address: CellAddress.of(sheet: nil, row: suggestion.row, col: suggestion.col), old: cellWords(suggestion.base), new: cellWords(suggestion.proposed)),
                    group: suggestion.changeSet,
                    reason: suggestion.reason,
                    refusal: nil,
                    branch: nil,
                    target: suggestion.id
                )
            }
    }

    /// A cell as he would type it: its formula, else its value; an empty cell is "".
    static func cellWords(_ cell: SheetCellPhone?) -> String {
        guard let cell else { return "" }
        if let formula = cell.f, !formula.isEmpty { return formula.hasPrefix("=") ? formula : "=" + formula }
        switch cell.v {
        case .string(let text)?: return text
        case .number(let number)?:
            if number.rounded() == number, abs(number) < 1e15 { return String(Int64(number)) }
            return String(number)
        case .bool(let flag)?: return flag ? "TRUE" : "FALSE"
        case .unknown?, nil: return ""
        }
    }
}

/// A cell's address as Excel writes it: the sheet, `!`, the column's letters
/// and the row from 1 ("Budget!C4"). Rows and columns come from Univer, from 0.
public enum CellAddress {
    /// Column 0 is "A", 25 "Z", 26 "AA".
    public static func column(_ col: Int) -> String {
        var letters = ""
        var n = col + 1
        while n > 0 {
            let rest = (n - 1) % 26
            letters.insert(Character(Unicode.Scalar(UInt8(65 + rest))), at: letters.startIndex)
            n = (n - 1) / 26
        }
        return letters
    }

    /// A sheet name that is not a plain word is quoted, an apostrophe in it doubled ("'Q1 Budget'!C4"); no sheet is the cell alone.
    public static func of(sheet: String?, row: Int, col: Int) -> String {
        let cell = "\(column(col))\(row + 1)"
        guard let sheet, !sheet.isEmpty else { return cell }
        let plain = sheet.first.map { !$0.isNumber } == true && sheet.allSatisfy { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "." }
        return plain ? "\(sheet)!\(cell)" : "'\(sheet.replacingOccurrences(of: "'", with: "''"))'!\(cell)"
    }
}
