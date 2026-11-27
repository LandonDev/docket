import PDFKit
import SwiftUI
import TempCodeClient
import TempCodeContract

/// A PDF item (milestone 47): the file in the system's viewer, read from the
/// host in frames, with the page stamp over its foot and Ask in the row
/// above (the selection, else the page). It opens on the page he stopped on,
/// and a second open in the same run paints from memory (the reader, PF1).
struct PdfItemView: View {
    let client: EnvironmentClient
    let item: CanvasItem
    let ask: ((ContextChip) -> Void)?
    @State private var progress = ReadProgress()
    @Environment(\.displayScale) private var scale

    private struct Loaded {
        var rev: String
        var data: Data
        /// The host's view of the file, with his highlights and the form's fields; nil while painted from memory.
        var view: PdfPhoneView?
    }

    private var host: String { client.environment.id }
    private var file: String { ReaderPlaces.fileKey(item) }
    private var cacheKey: String { ReaderCache.key(host: host, file: file) }

    var body: some View {
        ItemLoad(
            initial: ReaderCache.shared.latest(cacheKey).map { Loaded(rev: $0.rev, data: $0.data) },
            loading: { AnyView(ReaderLoading(progress: progress.share, picture: progress.picture)) },
            host: client.environment.name,
            read: { try await load() }
        ) { loaded, _ in
            PdfLayered(client: client, item: item, data: loaded.data, rev: loaded.rev, view: loaded.view, ask: ask)
                // The same bytes read again keep their viewer; a file that changed gets a new one. A view the host
                // answered after a paint from memory brings its layer in place.
                .id(loaded.rev)
        }
        .accessibilityIdentifier("pdf-item")
    }

    private func load() async throws -> Loaded {
        let view = try await client.work.canvas.pdf(item.id)
        // A picture from a read before (another version, Try Again) never stands for this one.
        progress.picture = nil
        if let data = ReaderCache.shared.data(cacheKey, rev: view.rev) { return Loaded(rev: view.rev, data: data, view: view) }
        let canvas = client.work.canvas, key = cacheKey, progress = self.progress
        let width = FirstPicture.width(points: ReaderMetrics.measure, scale: scale)
        // One read of this version however many views open it; its first page drawn while the rest reads (M17).
        let data = try await ReaderOpens.shared.open(key, rev: view.rev, show: { progress.show($0) }, first: { await canvas.pdfFirst(view, width: width) }) {
            let data = try await canvas.pdfData(view) { progress.share = $0 }
            // Only bytes PDFKit opens with a page reach the viewer; anything else is the item's failure with Try Again,
            // never a blank viewer saying "1 of 1" (as the deck does, `DeckRender.opens`).
            guard DeckRender.opens(pageCount: PDFDocument(data: data)?.pageCount) else { throw PdfUnreadable() }
            ReaderCache.shared.keep(data, for: key, rev: view.rev)
            return data
        }
        return Loaded(rev: view.rev, data: data, view: view)
    }
}

/// A PDF's pages with what the host draws over them: his highlights and their notes, a form's values, and while an
/// agent's values wait, the row that counts them with Reject All and Accept All (the values are on the page, so he
/// decides where he reads them). A tap on a highlight or a field opens its sheet.
private struct PdfLayered: View {
    let client: EnvironmentClient
    let item: CanvasItem
    let data: Data
    let rev: String
    let view: PdfPhoneView?
    let ask: ((ContextChip) -> Void)?
    @State private var layer: PdfLayerModel?
    @State private var picked: PdfLayerPick?
    @State private var error: String?
    @Environment(\.readerImmersive) private var immersive

    private var host: String { client.environment.id }
    private var file: String { ReaderPlaces.fileKey(item) }

    var body: some View {
        VStack(spacing: 0) {
            if let layer, !layer.waiting.isEmpty, !immersive {
                DeckReviewRow(words: PdfFields.waitingWords(layer.waiting.count), busy: layer.busy, decides: layer.acts && client.work.may(.pdfReview)) { accept in
                    Task { await reviewAll(layer, accept: accept) }
                }
                Divider()
            }
            PdfPages(
                data: data,
                filmstrip: false,
                layer: layer,
                start: { ReaderPlaces.shared.page(host: host, file: file, pages: $0) },
                onAsk: ask.map { ask in { (quote: String) in ask(ChipWords.selection(in: item, quote: quote)) } },
                onPage: { ReaderPlaces.shared.keep(ReaderPlace(page: $0, rev: rev), host: host, file: file) },
                onPick: { picked = $0 }
            )
        }
        .onChange(of: view, initial: true) { _, now in
            // The host's view, once it has answered for these bytes: a paint from memory has no layer until then.
            guard let now, now.rev == rev, layer == nil else { return }
            layer = PdfLayerModel(view: now, canvas: client.work.canvas, acts: client.work.may(.pdfMark))
        }
        .sheet(item: $picked) { pick in
            if let layer {
                switch pick {
                case .mark(let id):
                    if let mark = layer.marks.first(where: { $0.id == id }) { PdfMarkSheet(layer: layer, mark: mark) }
                case .field(let key):
                    if let field = PdfFields.field(named: key, in: layer.fields) { PdfFieldSheet(layer: layer, field: field) }
                }
            }
        }
        .alert("Couldn’t Do That", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(error ?? "") }
        .sensoryFeedback(.impact(weight: .light), trigger: layer?.revision ?? 0)
    }

    /// The values on screen when he pressed, by key: one an agent added since is not decided unseen.
    private func reviewAll(_ layer: PdfLayerModel, accept: Bool) async {
        do {
            try await layer.review(layer.waiting.map(\.key), accept: accept)
        } catch {
            self.error = ActionError.wrap(error).message
        }
    }
}

/// A PDF's bytes that PDFKit cannot open as a document with a page. Its `description` is the sentence, since
/// `ActionError.wrap` words an error it does not know by `String(describing:)`.
private struct PdfUnreadable: LocalizedError, CustomStringConvertible {
    var description: String { "The PDF did not open." }
    var errorDescription: String? { description }
}

/// A deck (milestone 47): its render, a PDF, one slide to a page, with the slide's notes and the filmstrip
/// under it. While the agent's changes wait the proposed render shows, with the review row: how many,
/// Reject All and Accept All.
struct SlidesItemView: View {
    let client: EnvironmentClient
    let item: CanvasItem
    let ask: ((ContextChip) -> Void)?
    @State private var deciding = false
    @State private var error: String?
    @State private var progress = ReadProgress()
    @Environment(\.readerImmersive) private var immersive

    private struct Loaded {
        var deck: DeckPhoneView
        var data: Data
        var render: DeckRender
        /// The render's rev as the view advertised it: the bytes read are that render's, and a decision is bound to it.
        var rev: String
        /// How many pages PDFKit opened.
        var pages: Int
        /// The host answered for this render just now. A render painted from memory is not live: it shows the
        /// slides and never the verdicts, which wait for the deck as the host has it.
        var live = true
        /// Which render this is: a new one (after Accept or Reject, or the file's next version) gets a new viewer.
        var key: String { "\(rev):\(render == .proposed ? "proposed" : "file")" }
    }

    /// A render read whole, with the pages PDFKit opened.
    private struct DeckRead: Sendable {
        var data: Data
        var pages: Int
    }

    /// What the cache keeps beside a render's bytes: the slides it draws, which render it is and its page count.
    private struct Kept: Sendable {
        var deck: DeckPhoneView
        var render: DeckRender
        var pages: Int
    }

    private var host: String { client.environment.id }
    private var file: String { ReaderPlaces.fileKey(item) }
    private var cacheKey: String { ReaderCache.key(host: host, file: file) }

    private var remembered: Loaded? {
        guard let kept = ReaderCache.shared.latest(cacheKey), let about = kept.note as? Kept, DeckRender.paintsFromMemory(about.render) else { return nil }
        return Loaded(deck: about.deck, data: kept.data, render: about.render, rev: kept.rev, pages: about.pages, live: false)
    }

    var body: some View {
        // After a decision the deck reads afresh with its review off: the old preview, its count and its buttons never
        // stay live through the refresh, and a refresh that fails says so with Try Again.
        ItemLoad(
            dropsOnReload: true,
            initial: remembered,
            loading: { AnyView(ReaderLoading(aspect: ReaderMetrics.slideAspect, progress: progress.share, picture: progress.picture)) },
            host: client.environment.name,
            read: { try await load() }
        ) { loaded, reload in
            VStack(spacing: 0) {
                // The review row only over the render its changes propose (`DeckRender`), once the host has answered.
                if loaded.live, loaded.render == .proposed, client.work.may(.slidesReview), !immersive {
                    DeckReviewRow(words: loaded.deck.changes.count == 1 ? "1 change" : "\(loaded.deck.changes.count) changes", busy: deciding) { accept in
                        Task { await decide(accept, rev: loaded.rev, reload: reload) }
                    }
                    Divider()
                }
                pages(loaded)
                    .id(loaded.key)
            }
        }
        .alert("Couldn’t Do That", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(error ?? "") }
        .accessibilityIdentifier("slides-item")
    }

    private func pages(_ loaded: Loaded) -> some View {
        let pager = DeckPager(loaded.deck, render: loaded.render, count: loaded.pages)
        return PdfPages(
            data: loaded.data,
            filmstrip: true,
            pager: pager,
            start: { ReaderPlaces.shared.page(host: host, file: file, pages: $0) { pager.page(for: $0) } },
            onAsk: ask.map { ask in { (quote: String) in ask(ChipWords.selection(in: item, quote: quote)) } },
            onPage: { ReaderPlaces.shared.keep(ReaderPlace(page: $0, slide: pager.slide(at: $0)?.key, rev: loaded.rev), host: host, file: file) }
        )
    }

    private func load() async throws -> Loaded {
        let deck = try await client.work.canvas.deck(item.id)
        // A picture from a read before (the render before a decision, Try Again) never stands for this one.
        progress.picture = nil
        let waiting = !deck.changes.isEmpty
        // While changes wait only their proposed render shows; a missing one is the Try Again state, never the
        // file's render under live Reject and Accept. The two renders are distinct generated types; only the size is read.
        guard let render = DeckRender.pick(changesWaiting: waiting, hasProposed: deck.renders.proposed != nil, hasFile: deck.renders.file != nil),
              let size = render == .proposed ? deck.renders.proposed?.size : deck.renders.file?.size,
              let rev = render == .proposed ? deck.renders.proposed?.rev : deck.renders.file?.rev else {
            throw DeckError.notRendered(deck.renderError ?? DeckRender.missingWords(changesWaiting: waiting))
        }
        if let data = ReaderCache.shared.data(cacheKey, rev: rev), let pages = (ReaderCache.shared.latest(cacheKey)?.note as? Kept)?.pages {
            // The same render as last time, with the deck as the host has it now.
            ReaderCache.shared.keep(data, for: cacheKey, rev: rev, note: Kept(deck: deck, render: render, pages: pages))
            return Loaded(deck: deck, data: data, render: render, rev: rev, pages: pages)
        }
        let canvas = client.work.canvas, key = cacheKey, progress = self.progress, itemId = item.id, proposed = render == .proposed
        // One read of this render however many views open it; its first slide drawn while the rest reads (M17).
        let read = try await ReaderOpens.shared.open(key, rev: rev, show: { progress.show($0) }, first: { await canvas.slideFirst(deck, proposed: proposed, rev: rev) }) {
            // The bytes must be the render the view named: a read that meets another (the changes moved on) fails, for Try Again.
            let data = try await canvas.deckData(itemId, proposed: proposed, size: Int(size), rev: rev) { progress.share = $0 }
            // The verdicts come only once PDFKit opens the bytes as a document with a page; a decode failure is Try Again.
            let pages = PDFDocument(data: data)?.pageCount
            guard DeckRender.opens(pageCount: pages), let pages else { throw DeckError.notRendered(DeckRender.unreadable) }
            ReaderCache.shared.keep(data, for: key, rev: rev, note: Kept(deck: deck, render: render, pages: pages))
            return DeckRead(data: data, pages: pages)
        }
        return Loaded(deck: deck, data: read.data, render: render, rev: rev, pages: read.pages)
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
    /// A key that may not act reads the count and has no buttons.
    var decides = true
    /// A tap on the count opens the changes one by one (a document, a sheet); a deck's row has none.
    var open: (() -> Void)?
    let decide: (_ accept: Bool) -> Void

    var body: some View {
        HStack(spacing: 12) {
            if let open {
                Button(action: open) {
                    HStack(spacing: 4) {
                        // A press, so the label's ink: the meta step's grey read as a caption and was missed.
                        Text(words).textStep(.meta, weight: .medium, tint: .primary).monospacedDigit()
                        Image(systemName: "chevron.right").imageScale(.small).foregroundStyle(.tertiary)
                    }
                    .frame(minHeight: Layout.rowHeight)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.pressable)
                .accessibilityIdentifier("review-open")
            } else {
                Text(words).textStep(.meta).foregroundStyle(.secondary).monospacedDigit()
            }
            Spacer(minLength: 8)
            if busy {
                ProgressView()
            } else if decides {
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

/// PDFKit's viewer with the page stamp ("6 of 14") and an Ask button; for a deck, one slide to a page with
/// the slide's notes and a filmstrip under it. Inside the reader page a tap on the page hides the bars and
/// this view's foot with them, and Ask is the page's own bar item.
struct PdfPages: View {
    let data: Data
    let filmstrip: Bool
    /// A deck's pages: the notes under the slide come from it.
    var pager: DeckPager?
    /// A PDF's highlights and fields, once the host has answered: drawn over the pages, and Highlight in the
    /// selection's menu for a key that may act.
    var layer: PdfLayerModel?
    /// The page to open on, from 1, once the document says how many it has.
    var start: (_ pages: Int) -> Int? = { _ in nil }
    /// nil: no thread beside the file, so no Ask.
    let onAsk: ((String) -> Void)?
    /// Each page he lands on, from 1.
    var onPage: (_ page: Int) -> Void = { _ in }
    /// A tap on one of his highlights or a field.
    var onPick: (PdfLayerPick) -> Void = { _ in }
    @State private var page = 1
    @State private var pages = 1
    @State private var aspect = ReaderMetrics.slideAspect
    @State private var view = ReaderPDFView()
    /// A highlight the host refused, in its words.
    @State private var failure: String?
    @Environment(ReaderCommands.self) private var commands: ReaderCommands?
    @Environment(\.readerTap) private var tap
    @Environment(\.readerImmersive) private var immersive

    var body: some View {
        // A deck with notes: on the open Duo the slide and its strip stand on the leading page and the notes on the
        // trailing; on a table the slide stands above the band and the notes lie below (`ReaderSpread`).
        ReaderSpread(enabled: pager?.hasNotes == true) {
            VStack(spacing: 0) {
                viewer
                if filmstrip { strip }
            }
        } with: {
            if let pager { SlideNotes(words: pager.notes(at: page)).id(page).footHidden(immersive) }
        } single: { _, _ in
            column
        }
        .animation(Motion.base, value: immersive)
        .onAppear {
            if onAsk != nil { commands?.ask = { askNow() } }
            view.selectionActions = { [weak view] in
                guard let view, layer?.acts == true, view.currentSelection?.string?.isEmpty == false else { return [] }
                return [UIAction(title: "Highlight", image: UIImage(systemName: "highlighter")) { _ in highlightNow() }]
            }
        }
        .onDisappear {
            commands?.ask = nil
            view.selectionActions = nil
        }
        #if DEBUG
        // The reader's set: the page a swipe would reach, through the viewer's own go-to.
        .task {
            guard let want = TestHooks.readerPage else { return }
            try? await Task.sleep(for: .seconds(2))
            if let page = view.document?.page(at: want - 1) { view.go(to: page) }
        }
        #endif
        .onChange(of: commands?.find) {
            let find: UIFindInteraction? = view.findInteraction
            find?.presentFindNavigator(showingReplace: false)
        }
        .alert("Couldn’t Highlight", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(failure ?? "") }
    }

    /// One column: the slide at the width in its own shape, its notes under it, then the strip.
    private var column: some View {
        GeometryReader { proxy in
            let layout = DeckPager.layout(width: proxy.size.width, height: proxy.size.height, aspect: aspect, filmstrip: filmstrip ? ReaderMetrics.filmstrip : 0, hasNotes: pager?.hasNotes == true)
            VStack(spacing: 0) {
                viewer
                    .frame(height: layout.slide.map { CGFloat($0) })
                if layout.notes, let pager {
                    // In a wide column the slide is narrower than the column: the notes start at its left edge.
                    SlideNotes(words: pager.notes(at: page), width: layout.slide.map { min(proxy.size.width, CGFloat($0) * aspect) })
                        .id(page)
                        .footHidden(immersive)
                }
                if filmstrip { strip }
            }
        }
    }

    private var strip: some View {
        DeckFilmstrip(view: view, page: page, pages: pages, aspect: aspect, hidden: Set((pager?.pages ?? []).filter(\.hidden).map(\.page)))
            .frame(height: ReaderMetrics.filmstrip)
            .footHidden(immersive)
    }

    private var viewer: some View {
        PdfKitView(view: view, data: data, filmstrip: filmstrip, start: start, onTap: tap, layer: layer?.view, revision: layer?.revision ?? -1, onPick: layer == nil ? nil : onPick) { page, pages, aspect in
            if page != self.page { onPage(page) }
            self.page = page
            self.pages = pages
            self.aspect = aspect
        }
        .overlay(alignment: .bottom) {
            // One page needs no count.
            if pages > 1 {
                PageStamp(words: "\(page) of \(pages)")
                    .footHidden(immersive)
            }
        }
        .overlay(alignment: .topTrailing) {
            // The reader page has Ask in its bar; in a thread's Item segment the viewer carries it.
            if onAsk != nil, commands?.ownsAsk != true {
                Button("Ask", systemImage: "bubble.left") { askNow() }
                    .labelStyle(.iconOnly)
                    .frame(width: Layout.hitTarget, height: Layout.hitTarget)
                    .tcGlass(in: Circle(), interactive: true)
                    .padding(12)
                    .accessibilityIdentifier("pdf-ask")
            }
        }
    }

    /// His highlight over the words he picked: one mark a page the selection crosses, a box per line. The view the host
    /// answers draws it, and the selection goes.
    private func highlightNow() {
        guard let layer, let selection = view.currentSelection, let document = view.document else { return }
        let lines = selection.selectionsByLine()
        let marks: [(page: Int, quads: [[Double]], text: String)] = selection.pages.compactMap { page in
            let onPage = lines.filter { $0.pages.contains(page) }
            let quads = PdfBox.quads(lines: onPage.map { $0.bounds(for: page) }, page: page.bounds(for: .cropBox))
            let text = onPage.compactMap(\.string).joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !quads.isEmpty, !text.isEmpty else { return nil }
            return (document.index(for: page) + 1, quads, text)
        }
        guard !marks.isEmpty else { return }
        view.clearSelection()
        Task {
            do {
                for mark in marks { try await layer.mark(page: mark.page, quads: mark.quads, text: mark.text) }
            } catch {
                failure = ActionError.wrap(error).message
            }
        }
    }

    /// What he picked on the page, else the page.
    private func askNow() {
        let picked = view.currentSelection?.string?.trimmingCharacters(in: .whitespacesAndNewlines)
        onAsk?(picked?.isEmpty == false ? picked! : (filmstrip ? "Slide \(page)" : "Page \(page)"))
    }
}

private extension View {
    /// The foot while the bars are hidden: it keeps its room and fades, and takes no touch and no VoiceOver.
    func footHidden(_ hidden: Bool) -> some View {
        opacity(hidden ? 0 : 1).allowsHitTesting(!hidden).accessibilityHidden(hidden)
    }
}

/// A slide's speaker notes under it: the reading measure from the slide's left edge, scrolling on their own.
private struct SlideNotes: View {
    let words: String
    /// The slide's drawn width; nil is the whole column.
    var width: CGFloat?

    var body: some View {
        VStack(spacing: 0) {
            Hairline()
            ScrollView {
                Text(words.isEmpty ? "No notes" : words)
                    // The step's own colour wins over an outer foregroundStyle, so the notes' primary is its tint.
                    .textStep(.meta, tint: words.isEmpty ? nil : .primary)
                    .frame(maxWidth: ReaderMetrics.measure, alignment: .leading)
                    .padding(.horizontal, Layout.textEdge)
                    .padding(.vertical, 12)
                    .frame(maxWidth: width ?? .infinity, alignment: .leading)
                    .frame(maxWidth: .infinity)
                    .textSelection(.enabled)
            }
        }
        .background(Surface.background)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(words.isEmpty ? "No notes" : "Notes: \(words)")
        .accessibilityIdentifier("slide-notes")
    }
}

/// PDFKit's view with the reader's own rows at the head of the selection's menu (Highlight).
final class ReaderPDFView: PDFView {
    /// Asked each time the menu is built; empty adds nothing.
    var selectionActions: (() -> [UIMenuElement])?

    override func buildMenu(with builder: any UIMenuBuilder) {
        super.buildMenu(with: builder)
        guard let actions = selectionActions?(), !actions.isEmpty else { return }
        builder.insertSibling(UIMenu(options: .displayInline, children: actions), beforeMenu: .standardEdit)
    }
}

private struct PdfKitView: UIViewRepresentable {
    let view: PDFView
    let data: Data
    let filmstrip: Bool
    let start: (_ pages: Int) -> Int?
    let onTap: (() -> Void)?
    /// What the host draws over the pages; nil draws nothing of ours.
    var layer: PdfPhoneView?
    /// The layer's revision: a new one is drawn again.
    var revision = -1
    /// A tap on a highlight or a field; nil while there is no layer.
    var onPick: ((PdfLayerPick) -> Void)?
    let onPage: (_ page: Int, _ pages: Int, _ aspect: CGFloat) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onPage: onPage) }

    func makeUIView(context: Context) -> PDFView {
        view.autoScales = true
        view.displayMode = filmstrip ? .singlePage : .singlePageContinuous
        view.displayDirection = filmstrip ? .horizontal : .vertical
        if filmstrip { view.usePageViewController(true) }
        view.backgroundColor = .secondarySystemBackground
        view.isFindInteractionEnabled = true
        let document = PDFDocument(data: data)
        view.document = document
        context.coordinator.onTap = onTap
        context.coordinator.watch(view, start: document.flatMap { start($0.pageCount) })
        draw(view, context.coordinator)
        return view
    }

    func updateUIView(_ view: PDFView, context: Context) {
        context.coordinator.onTap = onTap
        draw(view, context.coordinator)
    }

    /// The layer drawn once per revision, never on every update.
    private func draw(_ view: PDFView, _ coordinator: Coordinator) {
        coordinator.onPick = onPick
        guard let layer, coordinator.drawn != revision else { return }
        coordinator.drawn = revision
        coordinator.fields = Set((layer.fields ?? []).map(\.key))
        PdfLayerDraw.apply(layer, to: view)
    }

    static func dismantleUIView(_ view: PDFView, coordinator: Coordinator) {
        coordinator.stopWatching()
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        let onPage: (Int, Int, CGFloat) -> Void
        var onTap: (() -> Void)?
        var onPick: ((PdfLayerPick) -> Void)?
        /// The layer's revision last drawn.
        var drawn = Int.min
        /// The form's field keys, to know a widget of the file that is one.
        var fields: Set<String> = []
        /// The page-change observer, removed when the viewer goes.
        private var watching: (any NSObjectProtocol)?
        init(onPage: @escaping (Int, Int, CGFloat) -> Void) { self.onPage = onPage }

        func stopWatching() {
            if let watching { NotificationCenter.default.removeObserver(watching) }
            watching = nil
        }

        func watch(_ view: PDFView, start: Int?) {
            watching = NotificationCenter.default.addObserver(forName: .PDFViewPageChanged, object: view, queue: .main) { [weak self, weak view] _ in
                MainActor.assumeIsolated { if let view { self?.report(view) } }
            }
            let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
            tap.delegate = self
            tap.cancelsTouchesInView = false
            view.addGestureRecognizer(tap)
            // After this update: a state write from inside makeUIView is dropped, and the capsule kept "1 of 1".
            // The place he stopped is restored here too, once the viewer has laid its pages out: a go-to while it
            // has no size is undone by its first layout, which then reports page 1 and keeps that as the place.
            Task { @MainActor [weak self, weak view] in
                for _ in 0..<120 {
                    guard let view, view.bounds.isEmpty else { break }
                    try? await Task.sleep(for: .milliseconds(16))
                }
                guard let view else { return }
                view.layoutIfNeeded()
                // Fit to the width it now has: a fit taken before it had a size left the page past its right edge.
                view.autoScales = true
                if let start, let page = view.document?.page(at: start - 1) { view.go(to: page) }
                self?.report(view)
            }
        }

        private func report(_ view: PDFView) {
            guard let document = view.document else { return }
            let index = view.currentPage.map { document.index(for: $0) } ?? 0
            let box = (view.currentPage ?? document.page(at: 0))?.bounds(for: .mediaBox) ?? .zero
            onPage(index + 1, max(1, document.pageCount), box.height > 0 ? box.width / box.height : ReaderMetrics.slideAspect)
        }

        /// A tap on one of his highlights or a field opens it; any other tap on the page, not on a link and not one
        /// that drops a selection, is the reader's.
        @objc private func tapped(_ tap: UITapGestureRecognizer) {
            guard let view = tap.view as? PDFView else { return }
            if let onPick, let pick = pick(at: tap.location(in: view), in: view) {
                onPick(pick)
                return
            }
            guard let onTap, view.currentSelection == nil else { return }
            if view.areaOfInterest(for: tap.location(in: view)).contains(.linkArea) { return }
            onTap()
        }

        /// The topmost highlight or field under a point, if any.
        private func pick(at point: CGPoint, in view: PDFView) -> PdfLayerPick? {
            guard let page = view.page(for: point, nearest: false) else { return nil }
            let at = view.convert(point, to: page)
            return page.annotations.reversed().lazy
                .filter { $0.bounds.contains(at) }
                .compactMap { PdfLayerName.pick(name: $0.userName, widget: $0.type == "Widget" ? $0.fieldName : nil, fields: self.fields) }
                .first
        }

        /// The viewer's own taps keep working beside this one.
        func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

        /// A double tap zooms; the bars wait until it is plain there is no second tap.
        func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldRequireFailureOf other: UIGestureRecognizer) -> Bool {
            (other as? UITapGestureRecognizer)?.numberOfTapsRequired == 2
        }
    }
}

/// A deck's slides in a row under it: every slide whole at one size, the one that shows ringed and kept in
/// view. A tap goes to a slide; a slide hidden in a show is dimmed and says so.
private struct DeckFilmstrip: View {
    let view: PDFView
    let page: Int
    let pages: Int
    /// A slide's shape: every thumbnail is the strip's height and as wide as that makes it.
    let aspect: CGFloat
    /// The pages of slides hidden in a show.
    let hidden: Set<Int>
    @State private var pictures: [Int: UIImage] = [:]
    @Environment(\.displayScale) private var scale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        GeometryReader { geometry in
            ScrollViewReader { proxy in
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(spacing: 8) {
                        ForEach(1...max(1, pages), id: \.self) { number in
                            Button { go(number) } label: { thumbnail(number) }
                                .buttonStyle(.pressable)
                                .id(number)
                                .accessibilityLabel(hidden.contains(number) ? "Slide \(number), hidden" : "Slide \(number)")
                                .accessibilityAddTraits(number == page ? .isSelected : [])
                        }
                    }
                    .padding(.horizontal, Layout.textEdge)
                    // A short deck in a wide column sits under the slide, not at the leading edge.
                    .frame(minWidth: geometry.size.width, minHeight: geometry.size.height)
                }
                .onChange(of: page, initial: true) { old, now in
                    // The strip opens at its start for the first slide: centring it there scrolled a lazy row past
                    // its own leading edge and cut the first thumbnail.
                    if old == now, now <= 1 { return }
                    // The slide that shows stays in view; the strip glides to it unless motion is reduced. On the first
                    // paint it is placed, not glided.
                    withAnimation(reduceMotion || old == now ? nil : Motion.base) { proxy.scrollTo(now, anchor: .center) }
                }
            }
        }
        .background(Surface.background)
        .accessibilityIdentifier("slides-filmstrip")
    }

    private var size: CGSize {
        CGSize(width: (ReaderMetrics.thumbnail * aspect).rounded(), height: ReaderMetrics.thumbnail)
    }

    private func thumbnail(_ number: Int) -> some View {
        Group {
            if let picture = pictures[number] {
                Image(uiImage: picture).resizable().scaledToFit()
            } else {
                Color.white
            }
        }
        .frame(width: size.width, height: size.height)
        .background(Color.white)
        .overlay(alignment: .bottomTrailing) {
            // Hidden in a show: the slide stays whole, with the mark that says so at its foot, clear of its title
            // (a dimmed slide read as a grey tile in dark).
            if hidden.contains(number) {
                Image(systemName: "eye.slash.fill")
                    .font(.caption2)
                    // The thumbnail is a fixed 48 pt: at the largest text sizes the mark would cover the slide.
                    .dynamicTypeSize(...DynamicTypeSize.large)
                    .foregroundStyle(.white)
                    .padding(3)
                    .background(Color.black.opacity(contrast == .increased ? 1 : 0.55), in: Circle())
                    .padding(3)
                    .accessibilityHidden(true)
            }
        }
        .clipShape(RoundedRectangle.inlineCorner)
        .hairlineBorder(RoundedRectangle.inlineCorner)
        .overlay {
            // The slide that shows: a ring in the accent, the same shape as the thumbnail.
            if number == page { RoundedRectangle.inlineCorner.strokeBorder(Color.accentColor, lineWidth: 2) }
        }
        .task(id: number) { draw(number) }
    }

    /// Each thumbnail is drawn once, at the strip's own size.
    private func draw(_ number: Int) {
        guard pictures[number] == nil, let page = view.document?.page(at: number - 1) else { return }
        pictures[number] = page.thumbnail(of: CGSize(width: size.width * scale, height: size.height * scale), for: .mediaBox)
    }

    private func go(_ number: Int) {
        if let page = view.document?.page(at: number - 1) { view.go(to: page) }
    }
}
