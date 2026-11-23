import PDFKit
import SwiftUI
import TempCodeClient
import TempCodeContract

/// Page Preview (docs/IOS-DESIGN.md "A file on the phone"): the file as it will print, in the system's
/// viewer, continuous, with the page stamp at its foot and Print as the one bar item. The pages are the
/// host's (`PagePreviewSource`): what shows is what prints.
struct PagePreview: View {
    let client: EnvironmentClient
    let item: CanvasItem
    let source: PagePreviewSource
    @State private var progress = ReadProgress()
    /// "Drawing 5 pages", once the host has said how many.
    @State private var words: String?
    /// The pages on screen, for Print.
    @State private var pages: Data?
    /// Page Preview has no Ask of its own: the viewer draws none.
    @State private var commands = ReaderCommands(ownsAsk: true)

    var body: some View {
        ItemLoad(
            loading: { AnyView(ReaderLoading(progress: progress.share, words: words)) },
            read: { try await load() },
            onRead: { pages = $0 }
        ) { data, _ in
            PdfPages(data: data, filmstrip: false, onAsk: nil)
        }
        .environment(commands)
        .background(Surface.chrome)
        .navigationTitle("Page Preview")
        .navigationBarTitleDisplayMode(.inline)
        .tcNavigationBar()
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Print", systemImage: "printer") { if let pages { Self.print(pages, name: item.title) } }
                    .disabled(pages == nil)
                    .accessibilityIdentifier("preview-print")
            }
        }
        .accessibilityIdentifier("page-preview")
    }

    private func load() async throws -> Data {
        let data = try await source.data(opened: { words = PagePreviewSource.loadingWords(pages: $0.pages) }, progress: { progress.share = $0 })
        guard DeckRender.opens(pageCount: PDFDocument(data: data)?.pageCount) else { throw Unreadable() }
        return data
    }

    /// The system's print sheet over the pages shown.
    private static func print(_ pages: Data, name: String) {
        let printer = UIPrintInteractionController.shared
        let info = UIPrintInfo(dictionary: nil)
        info.jobName = name
        info.outputType = .general
        printer.printInfo = info
        printer.printingItem = pages
        printer.present(animated: true)
    }

    private struct Unreadable: LocalizedError, CustomStringConvertible {
        var description: String { "The pages did not open." }
        var errorDescription: String? { description }
    }
}
