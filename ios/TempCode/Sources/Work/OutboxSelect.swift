import SwiftUI
import TempCodeClient
import TempCodeContract

/// Select on the Outbox (docs/IOS-DESIGN.md "Work on the phone", the prototype `work-ios/outbox.html`): whether the
/// list is choosing, his ticks (`OutboxSelection`), and the LifeOS mails the summary read whole that only their own
/// page sends. One per app: the list in the sidebar and the summary in the detail column read the same ticks.
@MainActor @Observable
final class OutboxSelecting {
    static let shared = OutboxSelecting()

    private(set) var on = false
    var selection = OutboxSelection()
    /// Ticked LifeOS replies read whole that quote the mail they answer: "Open to send", out of Send.
    private(set) var openOnly: Set<String> = []
    /// Mails already read whole for that, by entry id and revision.
    @ObservationIgnored private var read: Set<String> = []

    private init() {}

    func begin() {
        selection.clear()
        on = true
    }

    func end() {
        on = false
        selection.clear()
        openOnly = []
    }

    /// A ticked LifeOS mail is read whole once at the revision ticked: one that quotes its mail is sent from its own
    /// page alone. A read that fails says nothing here; the host refuses it inside the press and its row says why.
    func readWhole(_ entries: [OutboxModel.Entry], client: (String) -> EnvironmentClient?) async {
        for entry in entries where entry.item.kind == .mailSend {
            let key = "\(entry.id)@\(entry.item.updatedAt)"
            guard read.insert(key).inserted, let work = client(entry.environmentId)?.work else { continue }
            if let whole = try? await work.item(entry.item.ref), OutboxModel.quotesItsMail(whole) { openOnly.insert(entry.id) }
        }
    }
}

/// One summary of the ticked rows: one sentence of what goes, a row per item with its tick and a chevron that opens
/// the item to read, and the press (Discard N at the leading edge, Send N prominent). A sheet on a phone; on the open
/// Duo the detail column itself, beside the list he ticks in. Send asks the owner's check once and waits the same
/// five seconds with Undo as one press; Discard asks once, with "Why, for the thread".
struct OutboxSummary: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// In the phone's sheet (it closes itself after a press); else the open Duo's detail column.
    let inSheet: Bool
    /// The press is being checked or answered: no second one meanwhile.
    @State private var busy = false
    /// Why his last press here did not start.
    @State private var line: String?
    @State private var confirmDiscard = false
    @State private var reason = ""

    private var selecting: OutboxSelecting { OutboxSelecting.shared }

    var body: some View {
        let clients = model.registry.ordered
        let byId = Dictionary(OutboxEntries.of(clients).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let rows = selecting.selection.listed.compactMap { byId[$0] }
        let ticked = rows.filter { selecting.selection.contains($0.id) }
        let send = GroupPress(ticked, act: .send, openOnly: selecting.openOnly)
        let discard = GroupPress(ticked, act: .discard(reason: nil))
        Group {
            if rows.isEmpty {
                ContentUnavailableView("Nothing Selected", systemImage: "checklist")
            } else {
                List {
                    Section {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(send?.head ?? discard?.head ?? "Nothing selected")
                                .font(.title3.weight(.semibold))
                                .foregroundStyle(ticked.isEmpty ? .secondary : .primary)
                                .fixedSize(horizontal: false, vertical: true)
                                .contentTransition(.opacity)
                                .accessibilityIdentifier("outbox-summary-head")
                            if let line {
                                Text(line)
                                    .textStep(.meta, tint: Tint.destructiveText)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .padding(.vertical, 4)
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets(top: 8, leading: Layout.textEdge, bottom: 12, trailing: Layout.textEdge))
                    }
                    Section {
                        ForEach(rows) { entry in
                            SummaryRow(
                                entry: entry,
                                ticked: selecting.selection.contains(entry.id),
                                openOnly: selecting.openOnly.contains(entry.id),
                                toggle: { selecting.selection.toggleInSummary(entry.id) }
                            )
                        }
                    }
                }
                .listStyle(.plain)
                .animation(reduceMotion ? nil : Motion.base, value: ticked.map(\.id))
            }
        }
        .tcBottomBar { foot(send: send, discard: discard) }
        .navigationBarTitleDisplayMode(.inline)
        .task(id: ticked.map { "\($0.id)@\($0.item.updatedAt)" }) {
            await selecting.readWhole(ticked) { model.registry.client($0) }
        }
        .alert("Discard \(discard?.entries.count ?? 0)?", isPresented: $confirmDiscard) {
            TextField("Why, for the thread", text: $reason)
                .textInputAutocapitalization(.sentences)
                .accessibilityIdentifier("outbox-summary-discard-reason")
            Button("Discard", role: .destructive) {
                let words = reason
                reason = ""
                if let press = GroupPress(ticked, act: .discard(reason: words)) { Task { await self.discard(press) } }
            }
            Button("Cancel", role: .cancel) { reason = "" }
        } message: {
            Text("None of them will go.")
        }
        .accessibilityIdentifier("outbox-summary")
    }

    @ViewBuilder
    private func foot(send: GroupPress?, discard: GroupPress?) -> some View {
        HStack(spacing: 8) {
            Button("Discard \(discard?.entries.count ?? 0)", role: .destructive) { confirmDiscard = true }
                .font(.body)
                .foregroundStyle(Tint.destructive)
                .frame(minHeight: Layout.rowHeight)
                .buttonStyle(.pressable)
                .disabled(discard == nil)
                .accessibilityIdentifier("outbox-summary-discard")
            Spacer(minLength: 0)
            Button {
                if let send { Task { await self.send(send) } }
            } label: {
                ZStack {
                    Text("Send \(send?.entries.count ?? 0)").opacity(busy ? 0 : 1)
                    if busy { ProgressView() }
                }
            }
            .font(.body.weight(.semibold))
            .padding(.horizontal, 10)
            .frame(minHeight: Layout.rowHeight)
            .buttonBorderShape(.capsule)
            .tcGlassButton(prominent: true)
            .disabled(send == nil)
            .accessibilityIdentifier("outbox-summary-send")
        }
        .disabled(busy)
        .padding(.horizontal, Layout.textEdge)
        .padding(.vertical, 8)
    }

    /// The links and the owner's check, then the five seconds with Undo over the list; a press that did not start
    /// stays here and says why.
    private func send(_ press: GroupPress) async {
        busy = true
        defer { busy = false }
        line = nil
        if let refused = await OutboxPresses.shared.sendGroup(press) { line = refused } else { finish() }
    }

    private func discard(_ press: GroupPress) async {
        busy = true
        defer { busy = false }
        line = nil
        if let refused = await OutboxPresses.shared.discardGroup(press) { line = refused } else { finish() }
    }

    /// Back to the list he chose from: Select ends; the sheet closes, and on the open Duo the list gives the detail
    /// its next row.
    private func finish() {
        selecting.end()
        if inSheet { dismiss() }
    }
}

/// One ticked item in the summary: its tick, what it does and to whom, and a chevron that opens the item to read.
private struct SummaryRow: View {
    let entry: OutboxModel.Entry
    let ticked: Bool
    /// Only its own page sends it: it says so and stays out of Send.
    let openOnly: Bool
    let toggle: () -> Void

    var body: some View {
        let words = OutboxModel.rowWords(entry.item)
        HStack(alignment: .center, spacing: Layout.rowGap) {
            Button(action: toggle) { OutboxTick(on: ticked) }
                .buttonStyle(.plain)
                .frame(width: Layout.rowHeight, height: Layout.rowHeight)
                .contentShape(Rectangle())
                .accessibilityLabel(ticked ? "Included" : "Left out")
                .accessibilityHint("Double tap to change")
                .accessibilityIdentifier("outbox-summary-tick")
            NavigationLink {
                OutboxItemScreen(environmentId: entry.environmentId, refKey: OutboxModel.key(entry.item.ref), readOnly: true)
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(words.title).textStep(.title).lineLimit(1)
                    if let line = openOnly ? OutboxModel.openToSend : words.line {
                        Text(line).textStep(.meta).lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: Layout.rowHeight, alignment: .leading)
            }
        }
        // A row he left out steps back; it stays, so he can tick it again.
        .opacity(ticked ? 1 : 0.45)
        .padding(.vertical, 2)
        .listRowInsets(EdgeInsets(top: 0, leading: Layout.textEdge - Layout.rowGap, bottom: 0, trailing: Layout.textEdge))
        .accessibilityElement(children: .contain)
    }
}

/// A row's tick while he selects: the filled check in the tint, else the empty ring, at the body's text size.
struct OutboxTick: View {
    let on: Bool

    var body: some View {
        Image(systemName: on ? "checkmark.circle.fill" : "circle")
            .font(.title2)
            .foregroundStyle(on ? AnyShapeStyle(.tint) : AnyShapeStyle(.tertiary))
            .contentTransition(.symbolEffect(.replace))
            .accessibilityHidden(true)
    }
}

/// The phone's own sheet for the summary (`tcSheet`), from the list's Send N….
struct OutboxSummarySheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            OutboxSummary(inSheet: true)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close", systemImage: "xmark") { dismiss() }
                            .accessibilityIdentifier("outbox-summary-close")
                    }
                }
        }
        .tcSheet(.editor)
    }
}
