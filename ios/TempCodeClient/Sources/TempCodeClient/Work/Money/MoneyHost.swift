import Foundation
import TempCodeContract

/// One host's Money calls (`WorkHost`; a stand-in in tests).
@MainActor public protocol MoneyHost: AnyObject, Sendable {
    var hostId: String { get }
    /// The jobs this host keeps, each with its sector and starting categories.
    func moneyState() async throws -> MoneyState
    /// The host's one parser on the phone's own lines.
    func parse(lines: [ReceiptTextLine], sector: String?) async throws -> MoneyReceiptFields
    /// One part of a receipt's bytes; the last part's answer says where it went.
    func receive(_ part: ReceiptPart) async throws -> MoneyReceived
}

/// One `work.money.receive`: part `part` of `parts` of one receipt, all under
/// one key, each carrying the lines and the fields (the host reads them once
/// the file is whole).
public struct ReceiptPart: Hashable, Sendable {
    public typealias Fields = Methods.WorkMoneyReceive.Params.Fields

    public var key: String
    public var sector: String
    public var name: String
    public var mime: String
    public var part: Int
    public var parts: Int
    public var data: Data
    public var lines: [ReceiptTextLine]?
    public var fields: Fields
    /// A host's parser answered and he saw its result in the fields: what he left empty stays empty on the desktop.
    public var seen: Bool

    public init(key: String, sector: String, name: String, mime: String, part: Int, parts: Int, data: Data, lines: [ReceiptTextLine]?, fields: Fields, seen: Bool = false) {
        self.key = key
        self.sector = sector
        self.name = name
        self.mime = mime
        self.part = part
        self.parts = parts
        self.data = data
        self.lines = lines
        self.fields = fields
        self.seen = seen
    }

    /// The host's limits: 2,000 lines of at most 500 characters.
    static let linesMax = 2000
    static let textMax = 500

    var wireLines: [Methods.WorkMoneyReceive.Params.Line]? {
        lines.map { lines in
            lines.prefix(Self.linesMax).map { .init(text: String($0.text.prefix(Self.textMax)), box: $0.box?.count == 4 ? $0.box : nil, score: $0.score) }
        }
    }

    public var params: Methods.WorkMoneyReceive.Params {
        .init(key: key, sector: sector, name: name, mime: mime, part: part, parts: parts, dataBase64: data.base64EncodedString(), lines: wireLines, fields: fields, seen: seen ? true : nil, source: .phone)
    }

    /// `work.money.parse`'s lines, held to the same limits.
    static func parseLines(_ lines: [ReceiptTextLine]) -> [Methods.WorkMoneyParse.Params.Line] {
        lines.prefix(ReceiptPart.linesMax).map { .init(text: String($0.text.prefix(ReceiptPart.textMax)), box: $0.box?.count == 4 ? $0.box : nil, score: $0.score) }
    }
}
