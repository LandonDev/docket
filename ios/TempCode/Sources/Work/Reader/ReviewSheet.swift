import SwiftUI
import TempCodeClient
import TempCodeContract

/// Review Changes (docs/IOS-DESIGN.md "A file on the phone"): what an agent proposed, one row a change.
/// A document's row is the block's old words struck through and its new ones underlined; a sheet's the
/// cell, what it holds and what it would hold, under the agent's reason for the change set. Swipe to
/// accept or reject one; the bar decides them all. One decision at a time: while one runs, the swipes and
/// the bar are off. A row the host refuses stays, with the host's words.
struct ReviewSheet: View {
    @Environment(\.dismiss) private var dismiss
    let review: WorkReview
    let canDecide: Bool
    @State private var decided = 0
    /// Try Again's read is on its way.
    @State private var retrying = false

    /// The swipes and the bar take no press while a decision runs.
    private var decides: Bool { canDecide && !review.deciding }

    var body: some View {
        NavigationStack {
            List {
                if review.rows.isEmpty, review.failure == nil {
                    Text("Nothing waits")
                        .textStep(.meta)
                        .listRowSeparator(.hidden)
                }
                ForEach(review.groups) { group in
                    Section {
                        ForEach(group.rows) { row in
                            ReviewChangeRow(row: row)
                                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                    // A row only Reject takes (its words say so) has no Accept.
                                    if decides, row.accepts {
                                        Button("Accept", systemImage: "checkmark") { Task { await decide(row, accept: true) } }
                                            .tint(Tint.success)
                                    }
                                }
                                // No full swipe: a rejected change has no undo.
                                .swipeActions(edge: .leading, allowsFullSwipe: false) {
                                    if decides {
                                        Button("Reject", systemImage: "xmark") { Task { await decide(row, accept: false) } }
                                            .tint(Tint.quiet)
                                    }
                                }
                                // A plain list draws a hairline over its first row, under the bar: none there.
                                .listRowSeparator(row.id == review.rows.first?.id ? .hidden : .automatic, edges: .top)
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
                    .listSectionSeparator(group.id == review.groups.first?.id ? .hidden : .automatic, edges: .top)
                }
            }
            .listStyle(.plain)
            .overlay {
                // A failed read with nothing to show: the host's words and Try Again, as the app's other reads.
                if review.rows.isEmpty, let failure = review.failure {
                    if retrying {
                        ProgressView()
                    } else {
                        ContentUnavailableView {
                            Label("Can’t Read the Changes", systemImage: "exclamationmark.triangle")
                        } description: {
                            Text(failure)
                        } actions: {
                            Button("Try Again") { Task { await retry() } }
                        }
                    }
                }
            }
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
            if review.deciding { ProgressView() }
            Button("Accept All") { Task { await decideAll(accept: true) } }
                .disabled(!review.acceptsAny)
                .font(.body.weight(.semibold))
                .padding(.horizontal, 10)
                .frame(minHeight: Layout.rowHeight)
                .buttonBorderShape(.capsule)
                .tcGlassButton(prominent: true)
                .accessibilityIdentifier("review-accept-all")
        }
        .disabled(!decides)
        .padding(.horizontal, Layout.textEdge)
        .padding(.vertical, 8)
    }

    private func retry() async {
        retrying = true
        defer { retrying = false }
        await review.load()
    }

    /// The model holds the one guard: a press while a decision runs sends nothing and changes no state here.
    private func decide(_ row: TempCodeClient.ReviewRow, accept: Bool) async {
        if await review.decide(row, accept: accept) { decided += 1 }
    }

    private func decideAll(accept: Bool) async {
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
