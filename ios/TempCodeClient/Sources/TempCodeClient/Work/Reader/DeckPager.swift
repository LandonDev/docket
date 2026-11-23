import Foundation
import TempCodeContract

/// A deck one slide to a page (the phone's reader, PF1): the slides of the render that shows, in its page
/// order. Page n of a render is slide n of that deck, hidden slides included, so a hidden slide keeps its
/// page and says so; a slide the changes take out lives in the file's render alone and is no page of the
/// proposed one.
public struct DeckPager: Equatable, Sendable {
    public struct Page: Equatable, Sendable, Identifiable {
        public var key: String
        /// From 1, in the render.
        public var page: Int
        public var title: String
        public var notes: String
        public var hidden: Bool

        public var id: Int { page }
    }

    public let pages: [Page]
    /// The render's own page count: the stamp counts what PDFKit opened.
    public let count: Int
    /// The host sends speaker notes (a host from before them sends none): the notes' room is then there for
    /// every deck, and a slide without any says "No notes", whether or not another slide has some.
    public let hasNotes: Bool

    public init(_ deck: DeckPhoneView, render: DeckRender, count: Int) {
        let from: DeckPhoneView.Slide.From = render == .proposed ? .proposed : .file
        pages = deck.slides
            .filter { $0.from == from && $0.page >= 1 && $0.page <= count }
            .sorted { $0.page < $1.page }
            .map { Page(key: $0.key, page: $0.page, title: $0.title, notes: ($0.notes ?? "").trimmingCharacters(in: .whitespacesAndNewlines), hidden: $0.hidden) }
        self.count = count
        hasNotes = deck.slides.contains { $0.notes != nil }
    }

    public func slide(at page: Int) -> Page? { pages.first { $0.page == page } }

    /// A slide's page by its key, which holds while a new render moves the page.
    public func page(for key: String) -> Int? { pages.first { $0.key == key }?.page }

    public func notes(at page: Int) -> String { slide(at: page)?.notes ?? "" }

    /// "4 of 12", as the PDF's stamp reads.
    public func stamp(at page: Int) -> String { "\(min(max(1, page), max(1, count))) of \(max(1, count))" }

    /// How a deck's page divides its height: the slide over its notes over the filmstrip.
    public struct Layout: Equatable, Sendable {
        /// The slide's height; nil lets it take all the room the foot leaves.
        public var slide: Double?
        public var notes: Bool
    }

    /// The least room worth giving the notes: two lines and their inset.
    public static let notesFloor = 88.0
    /// The most of the height the slide takes while notes show under it.
    public static let slideShare = 0.62

    /// The slide keeps its own shape at the column's width, capped so the notes keep a share. Where the
    /// room under it is less than two lines (a phone on its side), the notes give way and the slide takes it.
    public static func layout(width: Double, height: Double, aspect: Double, filmstrip: Double, hasNotes: Bool) -> Layout {
        guard hasNotes, width > 0, height > 0, aspect > 0 else { return Layout(slide: nil, notes: false) }
        let slide = min(width / aspect, height * slideShare)
        guard height - slide - filmstrip >= notesFloor else { return Layout(slide: nil, notes: false) }
        return Layout(slide: slide, notes: true)
    }
}
