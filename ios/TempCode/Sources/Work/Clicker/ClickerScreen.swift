import SwiftUI
import TempCodeClient
import UIKit

/// The clicker's few lengths and its notes' sizes (docs/IOS-DESIGN.md "The clicker").
enum ClickerMetrics {
    /// Previous: a band across the controls.
    static let previousBand: CGFloat = 64
    /// Around the controls, and between a control's glyph and its word.
    static let gap: CGFloat = 8
    /// Between Previous and Next: wide enough that a thumb meant for one does not land on the other.
    static let bandGap: CGFloat = 16
    /// Above and below the notes inside their scroll.
    static let notesPadding: CGFloat = 12
    /// How far a swipe travels before it steps.
    static let swipe: CGFloat = 48
    /// The notes' size at the default text size, stepped from More: the presenter's view's range.
    static let notesSmallest: Double = 14
    static let notesLargest: Double = 28
    static let notesStep: Double = 2
    static let notesDefault: Double = TranscriptType.document.size

    /// The document type at `size`, its line box in the same ratio.
    static func notesType(_ size: Double) -> TypeSpec {
        let base = TranscriptType.document
        return TypeSpec(base.style, size, size * base.lineHeight / base.size, weight: base.weight)
    }
}

/// A slideshow running on one of his computers, stepped from the phone (PF6). Upright: the notes on top, the
/// count and the timer, Previous as a band, Next as the lower half. On its side and on the Duo unfolded: the
/// notes on one pane and the controls on the other (`ClickerPanes`). A press answers under his finger and
/// never waits for the host.
struct ClickerScreen: View {
    let model: ClickerModel
    /// Shown as a cover: Done in the bar, and the ended page's Done, call it.
    var onDone: (() -> Void)?

    @Environment(\.dismiss) private var dismiss
    @Environment(\.horizontalSizeClass) private var sizeClass
    @AppStorage("clicker.notesSize") private var notesSize = ClickerMetrics.notesDefault
    /// A press sent: the light impact.
    @State private var pressed = 0
    /// A press that could do nothing: the rigid tick.
    @State private var bumped = 0

    var body: some View {
        content
            .background(Surface.background)
            .navigationTitle(model.show?.name ?? "")
            .navigationBarTitleDisplayMode(.inline)
            .tcNavigationBar()
            .toolbar {
                // The ended page has its own Done: the bar's would say it twice.
                if let onDone, !model.ended {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") { onDone() }
                    }
                }
                if let show = model.show, !model.ended {
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            more(show)
                        } label: {
                            Image(systemName: GlassMetrics.moreSymbol)
                        }
                        .accessibilityLabel("More")
                        .accessibilityIdentifier("clicker-more")
                    }
                }
            }
            .task { await model.load() }
            .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
            .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
            .sensoryFeedback(.impact(weight: .light), trigger: pressed)
            .sensoryFeedback(.impact(flexibility: .rigid), trigger: bumped)
            .accessibilityIdentifier("clicker")
    }

    @ViewBuilder
    private var content: some View {
        if model.ended {
            ContentUnavailableView {
                Label("The Show Ended", systemImage: "play.rectangle")
            } actions: {
                Button("Done") { close() }
            }
        } else if let show = model.show {
            GeometryReader { proxy in
                let layout = ClickerPanes.of(
                    width: Double(proxy.size.width),
                    height: Double(proxy.size.height),
                    regularWidth: sizeClass == .regular,
                    division: Duo.divisionBand(proxy)
                )
                switch layout {
                case .stacked:
                    VStack(spacing: 0) {
                        notes(show)
                        controls(show, nextHeight: proxy.size.height / 2)
                    }
                case .split(let notesWidth, let controlsWidth):
                    HStack(spacing: 0) {
                        notes(show)
                            .frame(width: CGFloat(notesWidth))
                        Spacer(minLength: 0)
                        controls(show, nextHeight: nil)
                            .frame(width: CGFloat(controlsWidth))
                    }
                }
            }
            .contentShape(Rectangle())
            .simultaneousGesture(swipe)
        } else if let failure = model.failure {
            ContentUnavailableView {
                Label("Can’t Reach the Show", systemImage: "exclamationmark.triangle")
            } description: {
                Text(failure)
            } actions: {
                Button("Try Again") { Task { await model.load() } }
            }
        } else {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /// The slide's speaker notes, at the size he stepped to; back at the top on each slide. Nothing while the
    /// slide's notes are on their way: never another slide's. No text selection: a drag there steps the show.
    private func notes(_ show: ClickerShow) -> some View {
        ScrollView {
            Group {
                if let notes = model.notes {
                    if notes.isEmpty {
                        Text("No notes")
                            .textStep(.meta)
                    } else {
                        Text(notes)
                            .transcriptType(ClickerMetrics.notesType(notesSize))
                            .foregroundStyle(.primary)
                    }
                }
            }
            .frame(maxWidth: ReaderMetrics.measure, alignment: .leading)
            .padding(.horizontal, Layout.textEdge)
            .padding(.vertical, ClickerMetrics.notesPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .id(show.slide)
        .frame(maxHeight: .infinity)
        // A line the scroll cuts at large sizes stops short of the count line instead of touching it.
        .padding(.bottom, ClickerMetrics.gap)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(model.notes.map { $0.isEmpty ? "No notes" : "Notes: \($0)" } ?? "")
        .accessibilityHidden(model.notes == nil)
        .accessibilityIdentifier("clicker-notes")
    }

    /// The count line, Previous and Next. `nextHeight`: Next's share upright (half the screen); nil: it takes
    /// what the pane leaves.
    private func controls(_ show: ClickerShow, nextHeight: CGFloat?) -> some View {
        VStack(spacing: ClickerMetrics.gap) {
            if let refusal = model.refusal {
                Text(refusal)
                    .textStep(.meta, tint: Tint.destructiveText)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("clicker-refusal")
            }
            countLine(show)
            Button { press(.previous) } label: {
                Label("Previous", systemImage: "chevron.left")
                    .font(.headline)
                    .frame(maxWidth: .infinity, minHeight: ClickerMetrics.previousBand)
                    // On the first slide it looks unavailable and keeps its place; a press there still ticks.
                    .foregroundStyle(show.isFirst ? HierarchicalShapeStyle.tertiary : .primary)
                    .background(Surface.fill, in: RoundedRectangle.corner(Radius.field))
            }
            .buttonStyle(.pressable)
            .padding(.bottom, ClickerMetrics.bandGap - ClickerMetrics.gap)
            .accessibilityLabel("Previous slide")
            .accessibilityIdentifier("clicker-previous")
            Button { press(.next) } label: {
                VStack(spacing: ClickerMetrics.gap) {
                    Image(systemName: "chevron.right")
                    Text("Next")
                }
                .font(.largeTitle.weight(.semibold))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .foregroundStyle(show.isLast ? HierarchicalShapeStyle.tertiary : .primary)
                .background(Surface.fill, in: RoundedRectangle.corner(Radius.field))
            }
            .buttonStyle(.pressable)
            .frame(height: nextHeight)
            .frame(maxHeight: nextHeight == nil ? .infinity : nil)
            .accessibilityLabel("Next slide")
            .accessibilityIdentifier("clicker-next")
        }
        .padding(.horizontal, Layout.textEdge)
        .padding(.vertical, ClickerMetrics.gap)
    }

    /// "4 / 12", Blank while the screen shows black, and the time since the show began.
    private func countLine(_ show: ClickerShow) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Layout.rowGap) {
            CountText(show.position, step: .title, weight: .semibold)
                .accessibilityLabel("Slide \(show.slide) of \(show.count)")
            if show.blank {
                // A state he must not miss: the room sees black. The label ink, not the meta grey.
                Text("Blank")
                    .textStep(.meta, weight: .semibold, tint: .primary)
            }
            Spacer(minLength: 0)
            if let startedAt = show.startedAt {
                // Tabular digits that do not roll: a second's tick is not news, the slide count is.
                Tick(every: 1) { tick in
                    Text(TimeFormat.elapsed(since: Int(startedAt), now: tick))
                        .textStep(.title)
                        .monospacedDigit()
                }
            }
        }
        .frame(minHeight: Layout.rowHeight)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("clicker-count")
    }

    @ViewBuilder
    private func more(_ show: ClickerShow) -> some View {
        Button("Larger Text", systemImage: "textformat.size.larger") {
            notesSize = min(ClickerMetrics.notesLargest, notesSize + ClickerMetrics.notesStep)
        }
        .disabled(notesSize >= ClickerMetrics.notesLargest)
        Button("Smaller Text", systemImage: "textformat.size.smaller") {
            notesSize = max(ClickerMetrics.notesSmallest, notesSize - ClickerMetrics.notesStep)
        }
        .disabled(notesSize <= ClickerMetrics.notesSmallest)
        Button(show.blank ? "Unblank" : "Blank", systemImage: show.blank ? "rectangle" : "rectangle.fill") { press(.blank) }
        Divider()
        Button("End Show", systemImage: "stop.fill", role: .destructive) { press(.end) }
    }

    /// Left steps on, right steps back: the horizontal travel must lead.
    private var swipe: some Gesture {
        DragGesture(minimumDistance: ClickerMetrics.swipe / 2)
            .onEnded { drag in
                let across = drag.translation.width
                guard abs(across) >= ClickerMetrics.swipe, abs(across) > abs(drag.translation.height) else { return }
                press(across < 0 ? .next : .previous)
            }
    }

    /// Sent on release and never awaited; a press that can do nothing gives the rigid tick.
    private func press(_ press: ClickerPress) {
        if model.press(press) { pressed += 1 } else { bumped += 1 }
    }

    private func close() {
        if let onDone { onDone() } else { dismiss() }
    }
}
