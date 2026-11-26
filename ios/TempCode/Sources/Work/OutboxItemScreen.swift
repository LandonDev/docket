import SwiftUI
import TempCodeClient
import TempCodeContract

/// One held item, exactly as it will go (phone-outbox.html, "The detail";
/// Outbox 2's phone.html): its workspace and time, what it does as the
/// title, one sentence of what the press does and to whom (`effect`), the
/// notes that apply (not sent, out of date, whose words it is now, who wrote
/// back), each field a person reads on its own line (label, value, the
/// address under a name), the body as plain text, and its own bottom bar:
/// Discard, Edit, Send with Send later on its menu; a timed send's Cancel
/// Send and Send Now; an out-of-date one's Discard and Ask the Thread Again.
/// Every Send returns to the list, where it waits five seconds with Undo
/// (OutboxPresses.swift).
/// The fourth named bottom bar, after the dock, the hunk bar and the
/// Preamble panel.
struct OutboxItemScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(ShellNavigator.self) private var navigator
    @Environment(\.dismiss) private var dismiss
    @Environment(\.shellPose) private var pose
    let environmentId: String
    let refKey: String
    /// Opened from the summary to read: no bar.
    var readOnly = false
    /// The item as read on this screen (`work.outbox.get`): until it comes, nothing on it can be pressed.
    @State private var fetched: OutboxItem?
    @State private var loadError: String?
    /// The whole read failed while the list's copy shows: what only it carries (a quote, a picture) did not come.
    @State private var wholeError: String?
    @State private var editing = false
    @State private var confirmDiscard: OutboxItem?
    @ScaledMetric(relativeTo: .footnote) private var noteMark: CGFloat = 16
    @State private var pickingTime = false
    /// Reschedule's Pick a Time… on a mail he timed in Mail.
    @State private var rescheduling = false
    @State private var busy = false
    /// Why his last press here did not start or did not go ("Not connected to Mac", "Nothing was sent."), in
    /// the state line's place until his next press.
    @State private var barLine: String?
    @ScaledMetric(relativeTo: .footnote) private var labelWidth: CGFloat = 64

    private var client: EnvironmentClient? { model.registry.client(environmentId) }

    /// The list's copy while it waits (the pushes keep it current), else the last one the host pushed of it once
    /// decided (what LifeOS says of a sent mail), else the one fetched.
    private var listed: OutboxItem? {
        client?.work.items.first { OutboxModel.key($0.ref) == refKey } ?? client?.work.heard[refKey]
    }

    /// The whole read while it is as new as the list's copy: it carries what the list leaves out
    /// (a LifeOS reply's quote, a computer act's picture); else the list's copy.
    private var whole: OutboxItem? {
        guard let fetched else { return nil }
        guard let listed else { return fetched }
        return fetched.updatedAt >= listed.updatedAt ? fetched : nil
    }

    /// Nothing of a refused key's is drawn, the whole read with its quote and body above all.
    private var revoked: Bool { client?.work.keyRevoked == true }

    private var item: OutboxItem? { revoked ? nil : whole ?? listed ?? fetched }

    var body: some View {
        if OutboxPick.isSummary(environmentId: environmentId, ref: refKey) {
            // The open Duo's detail while he selects: the one summary of his ticks.
            OutboxSummary(inSheet: false)
                .task { if !OutboxSelecting.shared.on { navigator.detailRoot = nil } }
        } else {
            itemBody
        }
    }

    /// The kept row this item was drawn from before its host answered: a read view, never a press.
    private var kept: WorkCache.WaitingRow? {
        client.flatMap { OutboxKeeping.rows($0).first { $0.ref == refKey } }
    }

    private var itemBody: some View {
        Group {
            if revoked {
                ContentUnavailableView("Not Available", systemImage: "key", description: Text(WorkHost.refusedLine(client?.environment.name ?? "The host")))
            } else if let item, let client {
                content(item, client: client)
            } else if let kept {
                KeptItemView(row: kept, error: loadError, retry: { await load() })
            } else if let loadError {
                // On a paired host the read can be tried again, as other Work item pages offer; with no host there is nothing to retry.
                ContentUnavailableView {
                    Label("Can’t Open This", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(loadError)
                } actions: {
                    if client != nil {
                        Button("Try Again") { self.loadError = nil; Task { await load() } }
                    }
                }
            } else {
                ProgressView()
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        // The host refused the key: the whole read goes from memory, not only from the list.
        .onChange(of: revoked) { if revoked { fetched = nil } }
        // His Send's countdown and Undo on this page when no list beside it can be seen (the Duo's sidebar hidden).
        .outboxUndoInset(undoPlace == .item && undoHere)
        // Read whole again when the list's copy moves on, so the quote and the picture match what goes.
        // Read whole again when the host pushes a newer copy, or a new word from LifeOS on a sent one.
        .task(id: "\(refKey)-\(listed?.updatedAt ?? 0)-\(listed?.lifeos?.rawValue ?? "")") { await load() }
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
        // Outbox 2's proof: Discard's question with its reason field, and Pick a Time….
        if TestHooks.sheet == "outbox-discard" { confirmDiscard = item }
        if TestHooks.sheet == "outbox-later" { pickingTime = true }
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
        guard !OutboxPick.isSummary(environmentId: environmentId, ref: refKey) else { return }
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
        let verbs = barKind(item)
        return ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 4) {
                    // Readable inks at the same steps (as the Outbox's bands): the hierarchical meta and stamp measured
                    // 3.44:1 and 1.73:1 on white in light; `label` is 21:1 in both themes. The sizes keep the order.
                    HStack(spacing: 6) {
                        SectorDot(sector: item.sector ?? place.sector, size: 7)
                        Text(place.name)
                            .textStep(.meta, tint: Color(.label))
                            .lineLimit(1)
                            .layoutPriority(1)
                        // Who made it: the thread, or a routine's run (the desktop's facts line, "from <thread>").
                        if let maker = maker(item, client: client) {
                            Text(maker)
                                .textStep(.meta, tint: Color(.label))
                                .lineLimit(1)
                        }
                        Text(HeldTime.of(item.createdAt))
                            .textStep(.stamp, tint: Color(.label))
                            .fixedSize()
                    }
                    // One name: the list row's act (`OutboxModel.title`); the state line under it says the past ("Posted 4:02 PM").
                    Text(OutboxModel.title(item))
                        .font(.title3.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                    // A mail LifeOS still queues says its age as of this draw ("Queued in LifeOS for 3m"), with no clock
                    // of its own (docs/IOS-DESIGN.md "Clocks"): the host pushes its next word (sent, back in drafts,
                    // gone), which draws the line again.
                    if let state = stateLine(item, client: client, now: .now) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            if let glyph = state.glyph {
                                Image(systemName: glyph).font(.caption).foregroundStyle(.secondary).frame(width: noteMark).accessibilityHidden(true)
                            }
                            Text(state.text)
                                .textStep(.meta, tint: state.failed ? Tint.destructiveText : Color(.label))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(.top, 2)
                        .accessibilityElement(children: .combine)
                    }
                    // What the press does and to whom, in the host's one sentence, above the thing itself; none under a
                    // timed send's time (`effectLine`).
                    if let effect = OutboxModel.effectLine(item) {
                        Text(effect)
                            .font(.subheadline)
                            .foregroundStyle(Color(.label))
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, 4)
                            .accessibilityIdentifier("outbox-effect")
                    }
                    let notes = OutboxModel.notes(item, held: { HeldTime.of($0) })
                    if !notes.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(notes) { note in NoteLine(note: note) }
                        }
                        .padding(.top, 8)
                    }
                }
                .padding(.horizontal, Layout.textEdge)
                .padding(.top, 8)
                .padding(.bottom, 12)

                ForEach(view.fields) { field in
                    // A held change's next change starts a group: 16pt of space in place of the hairline.
                    if field.gap { Color.clear.frame(height: 16) } else { Hairline() }
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Text(field.label)
                            .textStep(.meta, tint: Color(.label))
                            .frame(width: labelWidth, alignment: .leading)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(field.value)
                                .font(.body)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                            if let detail = field.detail {
                                Text(detail)
                                    .textStep(.meta, tint: Color(.label))
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
                    KeptPictureView(listed: item, whole: whole, failed: wholeError, retry: { await load() })
                        .padding(.horizontal, Layout.textEdge)
                        .padding(.vertical, 16)
                } else if let line = OutboxModel.wholeFailedLine(item.kind, whole: whole, error: wholeError) {
                    readFailed(line)
                        .padding(.horizontal, Layout.textEdge)
                        .padding(.vertical, 16)
                }
            }
        }
        .tcBottomBar {
            // A press whose answer is out or lost offers nothing more until it is read back ("Checking…"); each bar is
            // drawn only for a key the host would let press it (KeyMay), only once this screen has read the item on
            // this link, and not while its Send waits its five seconds (Undo is in the list's capsule).
            if !readOnly, fetched != nil, !client.work.presses.busy(host: environmentId, ref: refKey),
               !OutboxPresses.shared.hides(OutboxModel.Entry(environmentId: environmentId, item: item)) {
                switch verbs {
                case .press where client.work.may(.outboxSend):
                    bar(item, client: client, editable: OutboxModel.editable(item.kind) && (!view.fields.filter({ $0.edit != nil }).isEmpty || view.body?.readOnly == false),
                        ready: OutboxModel.detailReady(item.kind, whole: whole) && pictureDraws(whole))
                case .timed where client.work.may(.outboxSendNow) && client.work.may(.outboxCancelSend):
                    timedBar(item, client: client)
                case .mailTimed(let id) where client.work.may(.mailSendNow) && client.work.may(.mailCancel) && client.work.may(.mailReschedule):
                    mailTimedBar(item, id: id, client: client)
                case .stale where client.work.may(.outboxDiscard) && client.work.may(.outboxAskAgain):
                    staleBar(item, client: client)
                default:
                    EmptyView()
                }
            }
        }
        .sheet(isPresented: $editing) {
            OutboxEditSheet(item: item, client: client)
        }
        .sheet(isPresented: $pickingTime) {
            OutboxPickTimeSheet { at in later(item, at: at) }
        }
        .sheet(isPresented: $rescheduling) {
            if let id = MailRules.timedInMail(item) {
                OutboxPickTimeSheet { at in Task { await reschedule(id, at: at, client: client) } }
            }
        }
        .outboxDiscardPrompt($confirmDiscard) { item, reason in
            Task { await discard(item, reason: reason, client: client) }
        }
    }

    private enum BarKind {
        case press, timed, stale, none
        /// A mail he timed in Mail: LifeOS's time, moved, sent now or taken back through `work.mail.*`.
        case mailTimed(String)
    }

    /// Which verbs the item's bar offers: a plain press while it waits on one; Cancel Send and Send Now on a send he
    /// timed on the host; Cancel Send, Reschedule and Send Now on a mail he timed in Mail (`work.mail.*`); Discard and
    /// Ask the Thread Again once it went out of date; none on its way or decided.
    private func barKind(_ item: OutboxItem) -> BarKind {
        if item.state == .scheduled { return .timed }
        if let id = MailRules.timedInMail(item) { return .mailTimed(id) }
        if item.state == .stale { return OutboxModel.needsHim(item) ? .stale : .none }
        return OutboxModel.needsHim(item) ? .press : .none
    }

    /// Where it stands when no note says it. His own press's refusal comes first, then what a press came to
    /// ("Checking…", "Changed"; "May have gone" is the failure note's own words), then on its way, timed, what LifeOS
    /// says of a send it holds ("Queued in LifeOS for 3m"), sent, discarded, or an agent's rewrite waiting.
    private func stateLine(_ item: OutboxItem, client: EnvironmentClient, now: Date) -> (glyph: String?, text: String, failed: Bool)? {
        if let barLine { return (nil, barLine, true) }
        if let press = client.work.presses.state(host: environmentId, ref: refKey), press != .mayHaveGone, let line = press.line {
            return (nil, line, false)
        }
        // A timed send leads with its time, as a note with its glyph, before what the press does.
        if let scheduled = OutboxModel.scheduledLine(item) { return ("clock", scheduled, false) }
        switch item.state {
        case .sending: return (nil, "Sending…", false)
        case .sent:
            // The host's word on what LifeOS did with it leads; "Sent" only once LifeOS says it went, or for an act LifeOS never held.
            if let held = OutboxModel.lifeosLine(item, now: now) { return (nil, held, false) }
            return (nil, "\(OutboxModel.pastOf(item.verb, kind: item.kind)) \(item.decidedAt.map { HeldTime.of($0) } ?? "")", false)
        case .discarded: return (nil, "Discarded", false)
        default: return item.proposed == true ? (nil, "An agent’s rewrite waits in LifeOS.", false) : nil
        }
    }

    /// "from Nationals roster", or "from a routine" for a routine's run; nil where no thread made it.
    private func maker(_ item: OutboxItem, client: EnvironmentClient) -> String? {
        if item.routineRunId != nil { return "from a routine" }
        return item.sessionId.flatMap { client.session($0)?.title }.map { "from \($0)" }
    }

    /// A read that did not come back: its reason in red, in the failed-read row of every Work place.
    private func readFailed(_ words: String) -> some View {
        FailedRead(words: words, retry: { await load() }, identifier: "outbox-item-read-failed", insets: nil, tint: Tint.destructiveText)
    }

    /// Send waits until what it approves is on screen: a kept picture's bytes must draw.
    private func pictureDraws(_ whole: OutboxItem?) -> Bool {
        guard let whole, case .bytes(let data, _, _) = OutboxModel.keptPicture(whole.payload) else { return true }
        return UIImage(data: data) != nil
    }

    /// Send waits (`ready`) until the whole read and a computer act's picture have come; Discard and Edit do not.
    private func bar(_ item: OutboxItem, client: EnvironmentClient, editable: Bool, ready: Bool) -> some View {
        HStack(spacing: 8) {
            Button("Discard", role: .destructive) { confirmDiscard = item }
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

    /// A timed send: Cancel Send puts it back as held; Send Now waits its five seconds, then goes on its own claim.
    private func timedBar(_ item: OutboxItem, client: EnvironmentClient) -> some View {
        HStack(spacing: 8) {
            Button("Cancel Send") { Task { await cancelSend(item, client: client) } }
                .font(.body)
                .frame(minHeight: 44)
                .buttonStyle(.pressable)
                .accessibilityIdentifier("outbox-cancel-send")
            Spacer(minLength: 0)
            Button("\(item.verb) Now") { Task { await press(item, act: .sendNow) } }
            .font(.body.weight(.semibold))
            .padding(.horizontal, 10)
            .frame(minHeight: Layout.rowHeight)
            .buttonBorderShape(.capsule)
            .tcGlassButton(prominent: true)
            .accessibilityIdentifier("outbox-send-now")
        }
        .disabled(busy)
        .padding(.horizontal, Layout.textEdge)
        .padding(.vertical, 8)
    }

    /// A mail he timed in Mail: Cancel Send takes it back to a draft and Reschedule moves its time, neither going to
    /// anyone; Send Now is outward, so it passes the owner's check and waits its five seconds with Undo in the list.
    private func mailTimedBar(_ item: OutboxItem, id: String, client: EnvironmentClient) -> some View {
        HStack(spacing: 8) {
            Button("Cancel Send") { Task { await cancelMail(id, client: client) } }
                .font(.body)
                .frame(minHeight: Layout.hitTarget)
                .buttonStyle(.pressable)
                .accessibilityIdentifier("outbox-mail-cancel")
            Spacer(minLength: 0)
            Menu("Reschedule") {
                ForEach(MailRules.rescheduleChoices(item), id: \.label) { choice in
                    Button(choice.label) { Task { await reschedule(id, at: choice.at, client: client) } }
                }
                Button("Pick a Time…") { rescheduling = true }
            }
            .font(.body.weight(.medium))
            .padding(.horizontal, 6)
            .frame(minHeight: Layout.rowHeight)
            .buttonBorderShape(.capsule)
            .tcGlassButton()
            .accessibilityIdentifier("outbox-mail-reschedule")
            Button("\(item.verb) Now") { Task { await press(item, act: .mailNow(id: id)) } }
                .font(.body.weight(.semibold))
                .padding(.horizontal, 10)
                .frame(minHeight: Layout.rowHeight)
                .buttonBorderShape(.capsule)
                .tcGlassButton(prominent: true)
                .accessibilityIdentifier("outbox-mail-send-now")
        }
        .disabled(busy)
        .padding(.horizontal, Layout.textEdge)
        .padding(.vertical, 8)
    }

    /// Takes a mail he timed back to a draft in LifeOS; it leaves the Outbox. LifeOS says when it is already on its way.
    private func cancelMail(_ id: String, client: EnvironmentClient) async {
        busy = true
        defer { busy = false }
        barLine = nil
        do {
            if try await client.work.cancelMail(id) {
                await client.work.refreshOutbox()
                close()
            } else {
                barLine = "Not cancelled: it is already on its way"
            }
        } catch {
            barLine = OutboxPresses.line(error, prefix: "Not cancelled")
        }
    }

    /// Moves a mail he timed to another time in his zone; the state line says the new time once the list has it.
    private func reschedule(_ id: String, at: Int, client: EnvironmentClient) async {
        busy = true
        defer { busy = false }
        barLine = nil
        do {
            try await client.work.rescheduleMail(id, at: at)
            await client.work.refreshOutbox()
            await load()
        } catch {
            barLine = OutboxPresses.line(error, prefix: "Not moved")
        }
    }

    /// An out-of-date item: Discard (with its reason), or Ask the Thread Again, which puts it away and asks its
    /// thread to draft it again from what is true now.
    private func staleBar(_ item: OutboxItem, client: EnvironmentClient) -> some View {
        HStack(spacing: 8) {
            Button("Discard", role: .destructive) { confirmDiscard = item }
                .font(.body)
                .foregroundStyle(Tint.destructive)
                .frame(minHeight: 44)
                .buttonStyle(.pressable)
                .accessibilityIdentifier("outbox-discard")
            Spacer(minLength: 0)
            Button("Ask the Thread Again") { Task { await askAgain(item, client: client) } }
                .font(.body.weight(.semibold))
                .padding(.horizontal, 10)
                .frame(minHeight: Layout.rowHeight)
                .buttonBorderShape(.capsule)
                .tcGlassButton(prominent: true)
                .accessibilityIdentifier("outbox-ask-again")
        }
        .disabled(busy)
        .padding(.horizontal, Layout.textEdge)
        .padding(.vertical, 8)
    }

    /// Send, the item's own verb. A press and hold opens the split Send's menu: Send Later (In an Hour, This
    /// Afternoon, Tomorrow Morning, Pick a Time…) for a kind that may be sent later, above "Send and stop holding" ›
    /// the grant's name for a key that may make one (the desktop's menu, in its order).
    @ViewBuilder
    private func sendButton(_ item: OutboxItem, client: EnvironmentClient) -> some View {
        let title = OutboxModel.pressWord(item, fallback: item.verb)
        let grant = client.work.may(.outboxGrant) && item.state == .held ? OutboxModel.grantFor(item.kind, payload: item.payload) : nil
        let later = item.later == true && item.state == .held && client.work.may(.outboxDecide)
        if grant != nil || later {
            Menu {
                if later {
                    Section("Send Later") {
                        ForEach(OutboxModel.laterChoices(), id: \.label) { choice in
                            Button(choice.label) { self.later(item, at: choice.at) }
                        }
                        Button("Pick a Time…") { pickingTime = true }
                    }
                }
                if let grant {
                    Section("Send and stop holding") {
                        Button(grant.label, systemImage: "checkmark.seal") { Task { await sendAndGrant(item, grant: grant, client: client) } }
                    }
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
            .accessibilityHint(later ? "Touch and hold to send later" : "Touch and hold to send and stop holding acts like this one")
            // Command-Return is the plain Send on both branches: a menu that also offers Send Later keeps it.
            .background {
                Button(title) { send(item) }
                    .keyboardShortcut(.return, modifiers: .command)
                    .opacity(0)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        } else {
            Button(title) { send(item) }
                .keyboardShortcut(.return, modifiers: .command)
                .font(.body.weight(.semibold))
                .padding(.horizontal, 10)
                .frame(minHeight: Layout.rowHeight)
                .buttonBorderShape(.capsule)
                .tcGlassButton(prominent: true)
                .accessibilityIdentifier("outbox-send")
        }
    }

    /// This item's Send with the grant riding it: both wait the five seconds, and the grant is made only
    /// when they end, just before the send (`HeldPress`). Undo takes back both; Settings → Work lists the grant.
    private func sendAndGrant(_ item: OutboxItem, grant: (matcher: JSONValue, label: String), client: EnvironmentClient) async {
        await press(item, grant: HeldPress.Grant(matcher: grant.matcher, label: grant.label))
    }

    /// Back to the list, where the press waits its five seconds with Undo.
    private func send(_ item: OutboxItem) {
        Task { await press(item) }
    }

    /// The link and the owner's check first; a press that did not start stays here and says why.
    private func press(_ item: OutboxItem, act: HeldPress.Act = .send, grant: HeldPress.Grant? = nil) async {
        busy = true
        defer { busy = false }
        barLine = nil
        if let line = await OutboxPresses.shared.send(OutboxModel.Entry(environmentId: environmentId, item: item), act: act, grant: grant, quiet: true) {
            barLine = line
        } else {
            close()
        }
    }

    /// Off screen: popped in a stack. In the split beside the Outbox's own list it stays: when the item leaves the
    /// list (sent once its wait ends, discarded, scheduled) the list gives the detail the next row it waits on
    /// (`OutboxModel.pickOrder`). Opened from anywhere else (Today's row, its pick on the open Duo, a notice) the
    /// countdown and its Undo would be out of sight: the Outbox's list comes up with them, over where he was, so
    /// Back returns there.
    private func close() {
        let root = navigator.detailRoot == .outboxItem(environmentId: environmentId, ref: refKey)
        // The Duo's sidebar hidden: a list there is out of sight, so the item stays and wears the capsule itself.
        if root, undoPlace == .item { return }
        let overOutbox = if case .place(.outbox, _)? = navigator.sidebarPath.last?.current { true } else { false }
        if overOutbox {
            if pose.isSplit, root { return }
            return dismiss()
        }
        if root { navigator.detailRoot = nil } else { dismiss() }
        // Counting, waiting its turn or on its way: the list that shows it comes up.
        guard let item, OutboxPresses.shared.hides(OutboxModel.Entry(environmentId: environmentId, item: item)) else { return }
        navigator.sidebarPath.append(.place(.outbox))
    }

    /// Where this page's Send shows its countdown (`SendUndoPlace`).
    private var undoPlace: SendUndoPlace {
        let outboxBeside = if case .place(.outbox, _)? = navigator.sidebarPath.last?.current { true } else { false }
        return SendUndoPlace.of(split: pose.isSplit, sidebarVisible: navigator.sidebarVisible, outboxBeside: outboxBeside)
    }

    /// A press of this page is out, or the capsule has a line for it to say.
    private var undoHere: Bool {
        let presses = OutboxPresses.shared
        guard let item else { return presses.noticeLine != nil }
        return presses.hides(OutboxModel.Entry(environmentId: environmentId, item: item)) || presses.noticeLine != nil
    }

    /// Send later: back to the list, where it waits its five seconds with Undo, its line naming when it goes.
    private func later(_ item: OutboxItem, at: Int) {
        Task { await press(item, act: .later(at: at)) }
    }

    private func discard(_ item: OutboxItem, reason: String?, client: EnvironmentClient) async {
        busy = true
        defer { busy = false }
        barLine = nil
        if let line = await OutboxPresses.shared.discard(OutboxModel.Entry(environmentId: environmentId, item: item), reason: reason) {
            barLine = line
        } else if !client.work.presses.busy(host: environmentId, ref: refKey) {
            close()
        }
    }

    /// Cancel Send passes the link and the owner's check as Discard does; what did not go is said in the state line.
    private func cancelSend(_ item: OutboxItem, client: EnvironmentClient) async {
        busy = true
        defer { busy = false }
        barLine = nil
        if let line = await PressGates.shared.pass(client, .outboxCancelSend, ref: refKey, rev: String(item.updatedAt), reason: "Cancel sending \(item.summary)") {
            barLine = line
            return
        }
        do {
            try await client.work.cancelSend(item)
        } catch {
            barLine = OutboxPresses.line(error, prefix: "Not cancelled")
        }
    }

    private func askAgain(_ item: OutboxItem, client: EnvironmentClient) async {
        busy = true
        defer { busy = false }
        do {
            try await client.work.askAgain(item)
            close()
        } catch {
            FleetToastCenter.shared.post(message: "Not asked: \(ActionError.wrap(error).message)")
        }
    }
}

/// One note under the effect: its glyph in a fixed column, then the words. Only a send that did not go wears the
/// destructive mark; out of date, changed and replied are plain words (held is not Needs you).
private struct NoteLine: View {
    let note: OutboxModel.Note
    @ScaledMetric(relativeTo: .footnote) private var mark: CGFloat = 16

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Group {
                if note.kind == .failed {
                    Circle().fill(Tint.destructive).frame(width: Layout.dotSize, height: Layout.dotSize)
                } else {
                    Image(systemName: glyph).font(.caption).foregroundStyle(.secondary)
                }
            }
            .frame(width: mark)
            .accessibilityHidden(true)
            Text(note.text)
                .textStep(.meta, tint: note.kind == .failed ? Tint.destructiveText : Color(.label))
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("outbox-note-\(note.kind.rawValue)")
    }

    private var glyph: String {
        switch note.kind {
        case .failed: "exclamationmark.circle"
        case .stale: "clock.arrow.circlepath"
        case .changed: "pencil"
        case .replied: "arrowshape.turn.up.left"
        }
    }
}

/// Pick a Time…: a day and a time in his own zone, no earlier than five minutes from now, and Send Later. It fills
/// the height, so the whole month and the time show at once.
struct OutboxPickTimeSheet: View {
    @Environment(\.dismiss) private var dismiss
    let pick: (Int) -> Void
    /// Opens on the next whole hour at least an hour away, never on this minute: a Send Later pressed at once still
    /// sends later.
    @State private var at: Date = {
        let soon = Date.now.addingTimeInterval(3_600)
        return Calendar.current.nextDate(after: soon, matching: DateComponents(minute: 0), matchingPolicy: .nextTime) ?? soon
    }()

    var body: some View {
        NavigationStack {
            Form {
                DatePicker("Goes", selection: $at, in: Date.now.addingTimeInterval(300)..., displayedComponents: [.date, .hourAndMinute])
                    .datePickerStyle(.graphical)
            }
            .navigationTitle("Pick a Time")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send Later") {
                        dismiss()
                        pick(Int((at.timeIntervalSince1970 * 1000).rounded()))
                    }
                    .accessibilityIdentifier("outbox-later-pick")
                }
            }
        }
        .tcSheet(.editor)
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
        // Save changes what goes: the link and the owner's check first, as for Send; its key rides to the leave.
        let key = PressGates.key(client.environment, revoked: client.work.keyRevoked)
        if let line = await PressGates.shared.pass(client, .outboxEdit, ref: OutboxModel.key(item.ref), rev: String(item.updatedAt), reason: "Save your edit to \(item.summary)") {
            error = line
            return
        }
        do {
            try await client.work.edit(item, payload: next.payload, key: key)
            dismiss()
        } catch {
            // A lost answer: the item says Checking… and is read back on the next link.
            if error is PressLedger.Unknown { return dismiss() }
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
    let retry: () async -> Void
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
        FailedRead(words: "The picture did not load", retry: retry, identifier: "outbox-picture-failed", insets: nil, tint: Tint.destructiveText)
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

/// A row kept from the host's last list, opened before the host answered on this link: what it does, what it is
/// about, its place and when it was held, and nothing to press. The item itself replaces it once read.
private struct KeptItemView: View {
    let row: WorkCache.WaitingRow
    let error: String?
    let retry: () async -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    if let place = row.place {
                        Text(place).textStep(.meta, tint: Color(.label)).lineLimit(1).layoutPriority(1)
                    }
                    Text(HeldTime.of(row.at)).textStep(.stamp, tint: Color(.label)).fixedSize()
                }
                Text(row.act)
                    .font(.title3.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                if let about = row.about {
                    Text(about)
                        .font(.subheadline)
                        .foregroundStyle(Color(.label))
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 4)
                }
                if let error {
                    FailedRead(words: error, retry: retry, identifier: "outbox-item-kept-failed", insets: nil, tint: Tint.destructiveText)
                } else {
                    ProgressView()
                        .padding(.top, 16)
                        .accessibilityLabel("Reading it from the host")
                }
            }
            .padding(.horizontal, Layout.textEdge)
            .padding(.top, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityIdentifier("outbox-item-kept")
    }
}
