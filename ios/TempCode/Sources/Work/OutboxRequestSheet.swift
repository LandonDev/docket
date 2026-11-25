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

/// The phone's one wait for a request's Send, kept outside any sheet: a sheet closed or the app gone to the
/// background never sends a press early; it goes when its five seconds end, or never if he pressed Undo.
@MainActor
enum RequestPresses {
    static let wait = RequestPressWait(seconds: OutboxPresses.waitSeconds)
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

    private var wait: RequestPressWait { RequestPresses.wait }

    var body: some View {
        NavigationStack {
            Group {
                if let request {
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
            try? await Task.sleep(for: .seconds(2))
            press()
        }
        #endif
        // His press's answer, whenever it lands: in this sheet, or in one opened after the first was closed.
        .onChange(of: wait.outcomes[requestId], initial: true) { _, outcome in take(outcome) }
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
        case .failed(let message)?:
            pressError = "Not sent: \(message)"
            Task { await load() }
        case nil:
            return
        }
        wait.clear(requestId)
    }

    /// The request as drawn: every row he opened at its fresh receipt while the item stays as he saw it.
    private func drawn(_ request: OutboxRequest) -> OutboxRequest {
        request.state == .open ? RequestSheetModel.merged(request, opened: fresh) : request
    }

    private var phase: Phase {
        if let press = wait.pending[requestId] { return .waiting(press) }
        if wait.sending.contains(requestId) { return .sending }
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
                    if let pressError {
                        Text(pressError)
                            .textStep(.meta, tint: Tint.destructiveText)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if !client.work.canApprove {
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
            .disabled(phase == .sending || !client.work.canApprove)
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
        .accessibilityIdentifier(identifier)
    }

    // MARK: - the press

    /// His Send: exactly the ticked receipts as drawn, frozen now; nothing reaches the host for five seconds, so Undo
    /// is a true undo, and nothing sends it sooner.
    private func press() {
        guard phase == .choosing, let request, let press = RequestSheetModel.freeze(drawn(request), ticks: ticks, environmentId: client.environment.id) else { return }
        pressError = nil
        let work = client.work
        wait.start(press) { press in try await work.answer(press.requestId, receipts: press.receipts) }
        AccessibilityNotification.Announcement("\(press.waitingLine). Undo for five seconds.").post()
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

    var body: some View {
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
                        .lineLimit(1)
                    if let text = result == nil ? words.line : RequestSheetModel.settledLine(row) {
                        Text(text)
                            .textStep(.meta, tint: result?.ok == false ? Tint.destructiveText : nil)
                            .lineLimit(2)
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

    @ViewBuilder
    private func mark(_ result: (ok: Bool, text: String)?) -> some View {
        Group {
            switch phase {
            case .sending:
                ProgressView().controlSize(.small)
            case .done:
                if result?.ok == false {
                    Circle().fill(Tint.destructive).frame(width: Layout.dotSize, height: Layout.dotSize)
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
                        Text(OutboxModel.kindHeading(kind: item.kind, payload: item.payload, sent: false) ?? item.summary)
                            .font(.title3.weight(.semibold))
                            .fixedSize(horizontal: false, vertical: true)
                        if let effect = item.effect, !effect.isEmpty {
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
            guard open == nil, read == nil, target.work.canApprove else { return }
            read = try? await target.work.request(id)
        }
        .accessibilityIdentifier("outbox-request-card")
    }
}
