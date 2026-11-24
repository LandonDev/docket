import SwiftUI
import TempCodeClient
import TempCodeContract

/// One open file on its own page (docs/IOS-DESIGN.md "A file on the phone"): the system's bar with the
/// file's name, Ask and More; the kind's own view edge to edge under it. A tap on a page, a slide or a
/// picture hides the bars and the kind's foot, and a tap brings them back. Any screen that opens a canvas
/// item full screen pushes this (`Route.file`): Files, Money's receipt, a template's preview.
struct FileReaderPage: View {
    let client: EnvironmentClient
    let item: CanvasItem
    /// The thread that holds the file, when one does: Ask sends to it, and Close takes the file out of it.
    let thread: String?
    /// The Work workspace the file was opened from, where no thread holds it: Ask finds the thread that
    /// shows the file, or starts one there.
    var workspaceId: String? = nil
    @Environment(\.dismiss) private var dismiss
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(ShellNavigator.self) private var navigator
    @State private var commands = ReaderCommands(ownsAsk: true)
    @State private var immersive = false
    /// The top inset while the bars show: with them hidden the page keeps that much room above it, so it stays where it was.
    @State private var restingTop: CGFloat = 0
    @State private var asking: ContextChip?
    @State private var sharing = false
    @State private var previewing = false
    @State private var failure: String?
    /// Print is reading its pages: a spinner stands in More's place.
    @State private var printing = false
    /// The file's comments and the changes that wait on it (`ReaderFrame` fills it).
    @State private var file: ReaderFile?
    @State private var sheet: ReaderSheet?
    /// The host's list has held the item open: once it no longer does, the page closes.
    @State private var listed = false

    /// The item as the host last pushed it (a file moved there is read, previewed and asked about at its new path),
    /// nil once the host's list no longer holds it: then More and Ask offer nothing.
    private var live: CanvasItem? { ReaderFile.live(item, in: client.work.canvas.items[item.sessionId]) }

    private var facts: ReaderFacts {
        ReaderFacts(
            canOperate: client.work.canOperate,
            canApprove: client.work.canApprove,
            inThread: thread != nil,
            waiting: file?.waiting ?? 0,
            previews: live.flatMap { client.work.canvas.preview(for: $0) } != nil,
            comments: file?.takesComments ?? false
        )
    }

    private var verbs: [ReaderVerb] { live.map { ReaderVerbs.of($0, facts) } ?? [] }

    /// Where Ask sends, for a key that may act: the thread beside the file, else the file's workspace, where
    /// Ask finds or starts the thread. A key that may only read has no Ask: the host would refuse its words.
    private var askTarget: AskTarget? {
        guard client.work.canOperate, let live else { return nil }
        if let thread { return .thread(thread) }
        if let workspaceId { return .file(workspaceId: workspaceId, item: live) }
        return nil
    }

    var body: some View {
        GeometryReader { proxy in
            ReaderFrame(client: client, item: item, commands: commands, file: $file, sheet: $sheet, immersive: immersive) {
                // The kind's view reads, and builds Ask's chips, from the item at its present path; a move gives it a new view.
                ItemBodyView(client: client, item: live ?? item, ask: askTarget == nil ? nil : { asking = $0 })
                    .id(ReaderFile.Identity(live ?? item))
                    // A paper kind keeps the reading measure in a wide column; the hosted editor takes the whole width.
                    .frame(maxWidth: sizeClass == .regular && ReaderVerbs.keepsMeasure(item) ? ReaderMetrics.measure : .infinity)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            // The bar's room stays above the page while the bar is hidden: the page does not move.
            .padding(.top, immersive ? max(0, restingTop - proxy.safeAreaInsets.top) : 0)
            .onChange(of: proxy.safeAreaInsets.top, initial: true) { _, top in if !immersive { restingTop = top } }
        }
            .background(Surface.chrome)
            // Its list read once as the page shows: pushes sent while the phone was away were lost, and a file the desktop
            // already had open was seated with no push, so a list held from before would read the item as gone.
            .task { await client.work.canvas.load(item.sessionId) }
            // Closed on another screen, or its tab gone: the page goes with it, and nothing of it stays mounted.
            .onChange(of: ReaderFile.presence(item, in: client.work.canvas.items[item.sessionId]), initial: true) { _, now in
                if now == .listed { listed = true } else if now == .gone, listed { dismiss() }
            }
            .environment(commands)
            // The bar leaves and returns on the fade the foot takes.
            .environment(\.readerTap, ReaderVerbs.immerses(item) ? { withAnimation(Motion.base) { immersive.toggle() } } : nil)
            .environment(\.readerImmersive, immersive)
            .navigationTitle(ReaderVerbs.title((live ?? item).title))
            .navigationBarTitleDisplayMode(.inline)
            .tcNavigationBar()
            .toolbar(.hidden, for: .tabBar)
            .toolbar(immersive ? .hidden : .automatic, for: .navigationBar)
            .toolbar {
                if askTarget != nil {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Ask", systemImage: "bubble.left") { ask() }
                            .accessibilityIdentifier("reader-ask")
                    }
                }
                if !verbs.isEmpty {
                    ToolbarItem(placement: .topBarTrailing) {
                        if printing {
                            ProgressView().accessibilityLabel("Reading the pages to print")
                        } else {
                            Menu {
                                ReaderMoreRows(verbs: verbs, run: run)
                            } label: {
                                Image(systemName: GlassMetrics.moreSymbol)
                            }
                            .accessibilityLabel("More")
                            .accessibilityIdentifier("item-more")
                        }
                    }
                }
            }
            .sheet(item: $asking) { chip in
                if let askTarget {
                    AskSheet(client: client, target: askTarget, chip: chip) { thread in openThread(thread) }
                }
            }
            .sheet(isPresented: $sharing) {
                if let source = ItemBody.of(item).guestSource {
                    GuestLinkSheet(client: client, source: source, title: item.title)
                }
            }
            .navigationDestination(isPresented: $previewing) {
                if let live, let source = client.work.canvas.preview(for: live) { PagePreview(client: client, item: live, source: source) }
            }
            .alert("Couldn’t do that", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
                Button("OK", role: .cancel) {}
            } message: { Text(failure ?? "") }
            .accessibilityIdentifier("reader-page")
            #if DEBUG
            // The reader's set: the tap that hides the bars, once the file has had time to show.
            .task {
                guard TestHooks.readerTap, ReaderVerbs.immerses(item) else { return }
                try? await Task.sleep(for: .seconds(8))
                immersive = true
            }
            // The Files proof (`TC_TEST_ACTION=files-ask:<words>`): Ask on a file with no thread, sent as the sheet sends
            // it; `files-ask` alone opens the sheet.
            .task {
                guard let action = TestHooks.action, action.hasPrefix("files-ask"), let workspaceId, TestHooks.once("files-ask") else { return }
                try? await Task.sleep(for: .seconds(4))
                let words = action.dropFirst("files-ask".count).drop { $0 == ":" }
                guard !words.isEmpty else { return ask() }
                if let thread = try? await client.work.ask(workspaceId: workspaceId, item: item, chip: ChipWords.item(item), text: String(words), session: { client.session($0) }) {
                    openThread(thread)
                }
            }
            // `TC_TEST_SHEET`: `reader-preview` pushes Page Preview; `reader-comments`, `reader-review` and
            // `reader-comment` open that sheet once the host has answered for the file.
            .task {
                guard let want = TestHooks.sheet, want.hasPrefix("reader-") else { return }
                // Ten seconds at most for the host's answer about the file's comments and changes, where it has any.
                var tries = 0
                while tries < 100, file == nil || (file?.review.map { !$0.loaded } ?? false) || (file?.comments.map { !$0.loaded } ?? false) {
                    try? await Task.sleep(for: .milliseconds(100))
                    tries += 1
                }
                try? await Task.sleep(for: .seconds(1))
                switch want {
                case "reader-preview": previewing = true
                case "reader-comments": sheet = .comments
                case "reader-review": sheet = .review
                case "reader-comment": sheet = .comment(quote: "The bus leaves the CoRec lot at 7:30 on Friday.")
                default: break
                }
            }
            #endif
    }

    /// What the kind has picked (a selection, else its page), else the file itself.
    private func ask() {
        if let picked = commands.ask { picked() } else if let live { asking = ChipWords.item(live) }
    }

    /// His words went to a thread: he is taken to it. It opens on its first segment, the file (Chat is one
    /// swipe away); landing on Chat is an open finding in the landing note.
    private func openThread(_ thread: String) {
        navigator.open(.thread(environmentId: client.environment.id, sessionId: thread, seq: nil))
    }

    private func run(_ verb: ReaderVerb) {
        switch verb {
        case .find: commands.showFind()
        case .print:
            Task {
                printing = true
                defer { printing = false }
                do { try await ReaderPrint.run(client: client, item: live ?? item) } catch { failure = ActionError.wrap(error).message }
            }
        case .guestLink: sharing = true
        case .close:
            Task {
                do {
                    try await client.work.canvas.close(item)
                    dismiss()
                } catch {
                    failure = ActionError.wrap(error).message
                }
            }
        case .preview: previewing = true
        case .comments: sheet = .comments
        case .review: sheet = .review
        case .share: break
        }
    }
}
