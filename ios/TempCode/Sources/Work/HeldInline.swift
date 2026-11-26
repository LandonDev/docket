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
    @State private var confirmDiscard: OutboxItem?
    /// Why his last press here did not start or did not go, under the act until his next press.
    @State private var line: String?

    /// The waiting item this line names (the host's number), while it waits.
    private var item: OutboxItem? { client.work.items.first { $0.n == n && OutboxModel.needsHim($0) } }
    private var entry: OutboxModel.Entry? { item.map { OutboxModel.Entry(environmentId: client.environment.id, item: $0) } }

    var body: some View {
        let presses = OutboxPresses.shared
        // Counting (with Undo), waiting its turn behind another, or on its way: all are "Sending".
        let pending = entry.map(presses.hides) ?? false
        let counting = entry.map { presses.pending?.id == $0.id } ?? false
        // A press of this item the background or a lost link put back: said here, as the Outbox's list says it.
        let notice = entry.flatMap(presses.notice(for:))
        // A press whose answer is out or lost: the line says so and offers nothing until it is read back.
        let checking = item.map { client.work.presses.busy(host: client.environment.id, ref: OutboxModel.key($0.ref)) } ?? false
        VStack(alignment: .leading, spacing: 6) {
            // Undo sits beside the line's own button, never inside it, so VoiceOver reaches both.
            HStack(spacing: Layout.rowGap) {
                // Sending, Checking and Was held open nothing: plain text, no button. Held opens the act in place.
                if item == nil || pending || checking {
                    lineLabel(pending: pending, checking: checking)
                        .accessibilityElement(children: .combine)
                } else {
                    Button {
                        withAnimation(reduceMotion ? nil : Motion.expand) { open.toggle() }
                    } label: {
                        lineLabel(pending: pending, checking: checking)
                    }
                    .buttonStyle(.pressable)
                    // The line stays 28 pt; the hit area reaches 44 above and below it.
                    .contentShape(Rectangle().inset(by: -8))
                    .accessibilityHint(open ? "Closes the held act" : "Shows the held act")
                }
                if counting {
                    Button("Undo") { presses.undo() }
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.tint)
                        // The line stays 28 pt; the hit area reaches 44 around the word.
                        .frame(minHeight: 28)
                        .contentShape(Rectangle().inset(by: -8))
                        .buttonStyle(.pressable)
                }
            }
            if let notice, !pending {
                Text(notice)
                    .textStep(.meta)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if open, let item, let entry, !pending, !checking {
                frame(item, entry: entry)
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, inTable ? TranscriptMetrics.tableInset : 0)
        .onChange(of: pending) { if pending { open = false } }
        #if DEBUG
        .task { if TestHooks.open == "held", item != nil { open = true } }
        #endif
        .outboxDiscardPrompt($confirmDiscard) { item, reason in
            Task {
                line = await OutboxPresses.shared.discard(OutboxModel.Entry(environmentId: client.environment.id, item: item), reason: reason)
            }
        }
        .accessibilityIdentifier("held-inline")
    }

    /// The line itself: the Outbox glyph, where the act stands, and the act in his words.
    private func lineLabel(pending: Bool, checking: Bool) -> some View {
        HStack(spacing: Layout.rowGap) {
            Image(systemName: WorkGlyph.outbox)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: Layout.markWidth)
            (Text(pending ? "Sending " : checking ? "Checking " : item == nil ? "Was held " : "Held ").foregroundStyle(.secondary) + Text(act).foregroundStyle(.primary))
                .font(.footnote)
                .lineLimit(open ? nil : 1)
            Spacer(minLength: 0)
        }
        .frame(minHeight: 28)
        .contentShape(Rectangle())
    }

    /// The act as it will go, in a hairline frame (radius 12, no fill), and its three buttons.
    private func frame(_ item: OutboxItem, entry: OutboxModel.Entry) -> some View {
        let view = OutboxModel.actView(item)
        return VStack(alignment: .leading, spacing: 8) {
            ForEach(view.fields) { field in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(field.label).textStep(.meta).frame(width: 56, alignment: .leading)
                    Text(field.value).font(.footnote).fixedSize(horizontal: false, vertical: true)
                }
                // A held change's next change starts a group: 8pt more over the stack's own 8.
                .padding(.top, field.gap ? 8 : 0)
            }
            if let body = view.body {
                // The whole body, as it will go: Send is pressed on what was read, never on a cut.
                Text(body.text)
                    .font(.footnote)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if client.work.may(.outboxSend) {
                HStack(spacing: 8) {
                    Button("Discard", role: .destructive) { confirmDiscard = item }
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(Tint.destructive)
                        .frame(minHeight: Layout.rowHeight)
                        .contentShape(Rectangle())
                        .buttonStyle(.pressable)
                    Spacer(minLength: 0)
                    // Pills, not glass: the opened act is content in the transcript, and glass never sits on content.
                    if OutboxModel.editable(item.kind) {
                        // Edit is the detail's own sheet: the item over the Outbox, as a notice opens it.
                        PillButton("Edit") { Task { await navigator.openHeld(.outboxItem(environmentId: entry.environmentId, ref: OutboxModel.key(item.ref))) } }
                    }
                    let verb = OutboxModel.pressWord(item, fallback: item.verb)
                    if item.state == .stale {
                        // Out of date: nothing to send; its own page asks the thread again.
                        PillButton("Open…") { Task { await navigator.openHeld(.outboxItem(environmentId: entry.environmentId, ref: OutboxModel.key(item.ref))) } }
                    } else if OutboxModel.sendsFromDetailOnly(item.kind) {
                        // A LifeOS reply's quote and a computer act's picture show only in the detail: the verb opens it.
                        PillButton("\(verb)…", tint: .accentColor) { Task { await navigator.openHeld(.outboxItem(environmentId: entry.environmentId, ref: OutboxModel.key(item.ref))) } }
                    } else {
                        PillButton(verb, tint: .accentColor) { Task { line = await OutboxPresses.shared.send(entry, quiet: true) } }
                    }
                }
                .padding(.top, 2)
                if let line {
                    Text(line)
                        .textStep(.meta, tint: Tint.destructiveText)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(inTable ? 0 : 12)
        .padding(.bottom, inTable ? 8 : 0)
        .overlay {
            if !inTable { RoundedRectangle.fieldCorner.stroke(Surface.hairline, lineWidth: Hairline.thickness(scale: displayScale)) }
        }
    }
}
