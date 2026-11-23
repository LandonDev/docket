import Foundation
import TempCodeContract

/// A file's print pages on a host (the phone's reader, PF2): a PDF of what will print.
public struct PrintPages: Equatable, Sendable {
    /// Changes when the pages' bytes do; every read names it.
    public var rev: String
    public var size: Int
    /// How many pages the host is drawing, when it says.
    public var pages: Int?

    public init(rev: String, size: Int, pages: Int? = nil) {
        self.rev = rev
        self.size = size
        self.pages = pages
    }
}

/// Where Page Preview reads a file's print pages: the PDF itself, a deck's render, and for a document or a
/// sheet the host's own preview (`work.formats.preview`, `work.sheets.preview`) once a host has it. The
/// bytes shown are the bytes that print: they are read at one `rev`, and a frame of another fails the read.
public struct PagePreviewSource {
    public var open: @MainActor () async throws -> PrintPages
    public var read: @MainActor (_ rev: String, _ offset: Int, _ length: Int) async throws -> FileBytes

    public init(open: @escaping @MainActor () async throws -> PrintPages, read: @escaping @MainActor (_ rev: String, _ offset: Int, _ length: Int) async throws -> FileBytes) {
        self.open = open
        self.read = read
    }

    /// The pages whole. `opened` hears what the host said first (the page count for the loading line),
    /// `progress` the share read after each frame.
    @MainActor
    public func data(opened: (PrintPages) -> Void = { _ in }, progress: ((Double) -> Void)? = nil) async throws -> Data {
        let pages = try await open()
        opened(pages)
        do {
            return try await ChunkedRead.all(size: pages.size, expecting: pages.rev) { offset, length in
                let frame = try await read(pages.rev, offset, length)
                progress?(ChunkedRead.share(read: offset + length, of: pages.size))
                return frame
            }
        } catch ChunkedRead.Failure.changed {
            throw Moved()
        }
    }

    /// The file changed while its pages were read: what was read is not what would print.
    public struct Moved: LocalizedError, CustomStringConvertible, Equatable {
        public init() {}
        public var description: String { "The file changed while its pages were read." }
        public var errorDescription: String? { description }
    }

    /// "Drawing 5 pages", once the host has said how many.
    public static func loadingWords(pages: Int?) -> String? {
        guard let pages, pages > 0 else { return nil }
        return pages == 1 ? "Drawing 1 page" : "Drawing \(pages) pages"
    }
}
