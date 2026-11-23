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
    /// The file's comments and the changes that wait on it (`ReaderFrame` fills it).
    @State private var file: ReaderFile?
    @State private var sheet: ReaderSheet?

    private var facts: ReaderFacts {
        ReaderFacts(
            canApprove: client.work.canApprove,
            inThread: thread != nil,
            waiting: file?.waiting ?? 0,
            previews: client.work.canvas.preview(for: item) != nil,
            comments: file?.takesComments ?? false
        )
    }

    private var verbs: [ReaderVerb] { ReaderVerbs.of(item, facts) }

    /// Where Ask sends: the thread beside the file, else the file's workspace for a key that may start a thread.
    private var askTarget: AskTarget? {
        if let thread { return .thread(thread) }
        if let workspaceId, client.work.canOperate { return .file(workspaceId: workspaceId, item: item) }
        return nil
    }

    var body: some View {
        GeometryReader { proxy in
            ReaderFrame(client: client, item: item, commands: commands, file: $file, sheet: $sheet, immersive: immersive) {
                ItemBodyView(client: client, item: item, ask: askTarget == nil ? nil : { asking = $0 })
                    // A paper kind keeps the reading measure in a wide column; the hosted editor takes the whole width.
                    .frame(maxWidth: sizeClass == .regular && ReaderVerbs.keepsMeasure(item) ? ReaderMetrics.measure : .infinity)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            // The bar's room stays above the page while the bar is hidden: the page does not move.
            .padding(.top, immersive ? max(0, restingTop - proxy.safeAreaInsets.top) : 0)
            .onChange(of: proxy.safeAreaInsets.top, initial: true) { _, top in if !immersive { restingTop = top } }
        }
            .background(Surface.chrome)
            .environment(commands)
            .environment(\.readerTap, ReaderVerbs.immerses(item) ? { immersive.toggle() } : nil)
            .environment(\.readerImmersive, immersive)
            .navigationTitle(ReaderVerbs.title(item.title))
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
            .sheet(item: $asking) { chip in
                if let askTarget {
                    AskSheet(client: client, target: askTarget, chip: chip) { thread in
                        navigator.open(.thread(environmentId: client.environment.id, sessionId: thread, seq: nil))
                    }
                }
            }
            .sheet(isPresented: $sharing) {
                if let source = ItemBody.of(item).guestSource {
                    GuestLinkSheet(client: client, source: source, title: item.title)
                }
            }
            .navigationDestination(isPresented: $previewing) {
                if let source = client.work.canvas.preview(for: item) { PagePreview(client: client, item: item, source: source) }
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
                    navigator.open(.thread(environmentId: client.environment.id, sessionId: thread, seq: nil))
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
        if let picked = commands.ask { picked() } else { asking = ChipWords.item(item) }
    }

    private func run(_ verb: ReaderVerb) {
        switch verb {
        case .find: commands.showFind()
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
