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
            return try await client.work.canvas.pdfData(view)
        }) { data, _ in
            PdfPages(data: data, filmstrip: false, onAsk: { quote in ask(ChipWords.selection(in: item, quote: quote)) })
        }
        .accessibilityIdentifier("pdf-item")
    }
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
    }

    var body: some View {
        ItemLoad(read: { try await load() }) { loaded, reload in
            VStack(spacing: 0) {
                if !loaded.deck.changes.isEmpty, client.work.canApprove {
                    ReviewRow(words: loaded.deck.changes.count == 1 ? "1 change" : "\(loaded.deck.changes.count) changes", busy: deciding) { accept in
                        Task { await decide(accept, reload: reload) }
                    }
                    Divider()
                }
                PdfPages(data: loaded.data, filmstrip: true, onAsk: { quote in ask(ChipWords.selection(in: item, quote: quote)) })
            }
        }
        .alert("Couldn’t do that", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(error ?? "") }
        .accessibilityIdentifier("slides-item")
    }

    private func load() async throws -> Loaded {
        let deck = try await client.work.canvas.deck(item.id)
        let proposed = deck.renders.proposed != nil && !deck.changes.isEmpty
        guard let render = proposed ? deck.renders.proposed : deck.renders.file else {
            throw DeckError.notRendered(deck.renderError ?? "The deck has not been drawn yet.")
        }
        return Loaded(deck: deck, data: try await client.work.canvas.deckData(item.id, proposed: proposed, size: Int(render.size)))
    }

    private func decide(_ accept: Bool, reload: () -> Void) async {
        deciding = true
        defer { deciding = false }
        do {
            _ = try await client.work.canvas.reviewDeck(item.id, accept: accept)
            reload()
        } catch {
            self.error = ActionError.wrap(error).message
        }
    }

    private enum DeckError: LocalizedError {
        case notRendered(String)
        var errorDescription: String? {
            switch self {
            case .notRendered(let words): words
            }
        }
    }
}

/// The review row under the segment bar (44 pt): what waits, Reject, and Accept as the one tinted button.
struct ReviewRow: View {
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
                Button("Reject") { decide(false) }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("review-reject")
                Button("Accept") { decide(true) }
                    .buttonStyle(.borderedProminent)
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
            report(view)
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
