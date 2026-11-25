import SwiftUI
import TempCodeClient
import TempCodeContract

/// Share (docs/IOS-DESIGN.md "Share"; the desktop's one Share sheet, fb35a39d8): a new link on top (For, Can,
/// Ends; Create shows the address once, with Copy and Share), the item's live links under it, each with its line
/// of facts and its menu (Replace Address…, the role, Revoke). Where no link can be made, the host's one line says
/// what to do instead, in the form's place. A Purdue workspace's file is university data: one line says so under
/// the form. Making, widening and readdressing a link are outward: `PressGates` first, then the press record.
/// Create waits until the host that serves the item's links has answered; the host, its key and the draft are
/// frozen before the owner's check. One attempt key per item lives in `GuestAttempts` until the phone knows what
/// became of it, so a lost answer, a busy refusal or the sheet opened again never makes a second link.
struct ShareLinkSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var model
    let client: EnvironmentClient
    let source: ShareSource
    let title: String
    var purdue = false
    /// The host that keeps this item's links: the one asked, or the one it named (`served elsewhere`).
    @State private var home: EnvironmentClient?
    @State private var draft = GuestLinkDraft()
    @State private var days = ShareRules.defaultDays
    @State private var made: ShareRules.Made?
    /// An address the host made for this item or one of its links that no screen showed yet (`GuestAttempts.unseen`):
    /// an answer that came after its press stopped waiting, or a press made from Settings.
    @State private var late: GuestAttempts.Unseen?
    @State private var links: [GuestLinkRow]?
    @State private var refused: String?
    @State private var listError: String?
    /// A press on a link that did not go (Replace, the role, Revoke): its words alone, never under the list's Try Again.
    @State private var pressError: String?
    @State private var saving = false
    @State private var error: String?
    @State private var replacing: GuestLinkRow?
    @State private var revoking: GuestLinkRow?
    @State private var busy: String?
    @FocusState private var focused: Bool

    private var host: EnvironmentClient { home ?? client }
    /// No press on a link is out: Create and Replace Address answer the address once, here alone (`ShareRules.mayClose`).
    private var mayClose: Bool { ShareRules.mayClose(creating: saving, linkBusy: busy) }
    private var live: [GuestLinkRow] { ShareRules.live(links ?? []) }
    private var attempts: GuestAttempts { GuestAttempts.shared }
    /// Where this item's Create stands on its serving host: Checking after a lost answer, made, refused.
    private var phase: GuestAttempts.Phase? { attempts.phase(host: host.environment.id, ref: source.ref) }
    /// The host restarted while making the last link: his New Link starts over, the form waits for it.
    private var isCut: Bool { if case .cut? = phase { true } else { false } }

    /// The serving host has answered the item's links: only then is Create offered (a redirect may still come).
    private var settled: Bool { links != nil }

    var body: some View {
        NavigationStack {
            Form {
                if let refused {
                    Section { Text(refused).foregroundStyle(.secondary) }
                } else if let made {
                    switch made {
                    case .address(let url, _): GuestAddressSection(address: url)
                    case .again: Section { Text(ShareRules.againWords).foregroundStyle(.secondary) }
                    }
                } else if let late {
                    // Kept from an answer no screen showed: named, since the item may have several links.
                    GuestAddressSection(address: late.address, footer: "\(late.whose). This address shows once.")
                } else if phase == .made {
                    // A lost answer read back as made: the link is in the list below, its address shown nowhere.
                    Section { Text(ShareRules.againWords).foregroundStyle(.secondary) }
                } else {
                    form
                }
                if refused == nil { linkRows }
            }
            .navigationTitle("Share")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .onAppear { focused = made == nil && refused == nil }
        }
        // Held open from his press to the host's answer: the swipe, as Cancel and Done, waits for it.
        .interactiveDismissDisabled(!mayClose)
        // An address kept while the sheet is open (an answer after the fifteen seconds) shows at once, not on the
        // next open; and one that came while a press was out shows once that press has landed.
        .onChange(of: "\(waitingAddress?.attempt ?? "")|\(mayClose)") { takeUnseen() }
        .task(id: host.work.guestsRev) { await load() }
        .confirmationDialog("Revoke this link?", isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }), titleVisibility: .visible, presenting: revoking) { link in
            Button("Revoke", role: .destructive) { Task { await revoke(link) } }
        } message: { link in
            Text("\(link.name)’s address stops opening.")
        }
        .confirmationDialog("Replace the address?", isPresented: Binding(get: { replacing != nil }, set: { if !$0 { replacing = nil } }), titleVisibility: .visible, presenting: replacing) { link in
            Button("Replace", role: .destructive) { Task { await replace(link) } }
        } message: { link in
            Text("\(link.name)’s current address stops opening. The new one shows here for you to copy.")
        }
        .tcSheet(.form)
        .accessibilityIdentifier("share-sheet")
    }

    private var form: some View {
        Section {
            TextField("For", text: $draft.name)
                .textContentType(.name)
                .submitLabel(.done)
                .focused($focused)
                .accessibilityIdentifier("guest-name")
            if source.roles.count > 1 {
                Picker("Can", selection: $draft.role) {
                    ForEach(source.roles, id: \.self) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
            }
            Picker("Ends", selection: $days) {
                ForEach(ShareRules.ends, id: \.self) { days in
                    Text(ShareRules.expiresAt(days: days).formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())).tag(days)
                }
            }
        } footer: {
            if phase == .checking {
                Text(ShareRules.checkingWords)
            } else if case .refused(let words)? = phase {
                Text(words).foregroundStyle(Tint.destructiveText)
            } else if case .cut(let words)? = phase {
                Text(words)
            } else if let error {
                Text(error).foregroundStyle(Tint.destructiveText)
            } else if purdue {
                Text(ShareRules.purdueLine)
            }
        }
        // While a lost Create is read back, the form keeps what that press sent: a change now would be dropped.
        .disabled(phase == .checking)
        .onAppear { if !source.roles.contains(draft.role) { draft.role = source.roles[0] } }
    }

    /// The item's live links: nothing at all while there are none.
    @ViewBuilder private var linkRows: some View {
        if links == nil, listError == nil {
            Section { ProgressView().frame(maxWidth: .infinity) }
        } else if !live.isEmpty || listError != nil {
            Section {
                ForEach(live, id: \.id) { row($0) }
                if let listError {
                    HStack {
                        Text(listError).foregroundStyle(Tint.destructiveText)
                        Spacer()
                        Button("Try Again") { Task { await load() } }
                    }
                }
            } header: {
                Text("Links")
            } footer: {
                if let pressError { Text(pressError).foregroundStyle(Tint.destructiveText) }
            }
        }
    }

    private func row(_ link: GuestLinkRow) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(link.name).lineLimit(1)
                Text(ShareRules.facts(link, roles: source.roles.count))
                    .textStep(.meta)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                // His last Replace Address on this link, while it has words: Checking, then what came of it.
                if let replaced = host.work.rekeyLine(link.id) {
                    Text(replaced)
                        .textStep(.meta)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            if busy == link.id {
                ProgressView()
            } else if offersMore {
                // One press on the sheet at a time: a second link's More waits until the first's answer has landed.
                Menu {
                    if host.work.mayReplace(link.id) {
                        Button("Replace Address…", systemImage: "arrow.triangle.2.circlepath") { replacing = link }
                    }
                    if source.roles.count > 1, host.work.may(.guestsSetRole) {
                        Picker("Can", selection: Binding(get: { GuestLinkDraft.Role(rawValue: link.role.rawValue) ?? .view }, set: { role in Task { await setRole(link, role) } })) {
                            ForEach(source.roles, id: \.self) { Text("Can \($0.title.lowercased())").tag($0) }
                        }
                    }
                    if host.work.may(.guestsRevoke) {
                        Divider()
                        Button("Revoke…", systemImage: "xmark.circle", role: .destructive) { revoking = link }
                    }
                } label: {
                    Image(systemName: GlassMetrics.moreSymbol)
                        .frame(minWidth: Layout.rowHeight, minHeight: Layout.rowHeight)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("\(link.name)’s link")
                .disabled(!mayClose)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("share-link")
    }

    /// A link's More holds Replace Address…, the role and Revoke: drawn only when this key may do one of them.
    private var offersMore: Bool {
        host.work.may(.guestsRekey) || source.roles.count > 1 && host.work.may(.guestsSetRole) || host.work.may(.guestsRevoke)
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        if made != nil || late != nil || refused != nil || phase == .made || isCut {
            if refused == nil {
                ToolbarItem(placement: .cancellationAction) {
                    Button("New Link") {
                        made = nil
                        late = nil
                        attempts.newLink(host: host.environment.id, ref: source.ref)
                        focused = true
                    }
                    .disabled(!mayClose)
                }
            }
            ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.disabled(!mayClose) }
        } else {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(!mayClose) }
            ToolbarItem(placement: .confirmationAction) {
                if saving {
                    ProgressView()
                } else {
                    Button("Create") { Task { await create() } }
                        .disabled(!settled || !mayClose || phase == .checking || !draft.canCreate() || !host.work.may(.guestsCreate))
                        .accessibilityIdentifier("guest-create")
                }
            }
        }
    }

    // MARK: - the host

    private func load() async {
        do {
            links = try await host.work.links(for: source)
            listError = nil
            takeUnseen()
        } catch {
            let message = ActionError.wrap(error).message
            if let line = ShareRules.refusal(in: message) { refused = line; return }
            // Another host keeps this item's links: ask that one.
            if home == nil, let env = ShareRules.elsewhere(message), let other = model.registry.client(env) {
                home = other
                return await load()
            }
            if links == nil { listError = message }
        }
    }

    /// The first address waiting in memory for this item or one of its links.
    private var waitingAddress: GuestAttempts.Unseen? {
        attempts.next(host: host.environment.id, refs: [source.ref] + live.map { ShareRules.rekeyRef($0.id) })?.kept
    }

    /// An address waiting in memory for this item or one of its links (`GuestAttempts.unseen`) shows here, once.
    private func takeUnseen() {
        guard made == nil, late == nil, mayClose else { return }
        let id = host.environment.id
        guard let next = attempts.next(host: id, refs: [source.ref] + live.map { ShareRules.rekeyRef($0.id) }) else { return }
        late = next.kept
        attempts.shown(host: id, ref: next.ref, attempt: next.kept.attempt)
    }

    private func create() async {
        guard settled, mayClose else { return }
        saving = true
        defer { saving = false }
        error = nil
        // Frozen before the owner's check: the serving host, its key and what he typed. A redirect or another key
        // meanwhile sends nothing (`PressGates.allow`, and the compare below).
        let target = host
        let key = PressGates.key(target.environment, revoked: target.work.keyRevoked)
        var frozen = draft
        frozen.ends = ShareRules.expiresAt(days: days)
        let hostId = target.environment.id
        // A link lets someone outside in: the link and the owner's check first, the refusal in the sheet's own line.
        if let line = await PressGates.shared.pass(target, .guestsCreate, ref: source.ref, rev: "\(frozen.role.rawValue)-\(days)", reason: "Share \(title) with \(frozen.trimmedName)") {
            error = line
            return
        }
        guard host.environment.id == hostId, PressGates.shared.liveKey(hostId) == key else {
            error = ShareRules.movedWords
            return
        }
        let attempt = attempts.attempt(host: hostId, ref: source.ref, pending: target.work.presses.pending.presses)
        do {
            made = try await target.work.makeLink(frozen, source: source, title: title, attempt: attempt, key: key)
            attempts.shown(host: hostId, ref: source.ref)
            attempts.answered(host: hostId, ref: source.ref)
            draft.name = ""
            await load()
        } catch is PressLedger.Unknown {
            // The answer was lost: the key stays, the form waits, and the host is read back on the next link.
            attempts.lost(host: hostId, ref: source.ref)
        } catch {
            // One press on this item still out (a busy refusal): the same key stays, Checking.
            if target.work.presses.busy(host: hostId, ref: source.ref) {
                attempts.lost(host: hostId, ref: source.ref)
                return
            }
            let message = ActionError.wrap(error).message
            if let line = ShareRules.refusal(in: message) { refused = line } else { self.error = message }
            attempts.answered(host: hostId, ref: source.ref)
        }
    }

    private func setRole(_ link: GuestLinkRow, _ role: GuestLinkDraft.Role) async {
        guard role.rawValue != link.role.rawValue, mayClose else { return }
        // Held for the sheet from before the owner's check to the answer: no second press starts meanwhile.
        busy = link.id
        defer { busy = nil }
        // Widening what someone outside may do is his press, as making the link is; its key rides to the leave.
        let key = PressGates.key(host.environment, revoked: host.work.keyRevoked)
        if let line = await PressGates.shared.pass(host, .guestsSetRole, ref: "guest-link:\(link.id)", rev: role.rawValue, reason: "Let \(link.name) \(role.rawValue) \(title)") {
            pressError = line
            return
        }
        await act(link) { try await host.work.setRole(link, to: role, key: key) }
    }

    private func replace(_ link: GuestLinkRow) async {
        guard mayClose else { return }
        // Held for the sheet from before the owner's check to the answer: one replacement at a time, and its address
        // lands in this sheet, never under a second press's.
        busy = link.id
        defer { busy = nil }
        let key = PressGates.key(host.environment, revoked: host.work.keyRevoked)
        if let line = await PressGates.shared.pass(host, .guestsRekey, ref: "guest-link:\(link.id)", rev: "\(link.createdAt)", reason: "Make a new address for \(link.name)") {
            pressError = line
            return
        }
        switch await host.work.replaceAddress(link, key: key) {
        case .address(let url):
            pressError = nil
            made = .address(url, link: link)
            late = nil
            attempts.shown(host: host.environment.id, ref: ShareRules.rekeyRef(link.id))
            await load()
        // Checking and an earlier try's address are said in the link's own row (`rekeyLine`), and settle there.
        case .again, .checking: pressError = nil
        case .refused(let words): pressError = words
        }
    }

    private func revoke(_ link: GuestLinkRow) async {
        guard mayClose else { return }
        await act(link) { try await host.work.revoke(link) }
    }

    private func act(_ link: GuestLinkRow, _ run: () async throws -> Void) async {
        busy = link.id
        defer { busy = nil }
        do {
            try await run()
            pressError = nil
            await load()
        } catch {
            pressError = ActionError.wrap(error).message
        }
    }
}

/// The address once, with Copy and Share: the end of Make a Guest Link and of
/// Settings → Work's New Address. The host keeps only its hash.
struct GuestAddressSection: View {
    let address: String
    var footer = "This address shows once."

    var body: some View {
        Section {
            Text(address).font(.callout.monospaced()).textSelection(.enabled).accessibilityIdentifier("guest-url")
            Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = address }
            if let url = URL(string: address) { ShareLink("Share", item: url) }
        } footer: {
            Text(footer)
        }
    }
}

/// New Address on a live link (Settings → Work): the new address itself, once.
struct NewAddressSheet: View {
    @Environment(\.dismiss) private var dismiss
    let address: String
    /// Whose link it opens ("Dana Lee’s New Address") and to what (the footer), when kept with it.
    var name = ""
    var title = ""

    var body: some View {
        NavigationStack {
            Form {
                GuestAddressSection(address: address, footer: "\(title.isEmpty ? "" : "For \(title). ")This address shows once. The one before opens nothing now.")
            }
            .navigationTitle(name.isEmpty ? "New Address" : "\(name)’s New Address")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .tcSheet(.form)
        .accessibilityIdentifier("guest-new-address")
    }
}
