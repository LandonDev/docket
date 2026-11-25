import SwiftUI
import TempCodeClient
import TempCodeContract

/// Discard asks once, with one optional line for the thread: "Why, for the thread". The thread is told it was
/// discarded, with his line when he wrote one (`work.outbox.discard { reason }`). The list, the item screen and the
/// held line in a thread all ask this way.
struct OutboxDiscardPrompt: ViewModifier {
    @Binding var item: OutboxItem?
    let discard: (OutboxItem, String?) -> Void
    @State private var reason = ""

    func body(content: Content) -> some View {
        content
            .alert("Discard this?", isPresented: Binding(get: { item != nil }, set: { if !$0 { item = nil } }), presenting: item) { item in
                TextField("Why, for the thread", text: $reason)
                    .textInputAutocapitalization(.sentences)
                    .accessibilityIdentifier("outbox-discard-reason")
                Button("Discard", role: .destructive) {
                    discard(item, reason)
                    reason = ""
                }
                Button("Cancel", role: .cancel) { reason = "" }
            } message: { item in
                Text("\(OutboxModel.rowWords(item).title) will not be sent.")
            }
    }
}

extension View {
    /// Discard's one question, with its optional reason for the thread, while `item` is set.
    func outboxDiscardPrompt(_ item: Binding<OutboxItem?>, discard: @escaping (OutboxItem, String?) -> Void) -> some View {
        modifier(OutboxDiscardPrompt(item: item, discard: discard))
    }
}
