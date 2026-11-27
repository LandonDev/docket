import SwiftUI
import TempCodeClient
import TempCodeContract

/// A Work thread's Item segment (milestone 47, the phone-canvas page): the
/// shown item at full width, under one row that names it (a menu when the
/// thread holds several) and holds its More. Documents and sheets open in
/// the hosted editor; every other kind is drawn here.
struct ItemPage: View {
    let client: EnvironmentClient
    let sessionId: String
    @Binding var selected: String?
    /// Ask moved his words to the thread: show Chat.
    let onAsk: () -> Void
    @State private var asking: ContextChip?
    @State private var sharing: CanvasItem?
    /// The clicker on the shown deck's running show.
    @State private var clicking: CanvasItem?
    @State private var previewing: CanvasItem?
    @State private var failure: String?
    /// Print is reading its pages: a spinner stands in More's place.
    @State private var printing = false
    /// More's Find reaches the kind's viewer through these; the viewer keeps its own Ask here.
    @State private var commands = ReaderCommands(ownsAsk: false)
    /// The shown item's comments and the changes that wait on it (`ReaderFrame` fills it).
    @State private var file: ReaderFile?
    @State private var sheet: ReaderSheet?

    private var items: [CanvasItem] { client.work.canvas.items(sessionId) }
    private var item: CanvasItem? { items.first { $0.id == selected } ?? testItem ?? items.first }

    /// The work set: `TC_TEST_ITEM` names the item to show first, by kind or a part of its title.
    private var testItem: CanvasItem? {
        #if DEBUG
        guard let want = TestHooks.item else { return nil }
        return items.first { $0.kind.rawValue == want } ?? items.first { $0.title.localizedCaseInsensitiveContains(want) }
        #else
        return nil
        #endif
    }

    var body: some View {
        VStack(spacing: 0) {
            if let item {
                header(item)
                Divider()
                ReaderFrame(client: client, item: item, commands: commands, file: $file, sheet: $sheet) {
                    // A key that may only read has no Ask: the host would refuse its words.
                    ItemBodyView(client: client, item: item, ask: client.work.may(.sessionSend) ? { asking = $0 } : nil)
                        .id(item.id)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                .environment(commands)
            } else {
                ContentUnavailableView("Nothing Open", systemImage: "rectangle.on.rectangle")
            }
        }
        .sheet(item: $asking) { chip in
            AskSheet(client: client, target: .thread(sessionId), chip: chip) { _ in onAsk() }
        }
        .sheet(item: $sharing) { item in
            if let source = ShareSource.of(item) {
                ShareLinkSheet(client: client, source: source, title: item.title, purdue: client.workspaces.first { $0.id == item.workspaceId }?.sector == "purdue")
            }
        }
        .fullScreenCover(item: $clicking) { deck in
            HostClicker(client: client, itemId: deck.id) { clicking = nil }
        }
        .navigationDestination(item: $previewing) { item in
            if let source = client.work.canvas.preview(for: item) { PagePreview(client: client, item: item, source: source).sidebarButtonPage() }
        }
        .alert("Couldn’t Do That", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(failure ?? "") }
        .accessibilityIdentifier("item-page")
        // The hosted editor's ticket is asked the moment an item is the one to show.
        .onChange(of: item?.id, initial: true) { if let item { client.work.canvas.warmTicket(item) } }
        #if DEBUG
        // The work set's item, as the thread's selection, so the segment bar names it too.
        .onChange(of: items.map(\.id), initial: true) { if selected == nil, let pick = testItem { selected = pick.id } }
        #endif
    }

    /// One place up or down the thread's items; the host's answer is the order kept, its refusal said in its words.
    private func move(_ item: CanvasItem, by: Int) {
        guard let order = CanvasOrder.moved(items.map(\.id), item.id, by: by) else { return }
        Task {
            do {
                try await client.work.canvas.reorder(sessionId, order: order)
            } catch {
                failure = (error as? ActionError)?.message ?? String(describing: error)
            }
        }
    }

    private func header(_ item: CanvasItem) -> some View {
        HStack(spacing: 8) {
            // The shown item's name is the segment's label already: the row never says it again. With several, the
            // switch is a glyph beside More, its menu the items by name with the shown one ticked.
            Spacer(minLength: 8)
            if items.count > 1 {
                Menu {
                    Picker("Item", selection: Binding(get: { item.id }, set: { selected = $0 })) {
                        ForEach(items, id: \.id) { Text($0.title).tag($0.id) }
                    }
                    // The thread's tab order, the desktop's tab row (`work.canvas.reorder`): the shown item moves.
                    if client.work.may(.canvasReorder) {
                        Section {
                            Button("Move Up", systemImage: "arrow.up") { move(item, by: -1) }
                                .disabled(items.first?.id == item.id)
                            Button("Move Down", systemImage: "arrow.down") { move(item, by: 1) }
                                .disabled(items.last?.id == item.id)
                        }
                    }
                } label: {
                    Image(systemName: "square.on.square")
                        .frame(minWidth: Layout.hitTarget, minHeight: Layout.hitTarget)
                }
                .accessibilityLabel("Switch item, \(items.count) open")
                .accessibilityIdentifier("item-switch")
            }
            if printing {
                ProgressView()
                    .frame(minWidth: Layout.hitTarget, minHeight: Layout.hitTarget)
                    .accessibilityLabel("Reading the pages to print")
            } else {
                Menu {
                    // The reader page's own rows (Work/Reader): one menu for a file wherever it shows.
                    ReaderMoreRows(verbs: ReaderVerbs.of(item, facts(item))) { run($0, on: item) }
                } label: {
                    Image(systemName: GlassMetrics.moreSymbol)
                        .frame(minWidth: Layout.hitTarget, minHeight: Layout.hitTarget)
                }
                .accessibilityLabel("More")
                .accessibilityIdentifier("item-more")
            }
        }
        .padding(.leading, Layout.textEdge)
        .padding(.trailing, Layout.textEdge - 12)
        .frame(minHeight: 44)
    }

    /// What More can offer for the shown item; the comments and changes count only once they are this item's.
    private func facts(_ item: CanvasItem) -> ReaderFacts {
        let file = file?.item.id == item.id ? file : nil
        return ReaderFacts(
            mayClose: client.work.may(.canvasClose),
            mayGuestLink: client.work.may(.guestsCreate),
            inThread: true,
            waiting: file?.waiting ?? 0,
            previews: client.work.canvas.preview(for: item) != nil,
            comments: file?.takesComments ?? false,
            finds: commands.frame?.offers.find ?? false,
            undo: commands.frame?.canUndo ?? false,
            redo: commands.frame?.canRedo ?? false,
            showing: client.work.may(.slidesShowPress) && client.work.shows.values.contains { $0.itemId == item.id },
            mayKeep: client.work.may(.canvasKeep)
        )
    }

    private func run(_ verb: ReaderVerb, on item: CanvasItem) {
        switch verb {
        case .undo: commands.frame?.run(.undo)
        case .redo: commands.frame?.run(.redo)
        case .clicker: clicking = item
        case .find: commands.showFind()
        case .guestLink: sharing = item
        case .close:
            Task {
                do { try await client.work.canvas.close(item) } catch { failure = ActionError.wrap(error).message }
            }
        case .preview: previewing = item
        case .keep:
            Task {
                do {
                    let name = try await client.work.canvas.keep(item)
                    FleetToastCenter.shared.post(note: MailRules.keptLine(name))
                } catch { failure = ActionError.wrap(error).message }
            }
        case .print:
            Task {
                printing = true
                defer { printing = false }
                do { try await ReaderPrint.run(client: client, item: item) } catch { failure = ActionError.wrap(error).message }
            }
        case .comments: sheet = .comments
        case .review: sheet = .review
        }
    }
}

/// The kind's own view. `ask` is nil where no thread stands beside the item (a file open from Files): no Ask shows.
struct ItemBodyView: View {
    let client: EnvironmentClient
    let item: CanvasItem
    let ask: ((ContextChip) -> Void)?

    var body: some View {
        // A mail's file (or a chat's) comes onto its host first; its kind reads it there.
        if MailRules.fetches(item) {
            FetchFirst(client: client, item: item) { kind }
        } else {
            kind
        }
    }

    @ViewBuilder private var kind: some View {
        switch ItemBody.of(item) {
        case .hosted(let source):
            HostedItemView(client: client, item: item, source: source, ask: ask)
        case .pdf:
            PdfItemView(client: client, item: item, ask: ask)
        case .slides:
            SlidesItemView(client: client, item: item, ask: ask)
        case .media:
            MediaItemView(client: client, item: item)
        case .meeting:
            MeetingItemView(client: client, item: item)
        case .browser:
            BrowserItemView(client: client, item: item)
        case .form:
            FormItemView(client: client, item: item)
        case .dashboard:
            DashboardItemView(client: client, item: item)
        case .history(let source):
            HistoryItemView(client: client, source: source)
        case .mail(let draftId):
            MailItemView(client: client, item: item, draftId: draftId)
        case .unavailable(let words):
            ContentUnavailableView(item.title, systemImage: "desktopcomputer", description: Text(words))
        }
    }
}

/// Where Ask's words go: the thread beside the item, or, for a file open from Files, the thread that holds
/// it, else a new one in its workspace (`FileAsk`).
enum AskTarget {
    case thread(String)
    case file(workspaceId: String, item: CanvasItem)
}

/// Ask: what he picked in the item as a chip, then his words; `sent` hears the thread they went to.
struct AskSheet: View {
    @Environment(\.dismiss) private var dismiss
    let client: EnvironmentClient
    let target: AskTarget
    let chip: ContextChip
    let sent: (_ sessionId: String) -> Void
    @State private var text = ""
    @State private var sending = false
    @State private var error: String?
    /// A thread an earlier Send started whose file would not open in it: Send again finishes that one.
    @State private var started: String?
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ItemChip(chip: chip)
                        .listRowSeparator(.hidden)
                    if let quote = chip.quote, !quote.isEmpty {
                        Text(quote).textStep(.meta).foregroundStyle(.secondary).lineLimit(4)
                    }
                    TextField("Ask about it", text: $text, axis: .vertical)
                        .lineLimit(2...10)
                        .focused($focused)
                        .accessibilityIdentifier("ask-text")
                } footer: {
                    if let error { Text(error).foregroundStyle(Tint.destructiveText) }
                }
            }
            .navigationTitle("Ask")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if sending {
                        ProgressView()
                    } else {
                        Button("Send") { Task { await send() } }
                            .keyboardShortcut(.return, modifiers: .command)
                            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .accessibilityIdentifier("ask-send")
                    }
                }
            }
            .onAppear { focused = true }
        }
        .tcSheet(.form)
    }

    private func send() async {
        sending = true
        defer { sending = false }
        do {
            let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
            let thread: String
            switch target {
            case .thread(let sessionId):
                try await client.work.ask(sessionId: sessionId, chip: chip, text: words)
                thread = sessionId
            case .file(let workspaceId, let item):
                thread = try await client.work.ask(workspaceId: workspaceId, item: item, chip: chip, text: words, into: started) { client.session($0) }
            }
            dismiss()
            sent(thread)
        } catch let stopped as FileAsk.NotSeated {
            // His words stay in the field; the thread is kept for the next Send.
            started = stopped.threadId
            self.error = ActionError.wrap(stopped.cause).message
        } catch {
            self.error = ActionError.wrap(error).message
        }
    }
}

/// A view that reads its kind's answer once it shows: a spinner, the view, or why not, with Try Again.
struct ItemLoad<Value, Content: View>: View {
    /// A reload drops what was shown first, so the spinner, then a fresh value or the failure with Try Again, stand
    /// in its place: for a view whose old value must not stay live through a refresh (a deck's review after a decision).
    var dropsOnReload = false
    /// What to draw before the first read answers: the file as it was last drawn in this run. It gives way to the
    /// read's answer, or to its failure.
    var initial: Value? = nil
    /// What stands in while nothing is known yet, in place of the spinner: the paper's shape with its bar.
    var loading: (() -> AnyView)? = nil
    /// The computer the read asks, named in its failure (`WorkErrorWords.readFailure`), never a program or an id.
    var host: String? = nil
    let read: () async throws -> Value
    /// Each read that answers, for a view that holds something newer than the last value until the next one lands.
    var onRead: ((Value) -> Void)? = nil
    /// A reload that fails while a value is shown: the value stays, and the view can say so with its own Retry.
    var onRefreshFailed: ((String) -> Void)? = nil
    @ViewBuilder let content: (Value, _ reload: @escaping () -> Void) -> Content
    @State private var value: Value?
    /// The first read has answered or failed: `initial` is spent.
    @State private var settled = false
    @State private var error: String?
    @State private var round = 0
    /// A read is out: a reload waits for it rather than cancelling it (a poll faster than the host).
    @State private var reading = false

    var body: some View {
        Group {
            if let value = value ?? (settled ? nil : initial) {
                content(value) {
                    guard !reading else { return }
                    if dropsOnReload { self.value = nil }
                    round += 1
                }
            } else if let error {
                ContentUnavailableView {
                    Label("Can’t Open This", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(error)
                } actions: {
                    Button("Try Again") { self.error = nil; round += 1 }
                }
            } else if let loading {
                loading()
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: round) {
            reading = true
            defer { reading = false; settled = true }
            do {
                let next = try await read()
                value = next
                error = nil
                onRead?(next)
            } catch {
                // A read cut off by the next one, or by the view leaving, is no failure.
                if error is CancellationError || Task.isCancelled { return }
                let words = WorkErrorWords.readFailure(ActionError.wrap(error).message, host: host)
                if value == nil { self.error = words } else { onRefreshFailed?(words) }
            }
        }
    }
}

/// The guest link sheet is keyed by the item it shares.
extension CanvasItem: @retroactive Identifiable {}
