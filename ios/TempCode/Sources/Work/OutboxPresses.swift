import SwiftUI
import TempCodeClient
import TempCodeContract

/// Send on the phone waits five seconds before the host hears it, with Undo
/// in a capsule over the list (phone-outbox.html, "After Send"). Nothing has
/// left while it waits: the press reaches the host only when the five
/// seconds end, so Undo is a true undo. The item leaves the list at the
/// press; Undo puts it back. A second Send, or the app leaving the screen,
/// sends the waiting one at once rather than drop it.
@MainActor @Observable
final class OutboxPresses {
    static let shared = OutboxPresses()
    static let waitSeconds: Double = 5

    struct Pending: Identifiable, Equatable {
        let id: String
        let line: String
        let item: OutboxItem
        let environmentId: String
    }

    private(set) var pending: Pending?
    /// The press is in flight to the host: the item stays out of the list until its answer lands.
    private(set) var sending: Set<String> = []
    @ObservationIgnored private var wait: Task<Void, Never>?
    @ObservationIgnored private var clients: (String) -> EnvironmentClient? = { _ in nil }

    private init() {}

    func attach(_ clients: @escaping (String) -> EnvironmentClient?) {
        self.clients = clients
    }

    /// The entries the list hides: the one waiting its five seconds and the ones on their way.
    func hides(_ entry: OutboxModel.Entry) -> Bool {
        entry.id == pending?.id || sending.contains(entry.id)
    }

    func send(_ entry: OutboxModel.Entry) {
        flush()
        let next = Pending(id: entry.id, line: OutboxModel.pendingLine(entry.item), item: entry.item, environmentId: entry.environmentId)
        pending = next
        AccessibilityNotification.Announcement("\(next.line). Undo for five seconds.").post()
        wait = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.waitSeconds))
            guard !Task.isCancelled else { return }
            self?.commit(next)
        }
    }

    func undo() {
        wait?.cancel()
        wait = nil
        pending = nil
    }

    /// Sends the waiting press now (a second Send, the app leaving the screen).
    func flush() {
        guard let pending else { return }
        wait?.cancel()
        commit(pending)
    }

    private func commit(_ press: Pending) {
        if pending == press { pending = nil }
        guard let client = clients(press.environmentId) else {
            FleetToastCenter.shared.post(message: "Not sent: the host is not paired")
            return
        }
        sending.insert(press.id)
        Task {
            defer { sending.remove(press.id) }
            do {
                try await client.work.send(press.item)
            } catch {
                FleetToastCenter.shared.post(message: "Not sent: \(ActionError.wrap(error).message)")
            }
        }
    }
}

/// The capsule while a Send waits: one line and Undo, on glass, 44 pt tall,
/// over the bottom of the list. It enters and leaves from the same edge;
/// with Reduce Motion it only fades.
struct OutboxUndoInset: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        let presses = OutboxPresses.shared
        content
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if let pending = presses.pending {
                    UndoCapsule(line: pending.line) { presses.undo() }
                        .transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: 12)))
                        .ignoresSafeArea(.keyboard, edges: .bottom)
                }
            }
            .animation(Motion.base, value: presses.pending)
    }
}

/// One line and Undo on glass (the Outbox's Send, the Files place's Delete).
struct UndoCapsule: View {
    let line: String
    var identifier = "outbox-undo"
    let undo: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Text(line)
                .font(.footnote)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
            Button("Undo", action: undo)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tint)
                .frame(minHeight: 44)
                .buttonStyle(.pressable)
                .accessibilityIdentifier(identifier)
        }
        .padding(.horizontal, Layout.textEdge)
        .frame(minHeight: 44)
        .tcGlass(in: Capsule())
        .padding(.horizontal, ComposerBar.edge)
        .frame(maxWidth: ToastMeasure.maxWidth)
        .frame(maxWidth: .infinity)
        .padding(.bottom, 6)
        .accessibilityElement(children: .contain)
    }
}

extension View {
    /// The Outbox's undo capsule, on the list that a Send returns to.
    func outboxUndoInset() -> some View {
        modifier(OutboxUndoInset())
    }
}
