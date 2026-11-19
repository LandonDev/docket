import SwiftUI
import TempCodeClient
import TempCodeContract

/// One held item, exactly as it will go (phone-outbox.html, "The detail"):
/// its workspace and time, what it does as the title, each field a person
/// reads on its own line (label, value, the address under a name), the body
/// as plain text, and its own bottom bar: Discard, Edit, Send. Send returns
/// to the list, where it waits five seconds with Undo (OutboxPresses.swift).
/// The fourth named bottom bar, after the dock, the hunk bar and the
/// Preamble panel.
struct OutboxItemScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(ShellNavigator.self) private var navigator
    @Environment(\.dismiss) private var dismiss
    @Environment(\.shellPose) private var pose
    let environmentId: String
    let refKey: String
    @State private var fetched: OutboxItem?
    @State private var loadError: String?
    @State private var editing = false
    @State private var confirmDiscard = false
    @State private var busy = false
    @ScaledMetric(relativeTo: .footnote) private var labelWidth: CGFloat = 64

    private var client: EnvironmentClient? { model.registry.client(environmentId) }

    /// The list's copy while it waits (the pushes keep it current), else the one fetched.
    private var item: OutboxItem? {
        client?.work.items.first { OutboxModel.key($0.ref) == refKey } ?? fetched
    }

    var body: some View {
        Group {
            if let item, let client {
                content(item, client: client)
            } else if let loadError {
                ContentUnavailableView("Can’t Open This", systemImage: "exclamationmark.triangle", description: Text(loadError))
            } else {
                ProgressView()
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .task(id: refKey) { await load() }
        #if DEBUG
        .task { await proofHooks() }
        #endif
        .accessibilityIdentifier("outbox-item")
    }

    #if DEBUG
    /// The work set's hooks (scripts/ios-sim-proof.sh `work`): the Edit sheet open for its shot, or an
    /// edit of the subject through the sheet's own path, then Send, four seconds apart so each is shot.
    private func proofHooks() async {
        for _ in 0..<100 where item == nil { try? await Task.sleep(for: .milliseconds(100)) }
        if TestHooks.sheet == "outbox-edit" { editing = true }
        guard TestHooks.action == "outbox-edit-send", let client else { return }
        try? await Task.sleep(for: .seconds(4))
        guard let current = item else { return }
        let next = OutboxModel.applyEdits(current.payload, ["arguments.subject": "Ballroom for Saturday, April 10"])
        guard let edited = try? await client.work.edit(current, payload: next.payload) else { return }
        fetched = edited
        try? await Task.sleep(for: .seconds(4))
        send(edited)
    }
    #endif

    private func load() async {
        guard let client, let ref = OutboxModel.ref(refKey) else {
            loadError = "This item is not on a paired host."
            return
        }
        do {
            fetched = try await client.work.item(ref)
        } catch {
            if item == nil { loadError = ActionError.wrap(error).message }
        }
    }

    private func content(_ item: OutboxItem, client: EnvironmentClient) -> some View {
        let view = OutboxModel.payloadView(item.payload)
        let place = client.workPlace(item.workspaceId)
        let waits = OutboxModel.waits(item.state)
        return ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        SectorDot(sector: item.sector ?? place.sector, size: 7)
                        Text(place.name)
                            .textStep(.meta)
                        Text(HeldTime.of(item.createdAt))
                            .textStep(.stamp)
                    }
                    Text(item.summary)
                        .font(.title3.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                    if let state = stateLine(item) {
                        Text(state.text)
                            .textStep(.meta, tint: state.failed ? Tint.destructiveText : nil)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, 2)
                    }
                }
                .padding(.horizontal, Layout.textEdge)
                .padding(.top, 8)
                .padding(.bottom, 12)

                ForEach(view.fields) { field in
                    Hairline()
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Text(field.label)
                            .textStep(.meta)
                            .frame(width: labelWidth, alignment: .leading)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(field.value)
                                .font(.body)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                            if let detail = field.detail {
                                Text(detail)
                                    .textStep(.meta)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, Layout.textEdge)
                    .padding(.vertical, 11)
                    .accessibilityElement(children: .combine)
                }
                if let body = view.body {
                    Hairline()
                    Text(body.text)
                        .font(.body)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, Layout.textEdge)
                        .padding(.vertical, 16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .tcBottomBar {
            if waits, client.work.canApprove {
                bar(item, client: client, editable: OutboxModel.editable(item.kind) && !view.fields.filter({ $0.edit != nil }).isEmpty || view.body != nil && OutboxModel.editable(item.kind))
            }
        }
        .sheet(isPresented: $editing) {
            OutboxEditSheet(item: item, client: client)
        }
        .confirmationDialog("Discard this?", isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("Discard", role: .destructive) { Task { await discard(item, client: client) } }
        } message: {
            Text("\(item.summary) will never go.")
        }
    }

    /// Why it stopped, or that it went: one line under the title.
    private func stateLine(_ item: OutboxItem) -> (text: String, failed: Bool)? {
        switch item.state {
        case .failed: (item.error ?? "Didn’t send.", true)
        case .stale: (item.error ?? "No longer current.", true)
        case .sending: ("Sending…", false)
        case .sent: ("\(OutboxModel.pastOf(item.verb)) \(item.decidedAt.map { HeldTime.of($0) } ?? "")", false)
        case .discarded: ("Discarded", false)
        default: item.proposed == true ? ("An agent’s rewrite waits in LifeOS.", false) : nil
        }
    }

    private func bar(_ item: OutboxItem, client: EnvironmentClient, editable: Bool) -> some View {
        HStack(spacing: 8) {
            Button("Discard", role: .destructive) { confirmDiscard = true }
                .font(.body)
                .foregroundStyle(Tint.destructive)
                .frame(minHeight: 44)
                .buttonStyle(.pressable)
                .accessibilityIdentifier("outbox-discard")
            Spacer(minLength: 0)
            if editable {
                Button("Edit") { editing = true }
                    .font(.body.weight(.medium))
                    .padding(.horizontal, 6)
                    .frame(minHeight: 36)
                    .buttonBorderShape(.capsule)
                    .tcGlassButton()
                    .accessibilityIdentifier("outbox-edit")
            }
            Button(item.state == .failed ? "Send Again" : item.verb) { send(item) }
                .font(.body.weight(.semibold))
                .padding(.horizontal, 10)
                .frame(minHeight: 36)
                .buttonBorderShape(.capsule)
                .tcGlassButton(prominent: true)
                .accessibilityIdentifier("outbox-send")
        }
        .disabled(busy)
        .padding(.horizontal, Layout.textEdge)
        .padding(.vertical, 8)
    }

    /// Back to the list, where the press waits its five seconds with Undo.
    private func send(_ item: OutboxItem) {
        OutboxPresses.shared.send(OutboxModel.Entry(environmentId: environmentId, item: item))
        close()
    }

    /// Off screen: popped in a stack; in the split the detail's root, which `dismiss` cannot pop, is cleared.
    private func close() {
        if pose.isSplit, navigator.detailRoot == .outboxItem(environmentId: environmentId, ref: refKey) {
            navigator.detailRoot = nil
        } else {
            dismiss()
        }
    }

    private func discard(_ item: OutboxItem, client: EnvironmentClient) async {
        busy = true
        defer { busy = false }
        do {
            try await client.work.discard(item)
            close()
        } catch {
            FleetToastCenter.shared.post(message: "Not discarded: \(ActionError.wrap(error).message)")
        }
    }
}

/// Edit: each field a person reads, and the body, as they will go. Save
/// writes exactly that through the host; an address that is not one is
/// refused here, by its field's name.
private struct OutboxEditSheet: View {
    @Environment(\.dismiss) private var dismiss
    let item: OutboxItem
    let client: EnvironmentClient
    @State private var edits: [String: String] = [:]
    @State private var error: String?
    @State private var saving = false

    var body: some View {
        let view = OutboxModel.payloadView(item.payload)
        NavigationStack {
            Form {
                ForEach(view.fields.filter { $0.edit != nil }) { field in
                    Section(field.label) {
                        TextField(field.label, text: binding(field.id, field.value), axis: .vertical)
                            .keyboardType(field.edit == .addresses ? .emailAddress : .default)
                            .textInputAutocapitalization(field.edit == .addresses ? .never : .sentences)
                            .autocorrectionDisabled(field.edit == .addresses)
                    }
                }
                if let body = view.body {
                    Section("Message") {
                        TextEditor(text: binding(body.id, body.text))
                            .frame(minHeight: 220)
                    }
                }
                if let error {
                    Section {
                        Text(error)
                            .textStep(.meta, tint: Tint.destructiveText)
                    }
                }
            }
            .navigationTitle("Edit")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView()
                    } else {
                        Button("Save") { Task { await save() } }
                            .disabled(edits.isEmpty)
                            .accessibilityIdentifier("outbox-edit-save")
                    }
                }
            }
        }
        .tcSheet(.form)
    }

    private func binding(_ key: String, _ initial: String) -> Binding<String> {
        Binding(get: { edits[key] ?? initial }, set: { edits[key] = $0 == initial ? nil : $0 })
    }

    private func save() async {
        let next = OutboxModel.applyEdits(item.payload, edits)
        if let message = next.error {
            error = message
            return
        }
        saving = true
        defer { saving = false }
        do {
            try await client.work.edit(item, payload: next.payload)
            dismiss()
        } catch {
            self.error = ActionError.wrap(error).message
        }
    }
}
