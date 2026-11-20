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
    /// The whole read failed while the list's copy shows: what only it carries (a quote, a picture) did not come.
    @State private var wholeError: String?
    @State private var editing = false
    @State private var confirmDiscard = false
    @State private var busy = false
    @ScaledMetric(relativeTo: .footnote) private var labelWidth: CGFloat = 64

    private var client: EnvironmentClient? { model.registry.client(environmentId) }

    /// The list's copy while it waits (the pushes keep it current), else the one fetched.
    private var listed: OutboxItem? {
        client?.work.items.first { OutboxModel.key($0.ref) == refKey }
    }

    /// The whole read while it is as new as the list's copy: it carries what the list leaves out
    /// (a LifeOS reply's quote, a computer act's picture); else the list's copy.
    private var whole: OutboxItem? {
        guard let fetched else { return nil }
        guard let listed else { return fetched }
        return fetched.updatedAt >= listed.updatedAt ? fetched : nil
    }

    private var item: OutboxItem? { whole ?? listed ?? fetched }

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
        // Read whole again when the list's copy moves on, so the quote and the picture match what goes.
        .task(id: "\(refKey)-\(listed?.updatedAt ?? 0)") { await load() }
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
        if TestHooks.action == "outbox-grant-send", let current = item, let client, let grant = OutboxModel.grantFor(current.kind, payload: current.payload) {
            try? await Task.sleep(for: .seconds(2))
            await sendAndGrant(current, grant: grant, client: client)
            return
        }
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
            wholeError = nil
        } catch {
            if item == nil { loadError = ActionError.wrap(error).message } else { wholeError = ActionError.wrap(error).message }
        }
    }

    private func content(_ item: OutboxItem, client: EnvironmentClient) -> some View {
        let view = OutboxModel.actView(item)
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
                    // A form, a share or a Teams post says in its heading only what its rows do not (`kindHeading`).
                    Text(OutboxModel.kindHeading(kind: item.kind, payload: item.payload, sent: item.state == .sent) ?? item.summary)
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
                // While a mail is read whole (an Outlook body, a LifeOS reply's quote), one muted bone holds
                // the place it lands, so a dim Send has a reason on screen.
                if whole == nil, wholeError == nil, item.kind == .mailSend || item.kind == .officeMailSend {
                    Text("The mail is still being read")
                        .textStep(.meta)
                        .redacted(reason: .placeholder)
                        .padding(.horizontal, Layout.textEdge)
                        .padding(.vertical, 16)
                        .accessibilityLabel("Reading the mail")
                        .accessibilityIdentifier("outbox-whole-reading")
                }
                // What LifeOS puts under a reply goes too: in its place, muted, as a mail client quotes.
                if let quote = view.quote {
                    Text(quote)
                        .textStep(.meta)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, Layout.textEdge)
                        .padding(.bottom, 16)
                        .padding(.top, view.body == nil ? 16 : 0)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("outbox-quote")
                }
                if item.kind == .computerAct {
                    KeptPictureView(listed: item, whole: whole, failed: wholeError, retry: { Task { await load() } })
                        .padding(.horizontal, Layout.textEdge)
                        .padding(.vertical, 16)
                } else if OutboxModel.sendsFromDetailOnly(item.kind), whole == nil, let wholeError {
                    readFailed("The mail did not load: \(wholeError)")
                        .padding(.horizontal, Layout.textEdge)
                        .padding(.vertical, 16)
                }
            }
        }
        .tcBottomBar {
            if waits, client.work.canApprove {
                bar(item, client: client, editable: OutboxModel.editable(item.kind) && (!view.fields.filter({ $0.edit != nil }).isEmpty || view.body?.readOnly == false),
                    ready: OutboxModel.detailReady(item.kind, whole: whole) && pictureDraws(whole))
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
        case .failed: (OutboxModel.failureLine(item), true)
        case .stale: (item.error ?? "No longer current.", true)
        case .sending: ("Sending…", false)
        case .sent: ("\(OutboxModel.pastOf(item.verb)) \(item.decidedAt.map { HeldTime.of($0) } ?? "")", false)
        case .discarded: ("Discarded", false)
        default: item.proposed == true ? ("An agent’s rewrite waits in LifeOS.", false) : nil
        }
    }

    /// A read that did not come back: its reason and Retry.
    private func readFailed(_ words: String) -> some View {
        HStack(spacing: 12) {
            Text(words).textStep(.meta, tint: Tint.destructiveText).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            PillButton("Retry") { Task { await load() } }
        }
    }

    /// Send waits until what it approves is on screen: a kept picture's bytes must draw.
    private func pictureDraws(_ whole: OutboxItem?) -> Bool {
        guard let whole, case .bytes(let data, _, _) = OutboxModel.keptPicture(whole.payload) else { return true }
        return UIImage(data: data) != nil
    }

    /// Send waits (`ready`) until the whole read and a computer act's picture have come; Discard and Edit do not.
    private func bar(_ item: OutboxItem, client: EnvironmentClient, editable: Bool, ready: Bool) -> some View {
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
                    .frame(minHeight: Layout.rowHeight)
                    .buttonBorderShape(.capsule)
                    .tcGlassButton()
                    .accessibilityIdentifier("outbox-edit")
            }
            sendButton(item, client: client)
                .disabled(!ready)
        }
        .disabled(busy)
        .padding(.horizontal, Layout.textEdge)
        .padding(.vertical, 8)
    }

    /// Send, the item's own verb. With a grant the kind offers and a key that may make one, a press and
    /// hold opens the split Send's menu: "Send and stop holding" › the grant's name (the desktop's).
    @ViewBuilder
    private func sendButton(_ item: OutboxItem, client: EnvironmentClient) -> some View {
        let title = item.state == .failed ? "Send Again" : item.verb
        if client.work.canAdmin, item.state == .held, let grant = OutboxModel.grantFor(item.kind, payload: item.payload) {
            Menu {
                Section("Send and stop holding") {
                    Button(grant.label, systemImage: "checkmark.seal") { Task { await sendAndGrant(item, grant: grant, client: client) } }
                }
            } label: {
                Text(title)
            } primaryAction: {
                send(item)
            }
            .font(.body.weight(.semibold))
            .padding(.horizontal, 10)
            .frame(minHeight: Layout.rowHeight)
            .buttonBorderShape(.capsule)
            .tcGlassButton(prominent: true)
            .accessibilityIdentifier("outbox-send")
            .accessibilityHint("Touch and hold to send and stop holding acts like this one")
        } else {
            Button(title) { send(item) }
                .font(.body.weight(.semibold))
                .padding(.horizontal, 10)
                .frame(minHeight: Layout.rowHeight)
                .buttonBorderShape(.capsule)
                .tcGlassButton(prominent: true)
                .accessibilityIdentifier("outbox-send")
        }
    }

    /// The grant first (only from a held item), then this item's Send with its five seconds of Undo.
    /// Undo takes back the Send, not the grant; Settings → Work lists the grant with Remove.
    private func sendAndGrant(_ item: OutboxItem, grant: (matcher: JSONValue, label: String), client: EnvironmentClient) async {
        busy = true
        defer { busy = false }
        do {
            _ = try await client.work.grant(item, matcher: grant.matcher, label: grant.label)
            send(item)
        } catch {
            FleetToastCenter.shared.post(message: "No grant made: \(ActionError.wrap(error).message)")
        }
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
                if let body = view.body, !body.readOnly {
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

/// A computer act's kept picture: the window as it was read, what his press approves. The list
/// leaves its bytes out, so it draws from the whole read; one kept but not come is a failure with
/// Retry, never "none kept"; an act that kept none draws nothing.
private struct KeptPictureView: View {
    let listed: OutboxItem
    let whole: OutboxItem?
    let failed: String?
    let retry: () -> Void
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        let kept = OutboxModel.keptPicture(listed.payload)
        let read = whole.map { OutboxModel.keptPicture($0.payload) }
        switch read {
        case .bytes(let data, let width, let height)?:
            if let image = UIImage(data: data) {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(aspect(width, height) ?? image.size.width / max(1, image.size.height), contentMode: .fit)
                    .clipShape(RoundedRectangle.fieldCorner)
                    .overlay { RoundedRectangle.fieldCorner.stroke(Surface.hairline, lineWidth: Hairline.thickness(scale: displayScale)) }
                    .accessibilityLabel("The window as it was read, \(listed.summary)")
            } else {
                failure
            }
        case .missing?:
            failure
        case .notKept?:
            EmptyView()
        case nil:
            if kept == .notKept {
                EmptyView()
            } else if failed != nil {
                failure
            } else {
                // While the whole read comes: the picture's own shape, so nothing moves when it lands.
                RoundedRectangle.fieldCorner
                    .fill(Surface.fill)
                    .aspectRatio(listedAspect ?? 1.6, contentMode: .fit)
                    .overlay { ProgressView() }
            }
        }
    }

    private var failure: some View {
        HStack(spacing: 12) {
            Text("The picture did not load").textStep(.meta, tint: Tint.destructiveText)
            Spacer(minLength: 8)
            PillButton("Retry", action: retry)
        }
    }

    private func aspect(_ width: Double?, _ height: Double?) -> CGFloat? {
        guard let width, let height, width > 0, height > 0 else { return nil }
        return width / height
    }

    /// The kept picture's shape as the list carries it (its size, without the bytes).
    private var listedAspect: CGFloat? {
        guard case .object(let o)? = listed.payload, case .object(let p)? = o["picture"],
              case .number(let w)? = p["width"], case .number(let h)? = p["height"] else { return nil }
        return aspect(w, h)
    }
}
