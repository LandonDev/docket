import Foundation
import TempCodeContract

/// What a file's open shows while the whole file reads (M17): a PDF's first page as the host drew it (a PNG,
/// `work.pdf.first`), or a deck's first slide as its own one-page PDF (`work.slides.slide`). Always of the one
/// `rev` the view named, read in one ask, and small: a picture larger than `bytesMax` is not read at all.
public struct FirstPicture: Sendable, Equatable {
    public enum Kind: Sendable, Equatable {
        case png
        case pdf
    }

    public var kind: Kind
    public var data: Data
    /// The rev of the file it was drawn from: a PDF's, or a deck's render the view named beside the slide.
    public var rev: String

    public init(kind: Kind, data: Data, rev: String) {
        self.kind = kind
        self.data = data
        self.rev = rev
    }

    /// The host's caps (`PDF_FIRST_WIDTH_MAX`, `PDF_FIRST_BYTES_MAX` in contract-work-pdf.ts).
    public static let widthMax = 1600
    public static let bytesMax = 3 * 1024 * 1024

    /// The width in pixels to ask a first page at: the reader's measure at the screen's scale, within the host's cap.
    public static func width(points: Double, scale: Double) -> Int {
        max(64, min(widthMax, Int((points * scale).rounded())))
    }

    /// A PDF's first page as the host answered it, only when it is of `rev`.
    public static func of(_ page: PdfFirstPage, rev: String) -> FirstPicture? {
        guard page.rev == rev, let data = Data(base64Encoded: page.png), !data.isEmpty, data.count <= bytesMax else { return nil }
        return FirstPicture(kind: .png, data: data, rev: rev)
    }

    /// The slide a deck's render draws first, with its own picture, when the host keeps one small enough to read in one ask.
    public static func firstSlide(of deck: DeckPhoneView, proposed: Bool) -> (id: Int, pic: DeckPhoneView.Slide.Pic)? {
        let from: DeckPhoneView.Slide.From = proposed ? .proposed : .file
        guard let slide = deck.slides.first(where: { $0.page == 1 && $0.from == from }), let id = slide.id, let pic = slide.pic,
              pic.size > 0, Int(pic.size) <= bytesMax else { return nil }
        return (id, pic)
    }

    /// A slide's own picture as one frame answered it: whole, and of the picture's rev (`pic`) the view named beside
    /// the render's `rev`, so it is that render's first slide and kept by that render's rev.
    public static func of(_ frame: FileBytes, pic: String, render rev: String) -> FirstPicture? {
        guard frame.rev == pic, let data = Data(base64Encoded: frame.data), !data.isEmpty, data.count == Int(frame.size) else { return nil }
        return FirstPicture(kind: .pdf, data: data, rev: rev)
    }
}
