import Foundation

/// One run of text the phone's reader found on a scan, and where it stands:
/// `box` is left, top, right, bottom in the picture's own pixels with the
/// origin at the top left, pages stacked top to bottom. The host's one parser
/// reads these (`work.money.parse`); the phone never parses.
public struct ReceiptTextLine: Codable, Hashable, Sendable {
    public var text: String
    public var box: [Double]?
    public var score: Double?

    public init(text: String, box: [Double]? = nil, score: Double? = nil) {
        self.text = text
        self.box = box
        self.score = score
    }
}

/// The phone's reader, behind a seam so a receipt is tested without Vision
/// (the app's `OnDeviceText` is the real one, on the phone only).
@MainActor public protocol TextSource: AnyObject {
    /// The lines of every page, in reading order, a later page below the one before.
    func lines(of pages: [Data]) async throws -> [ReceiptTextLine]
}
