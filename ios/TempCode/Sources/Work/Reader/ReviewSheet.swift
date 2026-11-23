import SwiftUI
import TempCodeClient
import TempCodeContract

/// Review Changes (docs/IOS-DESIGN.md "A file on the phone"): what an agent proposed, one row a change.
/// A document's row is the block's old words struck through and its new ones underlined; a sheet's the
/// cell, what it holds and what it would hold, under the agent's reason for the change set. Swipe to
/// accept or reject one; the bar decides them all. A row the host refuses stays, with the host's words.
struct ReviewSheet: View {
    @Environment(\.dismiss) private var dismiss
    let review: WorkReview
    let canDecide: Bool
    @State private var busy = false
    @State private var decided = 0

    var body: some View {
        NavigationStack {
            List {
                if review.rows.isEmpty {
                    Text(review.failure ?? "Nothing waits")
                        .textStep(.meta)
                        .listRowSeparator(.hidden)
                }
                ForEach(review.groups) { group in
                    Section {
                        ForEach(group.rows) { row in
                            ReviewChangeRow(row: row)
                                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                    if canDecide {
                                        Button("Accept", systemImage: "checkmark") { Task { await decide(row, accept: true) } }
                                            .tint(Tint.success)
                                    }
                                }
                                .swipeActions(edge: .leading, allowsFullSwipe: true) {
                                    if canDecide {
                                        Button("Reject", systemImage: "xmark") { Task { await decide(row, accept: false) } }
                                            .tint(Tint.quiet)
                                    }
                                }
                                .rowAppearTransition()
                                .accessibilityIdentifier("review-change")
                        }
                    } header: {
                        // The agent's reason, once for the changes it made together.
                        if let heading = group.heading {
                            GroupHeader(heading)
                                // A plain list dims its section headers, and the header's own secondary came out
                                // at a third level (1.7:1); primary as the base keeps it at the meta step's grey.
                                .foregroundStyle(.primary)
                                .listRowInsets(EdgeInsets())
                        }
                    }
                }
            }
            .listStyle(.plain)
            .animation(Motion.rowLeave, value: review.rows.map(\.id))
            .navigationTitle(review.rows.isEmpty ? "Review Changes" : review.words.capitalized(with: nil))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .tcBottomBar { if canDecide, !review.rows.isEmpty { bar } }
            // The last change decided: there is nothing left to review.
            .onChange(of: review.rows.isEmpty) { _, empty in if empty, decided > 0 { dismiss() } }
            .sensoryFeedback(.impact(weight: .light), trigger: decided)
        }
        .tcSheet(.document)
        .accessibilityIdentifier("review-sheet")
        #if DEBUG
        // The reader's set (`TC_TEST_ACTION=review-accept-all`): the bar's Accept All, four seconds after the list shows.
        .task {
            guard TestHooks.action == "review-accept-all" else { return }
            try? await Task.sleep(for: .seconds(4))
            await decideAll(accept: true)
        }
        #endif
    }

    private var bar: some View {
        HStack(spacing: 8) {
            Button("Reject All") { Task { await decideAll(accept: false) } }
                .font(.body.weight(.medium))
                .padding(.horizontal, 6)
                .frame(minHeight: Layout.rowHeight)
                .buttonBorderShape(.capsule)
                .tcGlassButton()
                .accessibilityIdentifier("review-reject-all")
            Spacer(minLength: 0)
            if busy { ProgressView() }
            Button("Accept All") { Task { await decideAll(accept: true) } }
                .font(.body.weight(.semibold))
                .padding(.horizontal, 10)
                .frame(minHeight: Layout.rowHeight)
                .buttonBorderShape(.capsule)
                .tcGlassButton(prominent: true)
                .accessibilityIdentifier("review-accept-all")
        }
        .disabled(busy)
        .padding(.horizontal, Layout.textEdge)
        .padding(.vertical, 8)
    }

    private func decide(_ row: TempCodeClient.ReviewRow, accept: Bool) async {
        busy = true
        defer { busy = false }
        if await review.decide(row, accept: accept) { decided += 1 }
    }

    private func decideAll(accept: Bool) async {
        busy = true
        defer { busy = false }
        let before = review.count
        _ = await review.decideAll(accept: accept)
        if review.count < before { decided += 1 }
    }
}

/// One change: a document's block, or a sheet's cell with its address leading the row.
private struct ReviewChangeRow: View {
    let row: TempCodeClient.ReviewRow

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            switch row.kind {
            case .block(let old, let new):
                ChangeLines(old: old, new: new)
            case .cell(let address, let old, let new):
                // The cell in the label ink, so it reads apart from the reason that heads its group.
                Text(address).textStep(.meta, weight: .semibold, tint: .primary).monospacedDigit()
                ChangeLines(old: old, new: new)
            }
            if let refusal = row.refusal {
                Text(refusal).textStep(.meta, tint: Tint.destructiveText)
            }
        }
        .padding(.vertical, 4)
    }
}
