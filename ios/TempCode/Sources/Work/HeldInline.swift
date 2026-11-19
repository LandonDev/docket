import SwiftUI
import TempCodeClient
import TempCodeContract

/// The held line under a Work thread's call (phone-nav.html, "A held send"):
/// the Outbox glyph in the row's glyph column, "Held" and the act in his
/// words, muted. Held is not Needs you: never amber, never a card, and the
/// turn went on. A tap opens it in place to the act as it will go, in a
/// hairline frame with no fill, with Send, Edit and Discard. Send waits its
/// five seconds here, the line reading "Sending… Undo". Once decided the
/// line says so and opens nothing.
struct HeldInline: View {
    let n: Int
    let act: String
    let client: EnvironmentClient
    /// Inside a group's table the table is already the frame: the line takes the table's inset and the
    /// opened act draws no frame of its own (never a card in a card).
    var inTable = false
    @Environment(ShellNavigator.self) private var navigator
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.displayScale) private var displayScale
    @State private var open = false
    @State private var confirmDiscard = false

    /// The waiting item this line names (the host's number), while it waits.
    private var item: OutboxItem? { client.work.items.first { $0.n == n } }
    private var entry: OutboxModel.Entry? { item.map { OutboxModel.Entry(environmentId: client.environment.id, item: $0) } }

    var body: some View {
        let presses = OutboxPresses.shared
        let pending = entry.map { presses.pending?.id == $0.id } ?? false
        VStack(alignment: .leading, spacing: 6) {
            Button {
                guard item != nil, !pending else { return }
                withAnimation(reduceMotion ? nil : Motion.expand) { open.toggle() }
            } label: {
                HStack(spacing: Layout.rowGap) {
                    Image(systemName: WorkGlyph.outbox)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(width: Layout.markWidth)
                    (Text(pending ? "Sending " : item == nil ? "Was held " : "Held ").foregroundStyle(.secondary) + Text(act).foregroundStyle(.primary))
                        .font(.footnote)
                        .lineLimit(open ? nil : 1)
                    Spacer(minLength: 8)
                    if pending {
                        Button("Undo") { presses.undo() }
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.tint)
                            .buttonStyle(.pressable)
                    }
                }
                .frame(minHeight: 28)
                .contentShape(Rectangle())
            }
            .buttonStyle(.pressable)
            .accessibilityHint(item == nil ? "" : open ? "Closes the held act" : "Shows the held act")
            if open, let item, let entry, !pending {
                frame(item, entry: entry)
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, inTable ? TranscriptMetrics.tableInset : 0)
        .onChange(of: pending) { if pending { open = false } }
        #if DEBUG
        .task { if TestHooks.open == "held", item != nil { open = true } }
        #endif
        .confirmationDialog("Discard this?", isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("Discard", role: .destructive) {
                guard let item else { return }
                Task {
                    do { try await client.work.discard(item) } catch {
                        FleetToastCenter.shared.post(message: "Not discarded: \(ActionError.wrap(error).message)")
                    }
                }
            }
        }
        .accessibilityIdentifier("held-inline")
    }

    /// The act as it will go, in a hairline frame (radius 12, no fill), and its three buttons.
    private func frame(_ item: OutboxItem, entry: OutboxModel.Entry) -> some View {
        let view = OutboxModel.payloadView(item.payload)
        return VStack(alignment: .leading, spacing: 8) {
            ForEach(view.fields) { field in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(field.label).textStep(.meta).frame(width: 56, alignment: .leading)
                    Text(field.value).font(.footnote).fixedSize(horizontal: false, vertical: true)
                }
            }
            if let body = view.body {
                Text(body.text)
                    .font(.footnote)
                    .lineLimit(8)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if client.work.canApprove {
                HStack(spacing: 8) {
                    Button("Discard", role: .destructive) { confirmDiscard = true }
                        .foregroundStyle(Tint.destructive)
                        .buttonStyle(.pressable)
                    Spacer(minLength: 0)
                    if OutboxModel.editable(item.kind) {
                        // Edit is the detail's own sheet: the item over the Outbox, as a notice opens it.
                        Button("Edit") { Task { await navigator.openHeld(.outboxItem(environmentId: entry.environmentId, ref: OutboxModel.key(item.ref))) } }
                            .buttonBorderShape(.capsule)
                            .tcGlassButton()
                    }
                    Button(item.state == .failed ? "Send Again" : item.verb) { OutboxPresses.shared.send(entry) }
                        .fontWeight(.semibold)
                        .buttonBorderShape(.capsule)
                        .tcGlassButton(prominent: true)
                }
                .font(.footnote)
                .padding(.top, 2)
            }
        }
        .padding(inTable ? 0 : 12)
        .padding(.bottom, inTable ? 8 : 0)
        .overlay {
            if !inTable { RoundedRectangle.fieldCorner.stroke(Surface.hairline, lineWidth: Hairline.thickness(scale: displayScale)) }
        }
    }
}
