import SwiftUI
import TempCodeClient
import UIKit

/// The one frame a place's list uses (docs/IOS-DESIGN.md "Work in every pose"): the place's title, an
/// optional job filter in the bar, search when the caller gives it, the states, pull to refresh, the pick
/// on the open Duo (`placePick`) and the list's top row kept by its route (`placeTop`). The caller keeps
/// its own rows, filter and words; the frame owns no data.
///
/// States: the first load draws the rows' shape, redacted, never a centred spinner in an empty list;
/// empty is `ContentUnavailableView` with the caller's words; a read that failed keeps what shows and adds
/// one line with Try Again above it.
struct WorkPlaceScreen<Rows: View>: View {
    let place: WorkPlace
    /// The job the route narrows the place to; with the place, it names the list's memory.
    var job: String?
    /// The rows' ids in the list's order: the top row is kept by these, and a pick is one of them. Each
    /// row carries its id as its identity (`ForEach` over the same ids) so the list can scroll to it.
    let ids: [String]
    /// The ids the list draws as rows, where `ids` holds more (Today's sections, which make the list never empty): the
    /// only ones its top row comes back to. Nil: `ids`.
    var tops: [String]?
    /// Nothing has arrived yet.
    var loading = false
    var empty: PlaceEmpty
    /// The read that failed, in the host's words; the rows that came before stay.
    var failure: String?
    var retry: (() async -> Void)?
    /// The jobs the filter offers, with the pick the caller keeps; no filter when either is missing.
    var jobs: [PlaceJob] = []
    var filter: Binding<String?>?
    var search: Binding<String>?
    var refresh: (() async -> Void)?
    /// What the open Duo picks for the detail when nothing is picked; nil for a list that picks nothing.
    var pick: PlacePick?
    @ViewBuilder let rows: () -> Rows

    var body: some View {
        let _ = PerfCounters.bump(.workPlaceBody)
        let route = Route.place(place, job: job)
        let firstLoad = loading && ids.isEmpty && failure == nil
        List {
            if let failure {
                Section { FailedRead(words: failure, retry: retry) }
            }
            if firstLoad {
                PlaceholderRows()
            } else {
                rows()
            }
        }
        .listStyle(.plain)
        .overlay {
            if !loading, ids.isEmpty, failure == nil {
                ContentUnavailableView(empty.title, systemImage: place.glyph, description: empty.line.map { Text($0) })
            }
        }
        .refreshing(refresh)
        .searching(search)
        .toolbar {
            if !jobs.isEmpty, let filter {
                ToolbarItem(placement: .primaryAction) { JobFilter(jobs: jobs, pick: filter) }
            }
        }
        .navigationTitle(place.title)
        .shellTitleDisplay()
        .placeTop(route, ids: tops ?? ids)
        .placePick(route, ids: ids, pick: pick)
        .listOnScreen("place.\(place.rawValue)")
        // The proof's ready file once the list has its first answer (TestHooks; nothing in a Release build).
        .onChange(of: loading ? "" : "\(ids.count)|\(failure != nil)", initial: true) { _, settled in
            if !settled.isEmpty { TestHooks.recordPlaceLoaded(place.rawValue, rows: ids.count, failed: failure != nil) }
        }
    }
}

/// An empty place's words: a title in the place's own terms, and at most one line under it.
struct PlaceEmpty {
    var title: String
    var line: String?
}

/// A job the filter offers: a Work workspace's entry, its name and its sector's dot.
struct PlaceJob: Identifiable, Hashable {
    var id: String
    var name: String
    var sector: String?
}

/// What a list in the sidebar picks for the detail on the open Duo (`ShellSelection`).
struct PlacePick {
    /// The rows to pick from, in order, those that need him first.
    var first: [String]
    /// The row the detail's root shows, by its id; nil for a root that is none of this list's rows.
    var rowOf: (Route) -> String?
    /// Opens a row in the detail through the navigator: a read, never an outward act.
    var open: (String) -> Void
}

extension View {
    /// The open Duo's pick (`ShellSelection.decide`): with the detail empty the list opens its first row
    /// that needs him; a pick still in the list stays; a pick whose row left makes way for the next, or the
    /// detail clears. Decided when the list's rows or the pose change, never in a body.
    @ViewBuilder
    func placePick(_ list: Route, ids: [String], pick: PlacePick?) -> some View {
        if let pick {
            modifier(PlacePicking(list: list, ids: ids, pick: pick))
        } else {
            self
        }
    }

    /// The list's top row kept in the navigator's memory by its route (`ShellNavigator.tops`), so a list a fold
    /// or a pose change builds again comes back at its row. Written once a scroll settles, never under a moving
    /// finger. `ScrollPosition` reads the settled top; a `ScrollViewReader` brings the list back to it.
    func placeTop(_ list: Route, ids: [String]) -> some View {
        modifier(PlaceTop(route: ShellPaths.identity(of: list), ids: ids))
    }

    /// The row the detail shows wears the selected fill, in the split poses only: there is no beside in a stack.
    func placeSelected(_ selected: Bool) -> some View {
        modifier(PlaceSelected(selected: selected))
    }
}

private struct PlacePicking: ViewModifier {
    @Environment(ShellNavigator.self) private var navigator
    @Environment(\.shellPose) private var pose
    let list: Route
    let ids: [String]
    let pick: PlacePick

    func body(content: Content) -> some View {
        content
            .onChange(of: ids, initial: true) { apply() }
            .onChange(of: pose) { apply() }
            #if DEBUG
            .onChange(of: pickedWord, initial: true) { LayoutProbe.note("work.picked", pickedWord) }
            #endif
    }

    private var detail: ShellSelection.Detail {
        guard let root = navigator.detailRoot else { return .empty }
        return pick.rowOf(root).map(ShellSelection.Detail.row) ?? .other
    }

    private func apply() {
        let onScreen = navigator.sidebarPath.last?.current == list
        switch ShellSelection.decide(first: pick.first, present: Set(ids), detail: detail, pose: pose, onScreen: onScreen) {
        case .keep:
            break
        case .open(let id):
            pick.open(id)
        case .clear:
            navigator.detailRoot = nil
            navigator.detailStack = NavigationPath()
        }
    }

    #if DEBUG
    /// The picked row's id, `other` for a detail that is none of this list's, `none` for an empty one.
    private var pickedWord: String {
        switch detail {
        case .row(let id): id
        case .other: "other"
        case .empty: "none"
        }
    }
    #endif
}

private struct PlaceTop: ViewModifier {
    @Environment(ShellNavigator.self) private var navigator
    let route: String
    let ids: [String]
    @State private var position = ScrollPosition(idType: String.self)
    /// This list has been brought to its remembered row, or had none to come back to.
    @State private var restored = false

    func body(content: Content) -> some View {
        ScrollViewReader { proxy in
            content
                .scrollPosition($position, anchor: .top)
                // One write a settled scroll: the phase turns idle once the finger and the deceleration stop.
                .onScrollPhaseChange { _, phase in
                    if phase == .idle { settled() }
                }
                .onChange(of: ids, initial: true) { restore(proxy) }
        }
    }

    /// The row at the top once the list stops, into the navigator's memory when it moved.
    private func settled() {
        guard let top = position.viewID(type: String.self), navigator.tops[route] != top else { return }
        navigator.tops[route] = top
        #if DEBUG
        LayoutProbe.note("work.top", top)
        #endif
    }

    /// Built again (a fold, a pose change, a return): back to the row it showed, once that row is in.
    /// A List lays out its rows after the change that brought them, and a scroll asked before that is
    /// lost, so the reader scrolls on the main actor's next turn.
    private func restore(_ proxy: ScrollViewProxy) {
        guard !restored, !ids.isEmpty else { return }
        restored = true
        // Only a row the list draws (`PlaceTopRules`): a scroll to any other id ends the app in UIKit.
        var target = PlaceTopRules.target(kept: navigator.tops[route], rows: ids)
        #if DEBUG
        if let index = TestHooks.placeTop, ids.indices.contains(index), TestHooks.once("place-top") {
            target = ids[index]
            navigator.tops[route] = ids[index]
        }
        #endif
        guard let target else { return }
        Task { @MainActor in
            await Task.yield()
            PerfCounters.bump(.offsetWrites) // the list check counts the app's own scrolls under a moving finger
            proxy.scrollTo(target, anchor: .top)
            #if DEBUG
            LayoutProbe.note("work.top", target)
            #endif
        }
    }
}

private struct PlaceSelected: ViewModifier {
    @Environment(\.shellPose) private var pose
    let selected: Bool

    func body(content: Content) -> some View {
        content.listRowBackground(pose.isSplit && selected ? Surface.groupSelected : nil)
    }
}

/// The host's words for a read that failed, and Try Again, which reads again; what showed stays below.
private struct FailedRead: View {
    let words: String
    let retry: (() async -> Void)?
    @State private var reading = false

    var body: some View {
        HStack(spacing: Layout.rowGap) {
            Text(words)
                .textStep(.meta)
                .lineLimit(2)
            Spacer(minLength: Layout.rowGap)
            if let retry {
                if reading {
                    ProgressView()
                } else {
                    PillButton("Try Again") {
                        Task {
                            reading = true
                            await retry()
                            reading = false
                        }
                    }
                }
            }
        }
        .padding(.vertical, Layout.rowVertical)
        .frame(minHeight: Layout.rowHeight)
        .listRowInsets(Layout.rowInsets)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("place-failed")
    }
}

/// The first load: the rows' shape (the mark slot, a title, a line under it, the stamp), redacted, so the
/// list arrives in its own layout rather than behind a spinner.
private struct PlaceholderRows: View {
    var body: some View {
        ForEach(0..<6, id: \.self) { _ in
            HStack(spacing: Layout.rowGap) {
                Image(systemName: "circle.fill")
                    .font(.footnote)
                    .frame(width: Layout.glyphWidth + Layout.markWidth)
                VStack(alignment: .leading, spacing: 2) {
                    Text("A place’s row title").textStep(.title)
                    Text("Its line under the title").textStep(.meta)
                }
                Spacer(minLength: Layout.rowGap)
                Text("9:41 AM").textStep(.stamp)
            }
            .padding(.vertical, Layout.rowVertical)
            .frame(minHeight: Layout.rowHeight + 8)
            .listRowInsets(Layout.rowInsets)
        }
        .redacted(reason: .placeholder)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// All Jobs, then each job by name with its sector's dot. The pick is the caller's. Without `all` (a place
/// read per job, `LifeReach`) there is no All Jobs and one job is always picked.
struct JobFilter: View {
    let jobs: [PlaceJob]
    @Binding var pick: String?
    var all = true

    var body: some View {
        Menu {
            Picker("Job", selection: $pick) {
                if all { Text("All Jobs").tag(String?.none) }
                ForEach(jobs) { job in
                    Label { Text(job.name) } icon: { Self.dot(job.sector) }
                        .tag(Optional(job.id))
                }
            }
        } label: {
            // Filled while the list is narrowed: per job it always is, so the glyph stays plain there.
            Label("Job", systemImage: pick == nil || !all ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
        }
        .accessibilityValue(pick.flatMap { id in jobs.first { $0.id == id }?.name } ?? "All Jobs")
        .accessibilityIdentifier("place-job-filter")
    }

    /// A menu draws its items' images as templates: the dot keeps its sector's hue as an image of its own colour.
    private static func dot(_ sector: String?) -> Image {
        let hue = UIColor(Tint.sector(sector))
        guard let symbol = UIImage(systemName: "circle.fill")?.withTintColor(hue, renderingMode: .alwaysOriginal) else {
            return Image(systemName: "circle.fill")
        }
        return Image(uiImage: symbol)
    }
}

private extension View {
    @ViewBuilder
    func refreshing(_ action: (() async -> Void)?) -> some View {
        if let action {
            refreshable { await action() }
        } else {
            self
        }
    }

    @ViewBuilder
    func searching(_ text: Binding<String>?) -> some View {
        if let text {
            searchable(text: text)
        } else {
            self
        }
    }
}
