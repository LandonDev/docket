import SwiftUI
import TempCodeClient
import TempCodeContract

/// Opens a thread's request as its sheet from anywhere: the Outbox's Asked row, its notice, the thread's card.
@MainActor @Observable
final class OutboxRequestCenter {
    static let shared = OutboxRequestCenter()

    struct Target: Identifiable, Hashable {
        let environmentId: String
        let requestId: String
        var id: String { "\(environmentId):\(requestId)" }
    }

    var target: Target?

    private init() {}

    func open(environmentId: String, id: String) {
        target = Target(environmentId: environmentId, requestId: id)
    }
}

/// The request sheet over every tab (RootView), on the host the request waits on.
struct OutboxRequestSheetHost: ViewModifier {
    @Environment(AppModel.self) private var model
    @Bindable var center = OutboxRequestCenter.shared

    func body(content: Content) -> some View {
        content
            .sheet(item: $center.target) { target in
                if let client = model.registry.client(target.environmentId) {
                    OutboxRequestSheet(client: client, requestId: target.requestId)
                } else {
                    Color.clear.onAppear { center.target = nil }
                }
            }
    }
}

/// The phone's one wait for a request's Send, kept outside any sheet, on the Outbox's rules: a sheet closed never
/// sends a press early; the app going to the background, or the link to its host dropping, cancels it and says so;
/// when its five seconds end the link and the key he pressed under are checked again (`check`).
@MainActor
enum RequestPresses {
    static let wait = RequestPressWait(seconds: OutboxPresses.Wait.seconds)

    @MainActor private static var clients: (String) -> EnvironmentClient? = { _ in nil }

    /// The root's registry, and the read-backs of a press whose answer was lost.
    static func attach(_ clients: @escaping (String) -> EnvironmentClient?) {
        self.clients = clients
        WorkHost.requestHeard = { _, id, state, request in
            if let request { wait.heard(request) } else { wait.heard(requestId: id, state: state) }
        }
    }

    /// When the seconds end: why the press may not go now, or nil.
    static func check(_ press: RequestPress) -> SendWait<RequestPress>.Why? {
        guard let client = clients(press.environmentId) else { return .notPaired }
        let live = SendWait<RequestPress>.Check(
            linked: OutboxPresses.linked(client),
            maySend: client.work.may(.outboxDecide),
            rev: 0,
            key: PressGates.shared.liveKey(press.environmentId)
        )
        return SendWait<RequestPress>.why(live, rev: 0, key: press.key)
    }

    /// Hears the link and key of each host a press waits on; a lost one cancels that host's presses.
    static func watch() {
        let hosts = wait.waitingHosts
        guard !hosts.isEmpty else { return }
        withObservationTracking {
            for host in hosts {
                if let client = clients(host) { _ = (OutboxPresses.linked(client), client.work.may(.outboxDecide), client.work.keyRevoked) }
            }
        } onChange: {
            Task { @MainActor in
                for host in hosts {
                    guard let client = clients(host), OutboxPresses.linked(client) else {
                        wait.linkLost(host: host)
                        continue
                    }
                    if !client.work.may(.outboxDecide) { wait.keyLost(host: host) }
                }
                watch()
            }
        }
    }
}

/// A thread's request for his press (Outbox 2's phone.html, "The request"): what goes in one sentence, his own
/// words the thread quoted, a row per item with its tick, and Not Now and Send N at the foot. A tick is the
/// receipt the host issued for the row as drawn (`RequestSheetModel`): a reload that moves a row's receipt or marks
/// it changed clears its tick, and a row that changed since the thread asked starts unticked; opening it asks the
/// host for a fresh receipt (`request.view`), which starts unticked too until he ticks it. Send freezes exactly the
/// ticked receipts and waits the phone's five seconds with Undo (`RequestPresses`), each ticked row saying what it
/// does, to whom and when; then each row's result lands in place. Held is not Needs you: nothing here wears the
/// warning colour.
struct OutboxRequestSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let client: EnvironmentClient
    let requestId: String

    private enum Phase: Equatable { case choosing, waiting(RequestPress), sending, done }

    @State private var request: OutboxRequest?
    @State private var loadError: String?
    /// His ticks, as receipt ids. Only those still drawn count (`reconcile`).
    @State private var ticks: Set<String> = []
    /// Rows he opened since the sheet loaded, with the fresh receipt the host gave each.
    @State private var fresh: [String: OutboxRequestRow] = [:]
    @State private var pressError: String?
    /// The owner's check is asking for his Send: no second one meanwhile.
    @State private var checking = false

    private var wait: RequestPressWait { RequestPresses.wait }
    /// The host refused this key: nothing of the request, its quote or a receipt, is drawn.
    private var revoked: Bool { client.work.keyRevoked }

    var body: some View {
        NavigationStack {
            Group {
                if revoked {
                    ContentUnavailableView("Not Available", systemImage: "key", description: Text(WorkHost.refusedLine(client.environment.name)))
                } else if let request {
                    content(drawn(request))
                } else if let loadError {
                    ContentUnavailableView {
                        Label("Can’t Open This", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(loadError)
                    } actions: {
                        Button("Try Again") { self.loadError = nil; Task { await load() } }
                    }
                } else {
                    ProgressView()
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                        .accessibilityIdentifier("outbox-request-close")
                }
            }
            .navigationBarTitleDisplayMode(.inline)
        }
        .tcSheet(.editor)
        .task { await load() }
        #if DEBUG
        // Outbox 2's proof: his Send on the sheet as drawn (the ticked rows), two seconds after it loads.
        .task {
            guard TestHooks.action == "request-send" else { return }
            for _ in 0..<100 where request == nil { try? await Task.sleep(for: .milliseconds(100)) }
            TestHooks.recordRequestLoaded(ticked: ticks.count)
            try? await Task.sleep(for: .seconds(2))
            press()
        }
        #endif
        // His press's answer, whenever it lands: in this sheet, or in one opened after the first was closed.
        .onChange(of: wait.outcomes[requestId], initial: true) { _, outcome in take(outcome) }
        // A refused key: the request read under it, and every receipt opened from it, go from memory.
        .onChange(of: revoked) {
            guard revoked else { return }
            request = nil
            fresh = [:]
            ticks = []
        }
        // Each push of a request (its end, another device's press): the sheet reads it again, so it follows a press it
        // did not make.
        .onChange(of: client.work.outboxRequestsRev) { Task { await load() } }
        // A press the record kept from before a relaunch, settled on a link or a push: the request as it ended.
        .onChange(of: client.work.presses.busy(host: client.environment.id, ref: PendingPress.requestRef(requestId))) { _, busy in
            if !busy { Task { await load() } }
        }
        .accessibilityIdentifier("outbox-request")
    }

    private func load() async {
        do {
            let answer = try await client.work.request(requestId)
            if request == nil { ticks = RequestSheetModel.initialTicks(answer) }
            request = answer
        } catch {
            loadError = ActionError.wrap(error).message
        }
    }

    private func take(_ outcome: RequestPressWait.Outcome?) {
        switch outcome {
        case .answered(let after)?:
            request = after
            fresh = [:]
            pressError = nil
        case .failed(let line)?:
            pressError = line
            Task { await load() }
        case .checking?:
            // Gone with no answer: never "Not sent"; the head says Checking… until the request is read back.
            pressError = nil
            return
        case nil:
            return
        }
        wait.clear(requestId)
    }

    /// The request as drawn: every row he opened at its fresh receipt while the item stays as he saw it.
    private func drawn(_ request: OutboxRequest) -> OutboxRequest {
        request.state == .open ? RequestSheetModel.merged(request, opened: fresh) : request
    }

    /// A press of his on this request went and its end is not known: this launch's, or one the press record kept
    /// from before a relaunch.
    private var checkingPress: Bool {
        // Claimed and still going, by this phone or another device: not done until its end comes.
        request?.running == true
            || wait.outcomes[requestId] == .checking
            || !wait.sending.contains(requestId) && client.work.presses.busy(host: client.environment.id, ref: PendingPress.requestRef(requestId))
    }

    private var phase: Phase {
        if let press = wait.pending[requestId] { return .waiting(press) }
        if wait.sending.contains(requestId) || checkingPress { return .sending }
        return request?.state == .open || request == nil ? .choosing : .done
    }

    private func content(_ request: OutboxRequest) -> some View {
        let thread = client.session(request.sessionId)?.title
        let held = RequestSheetModel.reconcile(ticks, with: request)
        return List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(RequestSheetModel.head(request, ticked: held))
                        .font(.title3.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                        .contentTransition(.opacity)
                        .accessibilityIdentifier("outbox-request-head")
                    Text(thread.map { "You asked in \($0): “\(request.quote)”" } ?? "You asked: “\(request.quote)”")
                        .textStep(.meta, tint: Color(.label))
                        .fixedSize(horizontal: false, vertical: true)
                    if let closed = RequestSheetModel.closedLine(request, time: { HeldTime.of($0) }) {
                        Text(closed)
                            .textStep(.meta, tint: Color(.label))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if checkingPress {
                        // Not a failure: the label's ink, until the request is read back.
                        Text(PressState.checking.line ?? "Checking…")
                            .textStep(.meta, tint: Color(.label))
                    } else if let pressError {
                        Text(pressError)
                            .textStep(.meta, tint: Tint.destructiveText)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if !client.work.may(.outboxDecide) {
                        Text(ActionBlock.noApprove.text(now: 0))
                            .textStep(.meta, tint: Color(.label))
                    }
                }
                .padding(.vertical, 4)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 8, leading: Layout.textEdge, bottom: 12, trailing: Layout.textEdge))
            }
            Section {
                ForEach(request.rows, id: \.ref) { row in
                    let (ticked, rowPhase) = look(row, held: held)
                    RequestRowView(row: row, request: request, client: client, ticked: ticked, phase: rowPhase, closed: request.state != .open, toggle: { toggle(row) }, opened: { fresh[OutboxModel.key($0.ref)] = $0 })
                }
            }
        }
        .listStyle(.plain)
        .animation(reduceMotion ? nil : Motion.base, value: phase)
        .safeAreaInset(edge: .bottom, spacing: 0) { foot(request, held: held) }
    }

    /// A row's tick and phase: his ticks while he chooses; once he pressed, exactly the receipts the press froze.
    private func look(_ row: OutboxRequestRow, held: Set<String>) -> (Bool, RequestRowView.Phase) {
        switch phase {
        case .choosing: return (RequestSheetModel.ticked(row, held), .choosing)
        case .waiting(let press):
            let inPress = row.receipt.map(press.receipts.contains) == true
            return (inPress, inPress ? .waiting : .left)
        case .sending: return (RequestSheetModel.ticked(row, held), RequestSheetModel.ticked(row, held) ? .sending : .left)
        case .done: return (false, row.result == nil ? .left : .done)
        }
    }

    private func toggle(_ row: OutboxRequestRow) {
        guard phase == .choosing, RequestSheetModel.pressable(row), let receipt = row.receipt else { return }
        if ticks.contains(receipt) { ticks.remove(receipt) } else { ticks.insert(receipt) }
    }

    // MARK: - the foot

    @ViewBuilder
    private func foot(_ request: OutboxRequest, held: Set<String>) -> some View {
        switch phase {
        case .waiting(let press):
            UndoCapsule(line: press.waitingLine, identifier: "outbox-request-undo") { wait.undo(requestId) }
                .transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: 12)))
        case .done:
            wide("Done", prominent: true, identifier: "outbox-request-done") { dismiss() }
                .padding(.horizontal, Layout.textEdge)
                .padding(.vertical, 8)
        case .choosing, .sending:
            HStack(spacing: 10) {
                wide("Not Now", prominent: false, identifier: "outbox-request-decline") { Task { await decline() } }
                wide(RequestSheetModel.pressWord(request, ticked: held), prominent: true, identifier: "outbox-request-send", busy: phase == .sending) { press() }
                    .disabled(held.isEmpty)
            }
            .disabled(phase == .sending || checking || !client.work.may(.outboxDecide))
            .padding(.horizontal, Layout.textEdge)
            .padding(.vertical, 8)
        }
    }

    private func wide(_ title: String, prominent: Bool, identifier: String, busy: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            ZStack {
                Text(title).opacity(busy ? 0 : 1)
                if busy { ProgressView() }
            }
            .font(.body.weight(prominent ? .semibold : .medium))
            .frame(maxWidth: .infinity, minHeight: Layout.rowHeight)
        }
        .buttonBorderShape(.capsule)
        .tcGlassButton(prominent: prominent)
        // The spinner has no words: the button keeps its name and says what it is doing.
        .accessibilityLabel(title)
        .accessibilityValue(busy ? (checkingPress ? "Checking" : "Sending") : "")
        .accessibilityIdentifier(identifier)
    }

    // MARK: - the press

    /// His Send: exactly the ticked receipts as drawn, frozen now; the link and the owner's check (`PressGates`), then
    /// nothing reaches the host for five seconds, so Undo is a true undo, and nothing sends it sooner.
    private func press() {
        // One still out (this launch's, or one the record kept): no second press until it is read back.
        guard !client.work.presses.busy(host: client.environment.id, ref: PendingPress.requestRef(requestId)) else { return }
        guard phase == .choosing, !checking, let request, var press = RequestSheetModel.freeze(drawn(request), ticks: ticks, environmentId: client.environment.id) else { return }
        // Frozen before the owner's check: the host and the key he presses under.
        press.hostName = client.environment.name
        press.key = PressGates.key(client.environment, revoked: client.work.keyRevoked)
        pressError = nil
        checking = true
        let work = client.work
        Task {
            defer { checking = false }
            if let line = await PressGates.shared.pass(client, .outboxDecide, ref: PendingPress.requestRef(press.requestId), rev: press.rev, reason: press.head.isEmpty ? press.word : press.head) {
                pressError = line
                return
            }
            guard phase == .choosing else { return }
            wait.start(press, check: RequestPresses.check) { press in try await work.answer(press.requestId, receipts: press.receipts, key: press.key) }
            RequestPresses.watch()
            AccessibilityNotification.Announcement("\(press.waitingLine). Undo for five seconds.").post()
        }
    }

    private func decline() async {
        do {
            _ = try await client.work.decline(requestId)
            dismiss()
        } catch {
            pressError = "Not declined: \(ActionError.wrap(error).message)"
        }
    }
}

/// One row of the request: its tick, what it does and to whom, and a chevron that opens the item as it will go.
private struct RequestRowView: View {
    enum Phase { case choosing, waiting, sending, done, left }

    let row: OutboxRequestRow
    let request: OutboxRequest
    let client: EnvironmentClient
    let ticked: Bool
    let phase: Phase
    /// The request is over: a row his press did not take reads "Left out".
    var closed = false
    let toggle: () -> Void
    let opened: (OutboxRequestRow) -> Void
    @ScaledMetric(relativeTo: .body) private var tickSize: CGFloat = 22
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        // At accessibility sizes the receipt and its result read whole (who it goes to, why it did not), as Today's rows.
        let large = typeSize.isAccessibilitySize
        let words = RequestSheetModel.rowWords(row, closed: closed)
        let result = RequestSheetModel.resultWords(row)
        HStack(alignment: .center, spacing: Layout.rowGap) {
            Button(action: toggle) { mark(result) }
                .buttonStyle(.plain)
                .frame(width: Layout.rowHeight, height: Layout.rowHeight)
                .contentShape(Rectangle())
                .disabled(phase != .choosing || !RequestSheetModel.pressable(row))
                .accessibilityLabel(ticked ? "Included" : "Left out")
                .accessibilityHint(RequestSheetModel.pressable(row) ? "Double tap to change" : "Open it first")
                .accessibilityIdentifier("outbox-request-tick")
            NavigationLink {
                RequestRowDetail(row: row, request: request, client: client, opened: opened)
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(words.title)
                        .textStep(.title)
                        .lineLimit(large ? 3 : 1)
                    if let text = result == nil ? words.line : RequestSheetModel.settledLine(row) {
                        Text(text)
                            .textStep(.meta, tint: Self.failed(result) ? Tint.destructiveText : nil)
                            .lineLimit(large ? 5 : 2)
                            .contentTransition(.opacity)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: Layout.rowHeight, alignment: .leading)
            }
            .disabled(row.item == nil)
        }
        // While a press waits, the rows it does not take step back; once it is over every row reads at full ink.
        .opacity(phase == .left && !closed ? 0.45 : 1)
        .padding(.vertical, 2)
        .listRowInsets(EdgeInsets(top: 0, leading: Layout.textEdge - (Layout.rowHeight - tickSize) / 2, bottom: 0, trailing: Layout.textEdge))
        .accessibilityElement(children: .contain)
    }

    /// Not sent, in the failure's ink and dot; "May have gone" is not a failure and reads in the meta ink.
    private static func failed(_ result: (ok: Bool, text: String)?) -> Bool {
        result?.ok == false && result?.text != RequestSheetModel.mayHaveGone
    }

    @ViewBuilder
    private func mark(_ result: (ok: Bool, text: String)?) -> some View {
        Group {
            switch phase {
            case .sending:
                ProgressView().controlSize(.small)
            case .done:
                if Self.failed(result) {
                    Circle().fill(Tint.destructive).frame(width: Layout.dotSize, height: Layout.dotSize)
                } else if result?.ok == false {
                    Image(systemName: "questionmark.circle").font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                } else {
                    Image(systemName: "checkmark").font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                }
            default:
                Image(systemName: ticked ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: tickSize))
                    .foregroundStyle(ticked ? AnyShapeStyle(.tint) : AnyShapeStyle(.tertiary))
                    .contentTransition(.symbolEffect(.replace))
            }
        }
        .frame(width: tickSize, height: tickSize)
    }
}

/// A request's row opened: the item as it will go, its effect and notes. A row that changed since the thread asked
/// gets a fresh receipt here (`request.view`), at exactly what this screen shows; back in the list he ticks it.
private struct RequestRowDetail: View {
    let row: OutboxRequestRow
    let request: OutboxRequest
    let client: EnvironmentClient
    let opened: (OutboxRequestRow) -> Void
    @State private var shown: OutboxRequestRow?
    @State private var viewError: String?
    @ScaledMetric(relativeTo: .footnote) private var labelWidth: CGFloat = 64

    var body: some View {
        let current = shown ?? row
        ScrollView {
            if let item = current.item {
                let view = OutboxModel.actView(item)
                VStack(alignment: .leading, spacing: 0) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(OutboxModel.title(item))
                            .font(.title3.weight(.semibold))
                            .fixedSize(horizontal: false, vertical: true)
                        // One line: a timed send's time, else the host's sentence.
                        if let effect = OutboxModel.scheduledLine(item) ?? OutboxModel.effectLine(item) {
                            Text(effect).font(.subheadline).foregroundStyle(Color(.label)).fixedSize(horizontal: false, vertical: true)
                        }
                        if row.changed {
                            Text(viewError.map { "Not opened: \($0)" } ?? (current.receipt == nil ? "Reading it as it stands now…" : "Changed since asked. Tick it to include it as it stands now."))
                                .textStep(.meta, tint: viewError == nil ? Color(.label) : Tint.destructiveText)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        ForEach(OutboxModel.notes(item, held: { HeldTime.of($0) })) { note in
                            Text(note.text)
                                .textStep(.meta, tint: note.kind == .failed ? Tint.destructiveText : Color(.label))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .padding(.horizontal, Layout.textEdge)
                    .padding(.vertical, 12)
                    ForEach(view.fields) { field in
                        if field.gap { Color.clear.frame(height: 16) } else { Hairline() }
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            Text(field.label).textStep(.meta, tint: Color(.label)).frame(width: labelWidth, alignment: .leading)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(field.value).font(.body).fixedSize(horizontal: false, vertical: true)
                                if let detail = field.detail { Text(detail).textStep(.meta, tint: Color(.label)) }
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
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.horizontal, Layout.textEdge)
                            .padding(.vertical, 16)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    if let quote = view.quote {
                        Text(quote).textStep(.meta).fixedSize(horizontal: false, vertical: true)
                            .padding(.horizontal, Layout.textEdge)
                            .padding(.bottom, 16)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .task {
            // Opening a changed row is what lets him press it: the host issues its receipt at what he sees now.
            guard row.changed, row.open, row.result == nil, shown == nil else { return }
            do {
                let next = try await client.work.viewRow(request.id, ref: row.ref)
                shown = next
                opened(next)
            } catch {
                viewError = ActionError.wrap(error).message
            }
        }
        .accessibilityIdentifier("outbox-request-row")
    }
}

/// A Work thread's `outbox_request` answer in its transcript: one compact card (the transcript's hairline frame, no
/// fill) with the Outbox glyph muted, what goes, and his words; a tap opens the sheet. Once answered, declined or
/// run out it is one muted line. Never the warning colour.
struct OutboxRequestInline: View {
    @Environment(AppModel.self) private var model
    @Environment(\.displayScale) private var displayScale
    let id: String
    let host: String
    /// The thread's own host: the request's when `host` names no paired host.
    let client: EnvironmentClient
    var inTable = false
    @State private var read: OutboxRequest?

    private var target: EnvironmentClient { model.registry.client(host) ?? client }
    private var open: OutboxRequest? { target.work.requests.first { $0.id == id } }

    var body: some View {
        Group {
            if let request = open {
                Button { OutboxRequestCenter.shared.open(environmentId: target.environment.id, id: id) } label: {
                    HStack(alignment: .top, spacing: Layout.rowGap) {
                        Image(systemName: "checklist")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .frame(width: Layout.markWidth)
                            .padding(.top, 1)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(RequestSheetModel.askedHead(request))
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(.primary)
                                .fixedSize(horizontal: false, vertical: true)
                            Text("You asked: “\(request.quote)”")
                                .textStep(.meta)
                                .lineLimit(2)
                        }
                        Spacer(minLength: 0)
                        // What the tap does, in his word: the sheet is where he reviews and presses.
                        Text("Review")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(.tint)
                    }
                    .padding(12)
                    .contentShape(Rectangle())
                    .overlay { RoundedRectangle.fieldCorner.stroke(Surface.hairline, lineWidth: Hairline.thickness(scale: displayScale)) }
                }
                .buttonStyle(.pressable)
                .accessibilityElement(children: .combine)
                .accessibilityHint("Opens what the thread asked for")
            } else {
                // Over, or not readable with this key: one muted line where the call was.
                let line = read.flatMap { r in r.state == .open ? nil : RequestSheetModel.resultsHead(r) ?? RequestSheetModel.closedLine(r, time: { HeldTime.of($0) }) } ?? "Asked for your press in the Outbox"
                HStack(spacing: Layout.rowGap) {
                    Image(systemName: "checklist").font(.caption).foregroundStyle(.secondary).frame(width: Layout.markWidth)
                    Text(line).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                    Spacer(minLength: 0)
                }
                .frame(minHeight: 28)
            }
        }
        .padding(.horizontal, inTable ? TranscriptMetrics.tableInset : 0)
        // Not among the open ones: read it once, so the line can say how it ended (approve keys alone).
        .task(id: open == nil) {
            guard open == nil, read == nil, target.work.may(.outboxRequestGet) else { return }
            read = try? await target.work.request(id)
        }
        .accessibilityIdentifier("outbox-request-card")
    }
}
