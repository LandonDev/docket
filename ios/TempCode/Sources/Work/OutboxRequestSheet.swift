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

/// A thread's request for his press (Outbox 2's phone.html, "The request"): what goes in one sentence, his own
/// words the thread quoted, a row per item with its tick, and Not Now and Send N at the foot. A row that changed
/// since the thread asked starts unticked and says so; opening it asks the host for a fresh receipt
/// (`request.view`), and he ticks it himself. Send waits the phone's five seconds with Undo, each ticked row saying
/// what it does, to whom and when; then each row's result lands in place. Held is not Needs you: nothing here wears
/// the warning colour.
struct OutboxRequestSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let client: EnvironmentClient
    let requestId: String

    private enum Phase: Equatable { case choosing, waiting, sending, done }

    @State private var request: OutboxRequest?
    @State private var loadError: String?
    @State private var ticks: Set<String> = []
    /// Rows he opened since the sheet loaded, with the fresh receipt the host gave each.
    @State private var fresh: [String: OutboxRequestRow] = [:]
    @State private var phase: Phase = .choosing
    @State private var wait: Task<Void, Never>?
    @State private var pressError: String?

    var body: some View {
        NavigationStack {
            Group {
                if let request {
                    content(merged(request))
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
        // A Send still waiting goes at once when the sheet leaves or the app does, as every phone Send does.
        .onDisappear { flush() }
        .onChange(of: scenePhase) { _, phase in if phase == .background { flush() } }
        .accessibilityIdentifier("outbox-request")
    }

    private func load() async {
        do {
            let answer = try await client.work.request(requestId)
            if request == nil { ticks = RequestSheetModel.initialTicks(answer) }
            request = answer
            if answer.state != .open, phase == .choosing { phase = .done }
        } catch {
            loadError = ActionError.wrap(error).message
        }
    }

    /// The request with every row he opened at its fresh receipt.
    private func merged(_ request: OutboxRequest) -> OutboxRequest {
        guard !fresh.isEmpty, phase != .done else { return request }
        return OutboxRequest(id: request.id, n: request.n, sessionId: request.sessionId, workspaceId: request.workspaceId, sector: request.sector, quote: request.quote, head: request.head, state: request.state, why: request.why,
                             createdAt: request.createdAt, expiresAt: request.expiresAt, answeredBy: request.answeredBy, answeredAt: request.answeredAt,
                             rows: request.rows.map { fresh[OutboxModel.key($0.ref)] ?? $0 })
    }

    private func content(_ request: OutboxRequest) -> some View {
        let thread = client.session(request.sessionId)?.title
        return List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(RequestSheetModel.resultsHead(request) ?? request.head)
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
                    RequestRowView(row: row, request: request, client: client, ticked: ticks.contains(OutboxModel.key(row.ref)), phase: rowPhase(row), toggle: { toggle(row) }, opened: { fresh[OutboxModel.key($0.ref)] = $0 })
                }
            }
        }
        .listStyle(.plain)
        .animation(reduceMotion ? nil : Motion.base, value: phase)
        .safeAreaInset(edge: .bottom, spacing: 0) { foot(request) }
    }

    private func rowPhase(_ row: OutboxRequestRow) -> RequestRowView.Phase {
        let ticked = ticks.contains(OutboxModel.key(row.ref))
        switch phase {
        case .choosing: return .choosing
        case .waiting: return ticked ? .waiting : .left
        case .sending: return ticked ? .sending : .left
        case .done: return row.result == nil ? .left : .done
        }
    }

    private func toggle(_ row: OutboxRequestRow) {
        guard phase == .choosing, RequestSheetModel.pressable(row) else { return }
        let key = OutboxModel.key(row.ref)
        if ticks.contains(key) { ticks.remove(key) } else { ticks.insert(key) }
    }

    // MARK: - the foot

    @ViewBuilder
    private func foot(_ request: OutboxRequest) -> some View {
        switch phase {
        case .waiting:
            UndoCapsule(line: waitingLine(request), identifier: "outbox-request-undo") { undo() }
                .transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: 12)))
        case .done:
            wide("Done", prominent: true, identifier: "outbox-request-done") { dismiss() }
                .padding(.horizontal, Layout.textEdge)
                .padding(.vertical, 8)
        case .choosing, .sending:
            let count = request.rows.filter { ticks.contains(OutboxModel.key($0.ref)) && RequestSheetModel.pressable($0) }.count
            HStack(spacing: 10) {
                wide("Not Now", prominent: false, identifier: "outbox-request-decline") { Task { await decline() } }
                wide(RequestSheetModel.pressWord(request, ticked: ticks), prominent: true, identifier: "outbox-request-send", busy: phase == .sending) { press() }
                    .disabled(count == 0)
            }
            .disabled(phase == .sending || !client.work.canApprove)
            .padding(.horizontal, Layout.textEdge)
            .padding(.vertical, 8)
        }
    }

    /// "Sending 9", "Approving 3": the capsule's line while his press waits; each row says its own action and time.
    private func waitingLine(_ request: OutboxRequest) -> String {
        let word = RequestSheetModel.pressWord(request, ticked: ticks)
        let parts = word.split(separator: " ")
        let verb = switch parts.first {
        case "Send": "Sending"
        case "Discard": "Discarding"
        case "Schedule": "Scheduling"
        default: "Approving"
        }
        return "\(verb) \(parts.last ?? "")"
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

    /// His Send: nothing reaches the host for five seconds, so Undo is a true undo.
    private func press() {
        guard phase == .choosing, let request else { return }
        pressError = nil
        phase = .waiting
        AccessibilityNotification.Announcement("\(waitingLine(merged(request))). Undo for five seconds.").post()
        wait = Task {
            try? await Task.sleep(for: .seconds(OutboxPresses.waitSeconds))
            guard !Task.isCancelled else { return }
            await commit()
        }
    }

    private func undo() {
        wait?.cancel()
        wait = nil
        phase = .choosing
    }

    /// The sheet or the app leaves while a Send waits: it goes now rather than drop it.
    private func flush() {
        guard phase == .waiting else { return }
        wait?.cancel()
        wait = nil
        let client = client
        let id = requestId
        let receipts = ticketed()
        phase = .sending
        Task { _ = try? await client.work.answer(id, receipts: receipts) }
    }

    /// The receipts of exactly the ticked rows he may press as drawn.
    private func ticketed() -> [String] {
        guard let request else { return [] }
        return merged(request).rows.compactMap { row in
            ticks.contains(OutboxModel.key(row.ref)) && RequestSheetModel.pressable(row) ? row.receipt : nil
        }
    }

    private func commit() async {
        let receipts = ticketed()
        guard !receipts.isEmpty else { return phase = .choosing }
        phase = .sending
        do {
            request = try await client.work.answer(requestId, receipts: receipts)
            fresh = [:]
            phase = .done
        } catch {
            pressError = "Not sent: \(ActionError.wrap(error).message)"
            phase = .choosing
            await load()
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
    let toggle: () -> Void
    let opened: (OutboxRequestRow) -> Void
    @ScaledMetric(relativeTo: .body) private var tickSize: CGFloat = 22

    var body: some View {
        let words = RequestSheetModel.rowWords(row)
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
                    if let text = line(words.line, result: result) {
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
        .opacity(phase == .left ? 0.45 : 1)
        .padding(.vertical, 2)
        .listRowInsets(EdgeInsets(top: 0, leading: Layout.textEdge - (Layout.rowHeight - tickSize) / 2, bottom: 0, trailing: Layout.textEdge))
        .accessibilityElement(children: .contain)
    }

    /// While his press waits, each ticked row says what it does, to whom and when; once it landed, its result.
    private func line(_ line: String?, result: (ok: Bool, text: String)?) -> String? {
        if let result { return result.text }
        if phase == .waiting { return RequestSheetModel.pendingLines(request, ticked: [OutboxModel.key(row.ref)]).first }
        return line
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
                            Text(request.head)
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(.primary)
                                .fixedSize(horizontal: false, vertical: true)
                            Text("You asked: “\(request.quote)”")
                                .textStep(.meta)
                                .lineLimit(2)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.tertiary)
                            .padding(.top, 2)
                    }
                    .padding(12)
                    .contentShape(Rectangle())
                    .overlay { RoundedRectangle.fieldCorner.stroke(Surface.hairline, lineWidth: Hairline.thickness(scale: displayScale)) }
                }
                .buttonStyle(.pressable)
                .accessibilityElement(children: .combine)
                .accessibilityHint("Opens what the thread asked for")
            } else if let read, read.state != .open, let line = RequestSheetModel.resultsHead(read) ?? RequestSheetModel.closedLine(read, time: { HeldTime.of($0) }) {
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
