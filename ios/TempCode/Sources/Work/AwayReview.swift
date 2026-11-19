import SwiftUI
import TempCodeClient
import TempCodeContract
import UserNotifications

/// Away from computer on the phone (phone-outbox.html, "Back from Away"):
/// a check item in the host menu, one notice when it ends, and the review,
/// sorted by what he must do: held sends with their verb, what failed, each
/// thread's decisions, then each write on his files with Undo.

/// Away as a check item in the host menu, beside the fleet switches.
struct AwayMenuItem: View {
    let client: EnvironmentClient

    var body: some View {
        if client.work.away != nil {
            Toggle("Away", systemImage: "moon", isOn: Binding(
                get: { client.work.awayOn },
                set: { on in
                    Task {
                        do { try await client.work.setAway(on) } catch {
                            FleetToastCenter.shared.post(message: "Away not changed: \(ActionError.wrap(error).message)")
                        }
                    }
                }
            ))
            .disabled(!client.work.canApprove)
        }
    }
}

/// What every host's ended stretch adds up to, for the notice.
@MainActor
enum AwayEnds {
    static func ended(_ clients: [EnvironmentClient]) -> [EnvironmentClient] {
        clients.filter { $0.work.awayEnd != nil }
    }

    static func counts(_ clients: [EnvironmentClient]) -> OutboxModel.AwayCounts {
        let work = clients.filter(\.work.isOn)
        let items = work.flatMap(\.work.items)
        return OutboxModel.AwayCounts(
            held: items.count { $0.state != .failed },
            failed: items.count { $0.state == .failed },
            decided: ended(clients).compactMap(\.work.awayEnd).flatMap(\.decided.threads).reduce(0) { $0 + $1.count }
        )
    }

    /// The lock screen's one notice when the app is not in front: "Away ended", what waits.
    static func notify(_ line: String) {
        let content = UNMutableNotificationContent()
        content.title = "Away ended"
        content.body = line
        content.threadIdentifier = "tc.away"
        content.interruptionLevel = .active
        let request = UNNotificationRequest(identifier: "tc.away.end", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
}

/// Home's note while an end waits to be reviewed: one line and Review.
struct AwayEndNote: View {
    @Environment(AppModel.self) private var model
    @State private var reviewing = false

    var body: some View {
        let clients = model.registry.ordered
        if !AwayEnds.ended(clients).isEmpty {
            QuietNote(text: "Away ended. " + (OutboxModel.awayLine(AwayEnds.counts(clients)) ?? "Nothing waits for you."), action: ("Review", { reviewing = true }))
                .listRowInsets(Layout.rowInsets)
                .listRowSeparator(.hidden)
                .accessibilityIdentifier("away-ended")
                .sheet(isPresented: $reviewing, onDismiss: { for client in clients { client.work.reviewedAway() } }) {
                    AwayReviewSheet()
                }
                #if DEBUG
                .task { if TestHooks.sheet == "away" { try? await Task.sleep(for: .seconds(1)); reviewing = true } }
                #endif
        }
    }
}

/// The review, as a document sheet: the span, then Held, Failed, Decided
/// without you, Written on your files, each left out when empty.
struct AwayReviewSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(ShellNavigator.self) private var navigator
    @State private var written: [(environmentId: String, result: WorkResult)] = []
    /// Still reading each host's writes: Written shows its spinner, and nothing says "Nothing happened" yet.
    @State private var reading = true
    /// Hosts whose writes did not come back: named under Written with Retry, which reads them alone.
    @State private var unread: [String] = []
    @State private var rereading = false
    @State private var undoing: Set<String> = []

    var body: some View {
        let clients = model.registry.ordered
        let ends = AwayEnds.ended(clients)
        let entries = OutboxEntries.of(clients)
        let held = entries.filter { $0.item.state != .failed }
        let failed = entries.filter { $0.item.state == .failed }
        let decided = ends.flatMap { client in client.work.awayEnd?.decided.threads.map { (client: client, thread: $0) } ?? [] }
        NavigationStack {
            List {
                if let span = span(ends) {
                    Text(span)
                        .textStep(.meta)
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                }
                if !held.isEmpty {
                    Section("Held") { ForEach(held) { heldRow($0) } }
                }
                if !failed.isEmpty {
                    Section("Failed") { ForEach(failed) { heldRow($0) } }
                }
                if !decided.isEmpty {
                    Section("Decided without you") {
                        ForEach(decided, id: \.thread.sessionId) { row in
                            Button {
                                dismiss()
                                navigator.open(.thread(environmentId: row.client.environment.id, sessionId: row.thread.sessionId, seq: nil))
                            } label: {
                                HStack {
                                    Text(row.client.listedSessions.first { $0.id == row.thread.sessionId }?.title ?? "A thread")
                                        .textStep(.title)
                                        .lineLimit(1)
                                    Spacer(minLength: 8)
                                    Text(row.thread.count == 1 ? "1 decision" : "\(row.thread.count) decisions")
                                        .textStep(.stamp)
                                }
                                .frame(minHeight: Layout.rowHeight)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.pressable)
                        }
                    }
                }
                if reading || !written.isEmpty || !unread.isEmpty {
                    Section("Written on your files") {
                        if reading {
                            ProgressView()
                                .frame(maxWidth: .infinity, minHeight: Layout.rowHeight)
                                .accessibilityLabel("Reading what was written")
                        }
                        ForEach(written, id: \.result.id) { row in
                            HStack(spacing: 12) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(row.result.summary)
                                        .textStep(.title)
                                        .lineLimit(2)
                                    if let account = row.result.account {
                                        Text(account).textStep(.meta).lineLimit(1)
                                    }
                                }
                                Spacer(minLength: 8)
                                if row.result.undoneAt != nil {
                                    Text("Undone").textStep(.stamp)
                                } else if row.result.undo != nil {
                                    Button(row.result.undo?.label ?? "Undo") { Task { await undo(row) } }
                                        .font(.footnote.weight(.medium))
                                        .foregroundStyle(.tint)
                                        .rowActionHit()
                                        .buttonStyle(.pressable)
                                        .disabled(undoing.contains(row.result.id))
                                }
                            }
                            .frame(minHeight: Layout.rowHeight)
                        }
                        // A partial read says so, by host, with Retry for the hosts that did not answer.
                        if !reading, let line = OutboxModel.unreadLine(unread.map { id in clients.first { $0.environment.id == id }?.environment.name ?? "A host" }) {
                            HStack(spacing: 12) {
                                Text(line).textStep(.meta, tint: Tint.destructiveText)
                                Spacer(minLength: 8)
                                if rereading {
                                    ProgressView()
                                } else {
                                    PillButton("Retry") { Task { await reread(ends) } }
                                }
                            }
                            .frame(minHeight: Layout.rowHeight)
                            .accessibilityElement(children: .combine)
                        }
                    }
                }
                if !reading, unread.isEmpty, held.isEmpty, failed.isEmpty, decided.isEmpty, written.isEmpty {
                    Text("Nothing happened while you were away.")
                        .textStep(.meta)
                        .listRowSeparator(.hidden)
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("While You Were Away")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task { await loadWritten(ends) }
        }
        .tcSheet(.document)
        .accessibilityIdentifier("away-review")
    }

    /// A held row: what it does and its verb, which opens the item.
    private func heldRow(_ entry: OutboxModel.Entry) -> some View {
        Button {
            dismiss()
            // Over the Outbox, so Send returns to the list and its Undo (ShellNavigator.openHeld).
            Task { await navigator.openHeld(.outboxItem(environmentId: entry.environmentId, ref: OutboxModel.key(entry.item.ref))) }
        } label: {
            HStack(spacing: Layout.rowGap) {
                Image(systemName: WorkGlyph.of(entry.item.kind))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(width: Layout.glyphWidth)
                Text(entry.item.summary)
                    .textStep(.title)
                    .lineLimit(1)
                Spacer(minLength: 8)
                // The verb says what the item does, muted: the row opens the item, it does not send.
                Text(entry.item.state == .failed ? "Send Again" : entry.item.verb)
                    .textStep(.meta)
            }
            .frame(minHeight: Layout.rowHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
    }

    /// "5:40 PM to 9:55 PM": the widest stretch any host was away.
    private func span(_ ends: [EnvironmentClient]) -> String? {
        let all = ends.compactMap(\.work.awayEnd)
        guard let since = all.map(\.since).min(), let until = all.map(\.until).max() else { return nil }
        let from = Date(timeIntervalSince1970: Double(since) / 1000)
        let to = Date(timeIntervalSince1970: Double(until) / 1000)
        let time = Date.FormatStyle(date: .omitted, time: .shortened)
        return Calendar.current.isDate(from, inSameDayAs: to)
            ? "\(from.formatted(time)) to \(to.formatted(time))"
            : "\(from.formatted(.dateTime.month(.abbreviated).day().hour().minute())) to \(to.formatted(time))"
    }

    /// Every Work host's writes in the stretch, newest first: a host reached through another reads Away
    /// on its carrier's lane, so the widest span the ended hosts give stands for all of them. Cut at the
    /// moment he came back and never a send (`OutboxModel.awayWrites`); a host that does not answer is
    /// named, never read as having written nothing.
    private func loadWritten(_ ends: [EnvironmentClient]) async {
        defer { reading = false }
        await read(model.registry.ordered.filter(\.work.isOn).map(\.environment.id), ends: ends)
    }

    /// Reads again only the hosts that did not answer.
    private func reread(_ ends: [EnvironmentClient]) async {
        rereading = true
        defer { rereading = false }
        let hosts = unread
        unread = []
        await read(hosts, ends: ends)
    }

    private func read(_ hosts: [String], ends: [EnvironmentClient]) async {
        let stretches = ends.compactMap(\.work.awayEnd)
        guard let since = stretches.map(\.since).min(), let until = stretches.map(\.until).max() else { return }
        var rows = written
        for id in hosts {
            guard let client = model.registry.client(id) else { continue }
            do {
                rows += OutboxModel.awayWrites(try await client.work.results(since: since), until: until).map { (id, $0) }
            } catch {
                unread.append(id)
            }
        }
        written = rows.sorted { $0.result.createdAt > $1.result.createdAt }
    }

    private func undo(_ row: (environmentId: String, result: WorkResult)) async {
        guard let client = model.registry.client(row.environmentId) else { return }
        undoing.insert(row.result.id)
        defer { undoing.remove(row.result.id) }
        do {
            let undone = try await client.work.undo(row.result)
            if let index = written.firstIndex(where: { $0.result.id == undone.id }) { written[index].result = undone }
        } catch {
            FleetToastCenter.shared.post(message: "Not undone: \(ActionError.wrap(error).message)")
        }
    }
}
