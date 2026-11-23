import Foundation
import TempCodeContract

/// Where he stopped in a file (the phone's reader, PF1).
public struct ReaderPlace: Codable, Equatable, Sendable {
    /// From 1: a PDF's page, or a deck's page in the render that was shown.
    public var page: Int
    /// A deck's slide by its key: a slide keeps its key while its page moves.
    public var slide: String?
    /// The render the page was counted in.
    public var rev: String?

    public init(page: Int, slide: String? = nil, rev: String? = nil) {
        self.page = page
        self.slide = slide
        self.rev = rev
    }
}

/// The place he stopped, per file, for the last 200 files: by host and the file's key, kept across launches
/// and through a fold. A place is a number, never a part of the file.
@MainActor
public final class ReaderPlaces {
    public static let cap = 200
    public static let shared = ReaderPlaces()

    private struct Entry: Codable {
        var key: String
        var place: ReaderPlace
    }

    private let defaults: UserDefaults
    private let storeKey: String
    /// Oldest first: a kept place moves to the end, and the front falls off past the cap.
    private var entries: [Entry]

    public init(defaults: UserDefaults = .standard, storeKey: String = "work.reader.places") {
        self.defaults = defaults
        self.storeKey = storeKey
        entries = defaults.data(forKey: storeKey).flatMap { try? JSONDecoder().decode([Entry].self, from: $0) } ?? []
    }

    public var count: Int { entries.count }

    public func place(host: String, file: String) -> ReaderPlace? {
        let key = Self.key(host: host, file: file)
        return entries.last { $0.key == key }?.place
    }

    public func keep(_ place: ReaderPlace, host: String, file: String) {
        let key = Self.key(host: host, file: file)
        if entries.last?.key == key, entries.last?.place == place { return }
        entries.removeAll { $0.key == key }
        entries.append(Entry(key: key, place: place))
        if entries.count > Self.cap { entries.removeFirst(entries.count - Self.cap) }
        if let data = try? JSONEncoder().encode(entries) { defaults.set(data, forKey: storeKey) }
    }

    /// The page to open a file on, from 1, or nil for its start. A render that changed since keeps the
    /// page while it still exists; a deck follows its slide's key first, since a slide's page moves.
    public func page(host: String, file: String, pages: Int, slidePage: (String) -> Int? = { _ in nil }) -> Int? {
        guard let place = place(host: host, file: file) else { return nil }
        if let slide = place.slide, let page = slidePage(slide), (1...max(1, pages)).contains(page) { return page }
        return (1...max(1, pages)).contains(place.page) ? place.page : nil
    }

    static func key(host: String, file: String) -> String { "\(host)\n\(file)" }

    /// A file's key: where it lives, so the same file opened from a thread and from Files is one place.
    public static func fileKey(_ item: CanvasItem) -> String {
        switch item.source {
        case .file(let file): "file:\(file.host):\(file.path)"
        case .lifeos(let row): "lifeos:\(row.table.rawValue):\(row.id)"
        case .google(let file): "google:\(file.account):\(file.fileId)"
        default: "item:\(item.id)"
        }
    }
}
