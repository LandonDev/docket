import PDFKit
import SwiftUI
import TempCodeClient
import TempCodeContract

/// A PDF item (milestone 47): the file in the system's viewer, read from the
/// host in frames, with the page capsule over its foot and Ask in the row
/// above (the selection, else the page).
struct PdfItemView: View {
    let client: EnvironmentClient
    let item: CanvasItem
    let ask: (ContextChip) -> Void

    var body: some View {
        ItemLoad(read: {
            let view = try await client.work.canvas.pdf(item.id)
            let data = try await client.work.canvas.pdfData(view)
            // Only bytes PDFKit opens with a page reach the viewer; anything else is the item's failure with Try Again,
            // never a blank viewer saying "1 of 1" (as the deck does, `DeckRender.opens`).
            guard DeckRender.opens(pageCount: PDFDocument(data: data)?.pageCount) else { throw PdfUnreadable() }
            return data
        }) { data, _ in
            PdfPages(data: data, filmstrip: false, onAsk: { quote in ask(ChipWords.selection(in: item, quote: quote)) })
        }
        .accessibilityIdentifier("pdf-item")
    }
}

/// A PDF's bytes that PDFKit cannot open as a document with a page. Its `description` is the sentence, since
/// `ActionError.wrap` words an error it does not know by `String(describing:)`.
private struct PdfUnreadable: LocalizedError, CustomStringConvertible {
    var description: String { "The PDF did not open." }
    var errorDescription: String? { description }
}

/// A deck (milestone 47): its render, a PDF, with the filmstrip under it. While the agent's changes
/// wait the proposed render shows, with the review row: how many, Reject All and Accept All.
struct SlidesItemView: View {
    let client: EnvironmentClient
    let item: CanvasItem
    let ask: (ContextChip) -> Void
    @State private var deciding = false
    @State private var error: String?

    private struct Loaded {
        var deck: DeckPhoneView
        var data: Data
        var render: DeckRender
        /// The render's rev as the view advertised it: the bytes read are that render's, and a decision is bound to it.
        var rev: String
        /// Which render this is: a new one (after Accept or Reject, or the file's next version) gets a new viewer.
        var key: String { "\(deck.rev):\(render == .proposed ? "proposed" : "file")" }
    }

    var body: some View {
        // After a decision the deck reads afresh with its review off: the old preview, its count and its buttons never
        // stay live through the refresh, and a refresh that fails says so with Try Again.
        ItemLoad(dropsOnReload: true, read: { try await load() }) { loaded, reload in
            VStack(spacing: 0) {
                // The review row only over the render its changes propose (`DeckRender`).
                if loaded.render == .proposed, client.work.canApprove {
                    DeckReviewRow(words: loaded.deck.changes.count == 1 ? "1 change" : "\(loaded.deck.changes.count) changes", busy: deciding) { accept in
                        Task { await decide(accept, rev: loaded.rev, reload: reload) }
                    }
                    Divider()
                }
                PdfPages(data: loaded.data, filmstrip: true, onAsk: { quote in ask(ChipWords.selection(in: item, quote: quote)) })
                    .id(loaded.key)
            }
        }
        .alert("Couldn’t do that", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(error ?? "") }
        .accessibilityIdentifier("slides-item")
    }

    private func load() async throws -> Loaded {
        let deck = try await client.work.canvas.deck(item.id)
        let waiting = !deck.changes.isEmpty
        // While changes wait only their proposed render shows; a missing one is the Try Again state, never the
        // file's render under live Reject and Accept. The two renders are distinct generated types; only the size is read.
        guard let render = DeckRender.pick(changesWaiting: waiting, hasProposed: deck.renders.proposed != nil, hasFile: deck.renders.file != nil),
              let size = render == .proposed ? deck.renders.proposed?.size : deck.renders.file?.size,
              let rev = render == .proposed ? deck.renders.proposed?.rev : deck.renders.file?.rev else {
            throw DeckError.notRendered(deck.renderError ?? DeckRender.missingWords(changesWaiting: waiting))
        }
        // The bytes must be the render the view named: a read that meets another (the changes moved on) fails, for Try Again.
        let data = try await client.work.canvas.deckData(item.id, proposed: render == .proposed, size: Int(size), rev: rev)
        // The verdicts come only once PDFKit opens the bytes as a document with a page; a decode failure is Try Again.
        guard DeckRender.opens(pageCount: PDFDocument(data: data)?.pageCount) else { throw DeckError.notRendered(DeckRender.unreadable) }
        return Loaded(deck: deck, data: data, render: render, rev: rev)
    }

    /// Bound to the render he saw: the host refuses the press when the changes moved on since. Either way the deck
    /// reads afresh, so what shows next is the deck as it is now.
    private func decide(_ accept: Bool, rev: String, reload: () -> Void) async {
        deciding = true
        defer { deciding = false }
        do {
            _ = try await client.work.canvas.reviewDeck(item.id, accept: accept, rev: rev)
        } catch {
            self.error = ActionError.wrap(error).message
        }
        reload()
    }

    /// Its `description` is the sentence: `ActionError.wrap` words an error it does not know by `String(describing:)`,
    /// which would otherwise print the case ("notRendered(…)").
    private enum DeckError: LocalizedError, CustomStringConvertible {
        case notRendered(String)
        var description: String {
            switch self {
            case .notRendered(let words): words
            }
        }
        var errorDescription: String? { description }
    }
}

/// The review row under the segment bar (44 pt): what waits, Reject, and Accept as the one tinted button.
struct DeckReviewRow: View {
    let words: String
    var busy = false
    let decide: (_ accept: Bool) -> Void

    var body: some View {
        HStack(spacing: 12) {
            Text(words).textStep(.meta).foregroundStyle(.secondary).monospacedDigit()
            Spacer(minLength: 8)
            if busy {
                ProgressView()
            } else {
                // The kit's row action: a compact capsule whose tap target reaches 44 pt, Accept the one tinted.
                PillButton("Reject") { decide(false) }
                    .accessibilityIdentifier("review-reject")
                PillButton("Accept", tint: .accentColor) { decide(true) }
                    .accessibilityIdentifier("review-accept")
            }
        }
        .controlSize(.small)
        .padding(.horizontal, Layout.textEdge)
        .frame(minHeight: 44)
        .accessibilityIdentifier("review-row")
    }
}

/// PDFKit's viewer with the page capsule ("6 of 14") and an Ask button; a filmstrip under it for a deck.
struct PdfPages: View {
    let data: Data
    let filmstrip: Bool
    let onAsk: (String) -> Void
    @State private var page = 1
    @State private var pages = 1
    @State private var view = PDFView()

    var body: some View {
        VStack(spacing: 0) {
            PdfKitView(view: view, data: data, filmstrip: filmstrip) { page = $0; pages = $1 }
                .overlay(alignment: .bottom) {
                    Text("\(page) of \(pages)")
                        .textStep(.meta)
                        .monospacedDigit()
                        .padding(.horizontal, 12)
                        .frame(height: 28)
                        .glassEffect(.regular, in: Capsule())
                        .padding(.bottom, 12)
                        .accessibilityIdentifier("pdf-page")
                }
                .overlay(alignment: .topTrailing) {
                    Button("Ask", systemImage: "bubble.left") {
                        let picked = view.currentSelection?.string?.trimmingCharacters(in: .whitespacesAndNewlines)
                        onAsk(picked?.isEmpty == false ? picked! : "Page \(page)")
                    }
                    .labelStyle(.iconOnly)
                    .frame(width: 44, height: 44)
                    .glassEffect(.regular.interactive(), in: Circle())
                    .padding(12)
                    .accessibilityIdentifier("pdf-ask")
                }
            if filmstrip {
                Filmstrip(view: view)
                    .frame(height: 72)
            }
        }
    }
}

private struct PdfKitView: UIViewRepresentable {
    let view: PDFView
    let data: Data
    let filmstrip: Bool
    let onPage: (_ page: Int, _ pages: Int) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onPage: onPage) }

    func makeUIView(context: Context) -> PDFView {
        view.autoScales = true
        view.displayMode = filmstrip ? .singlePage : .singlePageContinuous
        view.displayDirection = filmstrip ? .horizontal : .vertical
        if filmstrip { view.usePageViewController(true) }
        view.backgroundColor = .secondarySystemBackground
        view.document = PDFDocument(data: data)
        context.coordinator.watch(view)
        return view
    }

    func updateUIView(_ view: PDFView, context: Context) {}

    final class Coordinator: NSObject {
        let onPage: (Int, Int) -> Void
        init(onPage: @escaping (Int, Int) -> Void) { self.onPage = onPage }

        func watch(_ view: PDFView) {
            NotificationCenter.default.addObserver(forName: .PDFViewPageChanged, object: view, queue: .main) { [weak self, weak view] _ in
                MainActor.assumeIsolated { if let view { self?.report(view) } }
            }
            // After this update: a state write from inside makeUIView is dropped, and the capsule kept "1 of 1".
            Task { @MainActor [weak self, weak view] in if let view { self?.report(view) } }
        }

        private func report(_ view: PDFView) {
            guard let document = view.document else { return }
            let index = view.currentPage.map { document.index(for: $0) } ?? 0
            onPage(index + 1, max(1, document.pageCount))
        }
    }
}

private struct Filmstrip: UIViewRepresentable {
    let view: PDFView

    func makeUIView(context: Context) -> PDFThumbnailView {
        let strip = PDFThumbnailView()
        strip.pdfView = view
        strip.layoutMode = .horizontal
        strip.thumbnailSize = CGSize(width: 80, height: 56)
        strip.backgroundColor = .systemBackground
        strip.accessibilityIdentifier = "slides-filmstrip"
        return strip
    }

    func updateUIView(_ strip: PDFThumbnailView, context: Context) {}
}
