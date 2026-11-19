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
    @State private var failure: String?

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
                ItemBodyView(client: client, item: item, ask: { asking = $0 })
                    .id(item.id)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ContentUnavailableView("Nothing Open", systemImage: "rectangle.on.rectangle")
            }
        }
        .sheet(item: $asking) { chip in
            AskSheet(client: client, sessionId: sessionId, chip: chip) { onAsk() }
        }
        .sheet(item: $sharing) { item in
            if let source = ItemBody.of(item).guestSource {
                GuestLinkSheet(client: client, source: source, title: item.title)
            }
        }
        .alert("Couldn’t do that", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(failure ?? "") }
        .accessibilityIdentifier("item-page")
        #if DEBUG
        // The work set's item, as the thread's selection, so the segment bar names it too.
        .onChange(of: items.map(\.id), initial: true) { if selected == nil, let pick = testItem { selected = pick.id } }
        #endif
    }

    private func header(_ item: CanvasItem) -> some View {
        HStack(spacing: 8) {
            if items.count > 1 {
                Menu {
                    Picker("Item", selection: Binding(get: { item.id }, set: { selected = $0 })) {
                        ForEach(items, id: \.id) { Text($0.title).tag($0.id) }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text(item.title).textStep(.title, weight: .semibold).lineLimit(1)
                        Image(systemName: "chevron.down").imageScale(.small).foregroundStyle(.secondary)
                    }
                }
                .accessibilityIdentifier("item-switch")
            }
            // One item: its name is the segment's label already, so the row holds only its More.
            Spacer(minLength: 8)
            Menu {
                if ItemBody.of(item).guestSource != nil, client.work.canApprove {
                    Button("Make a Guest Link", systemImage: "person.badge.plus") { sharing = item }
                }
                Button("Close", systemImage: "xmark.square") {
                    Task {
                        do { try await client.work.canvas.close(item) } catch { failure = ActionError.wrap(error).message }
                    }
                }
            } label: {
                Image(systemName: GlassMetrics.moreSymbol)
                    .frame(minWidth: 44, minHeight: 44)
            }
            .accessibilityLabel("More")
            .accessibilityIdentifier("item-more")
        }
        .padding(.leading, Layout.textEdge)
        .padding(.trailing, Layout.textEdge - 12)
        .frame(minHeight: 44)
    }
}

/// The kind's own view.
struct ItemBodyView: View {
    let client: EnvironmentClient
    let item: CanvasItem
    let ask: (ContextChip) -> Void

    var body: some View {
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

/// Ask: what he picked in the item as a chip, then his words; it goes to the thread beside the item.
struct AskSheet: View {
    @Environment(\.dismiss) private var dismiss
    let client: EnvironmentClient
    let sessionId: String
    let chip: ContextChip
    let sent: () -> Void
    @State private var text = ""
    @State private var sending = false
    @State private var error: String?
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
            try await client.work.ask(sessionId: sessionId, chip: chip, text: text.trimmingCharacters(in: .whitespacesAndNewlines))
            dismiss()
            sent()
        } catch {
            self.error = ActionError.wrap(error).message
        }
    }
}

/// A view that reads its kind's answer once it shows: a spinner, the view, or why not, with Try Again.
struct ItemLoad<Value, Content: View>: View {
    let read: () async throws -> Value
    @ViewBuilder let content: (Value, _ reload: @escaping () -> Void) -> Content
    @State private var value: Value?
    @State private var error: String?
    @State private var round = 0
    /// A read is out: a reload waits for it rather than cancelling it (a poll faster than the host).
    @State private var reading = false

    var body: some View {
        Group {
            if let value {
                content(value) { if !reading { round += 1 } }
            } else if let error {
                ContentUnavailableView {
                    Label("Can’t Open This", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(error)
                } actions: {
                    Button("Try Again") { self.error = nil; round += 1 }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: round) {
            reading = true
            defer { reading = false }
            do {
                value = try await read()
                error = nil
            } catch {
                if value == nil { self.error = ActionError.wrap(error).message }
            }
        }
    }
}

/// The guest link sheet is keyed by the item it shares.
extension CanvasItem: @retroactive Identifiable {}
