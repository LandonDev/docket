import SwiftUI
import TempCodeClient
import UIKit

/// One tab's container in every pose: a `NavigationSplitView` that SwiftUI
/// collapses to a stack in compact width and expands in regular width. The
/// view tree is the same before and after a fold, so the detail keeps its
/// identity and its state (a typed draft, a rename, the segment). The
/// sidebar is the tab's list stack on `navigator.sidebarPath`; the detail is
/// a stack on `navigator.detailStack` over the route at `navigator.detailRoot`,
/// or the placeholder when nothing is open. A project's shell keeps its
/// identity while its thread changes (`ShellPaths.identity(of:)`).
///
/// The style is the system's automatic one, which is `SidebarMode`'s rule:
/// the sidebar tiles beside the detail when the window is wider than tall
/// and overlays it behind the system toggle when taller than wide.
/// `columnVisibility` always carries the expanded preference (the remembered
/// toggle), never the collapsed state, so the sidebar arrives with the
/// expansion and never flickers in.
struct ShellSplit<Sidebar: View, Placeholder: View, Destination: View>: View {
    @Bindable var navigator: ShellNavigator
    @ViewBuilder let sidebar: () -> Sidebar
    @ViewBuilder let placeholder: () -> Placeholder
    @ViewBuilder let destination: (Route) -> Destination
    /// The device partially open (tabletop): the seam sits on the fold.
    @State private var halfOpen = false
    /// Where the window's centre line (the fold) falls in this split's own coordinates.
    @State private var foldX: CGFloat = 0

    /// The desktop's 260 pt workspace column (`SidebarColumn`), the fold's when half open.
    private var sidebarColumn: SidebarColumn { SidebarColumn.of(halfOpen: halfOpen, foldX: foldX) }

    var body: some View {
        // Read so a stray split (`ShellNavigator.visibilityAsk`) reads its binding again: the split's own value for one
        // turn, then the shell's (`SplitAnswer`).
        let _ = navigator.visibilityAsk
        let _ = navigator.splitAnswer
        NavigationSplitView(columnVisibility: visibility, preferredCompactColumn: compactColumn) {
            NavigationStack(path: $navigator.sidebarPath) {
                // The shell's own sidebar button on every page of the column, the root and each page pushed over it,
                // where the system's toggle stood (`SidebarButtonItem`): his press is its action, never guessed from
                // the binding's timing (`ShellNavigator.pressSidebar`).
                sidebar()
                    .modifier(SidebarButtonItem(navigator: navigator, column: .sidebar))
                    .navigationDestination(for: Route.self) { destination($0).modifier(SidebarButtonItem(navigator: navigator, column: .sidebar)) }
            }
            // Every page of the column, a screen's own pushes among them, finds its column here (`sidebarButtonPage`).
            .environment(\.sidebarButtonColumn, SidebarButtonColumn(navigator: navigator, column: .sidebar))
            .navigationSplitViewColumnWidth(min: sidebarColumn.min, ideal: sidebarColumn.ideal, max: sidebarColumn.max)
            #if DEBUG
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { if probed { LayoutProbe.note("sidebar.width", String(Int($0.rounded()))) } }
            #endif
        } detail: {
            NavigationStack(path: $navigator.detailStack) {
                Group {
                    if let root = navigator.detailRoot {
                        destination(root)
                    } else {
                        placeholder()
                    }
                }
                // A new root is a new screen; the same root through a fold is the same one, and a
                // project's shell is one screen whichever thread it shows.
                .id(ShellPaths.identity(of: navigator.detailRoot))
                .modifier(SidebarButtonItem(navigator: navigator, column: .detail))
                .navigationDestination(for: Route.self) { destination($0).modifier(SidebarButtonItem(navigator: navigator, column: .detail)) }
                // At the stack's root, not on Hosts: a push made while Hosts itself was still
                // arriving (the proof's hook) found no destination and drew the warning glyph.
                .navigationDestination(for: HostDetailRoute.self) {
                    HostDetailView(environmentId: $0.environmentId).modifier(SidebarButtonItem(navigator: navigator, column: .detail))
                }
            }
            .environment(\.sidebarButtonColumn, SidebarButtonColumn(navigator: navigator, column: .detail))
        }
        // A LifeOS screen's mail thread is pushed onto the split's stack, hoisted out of LifeKitUI's own.
        .lifeHostEnvironment()
        // The fold is the window's centre line; the split may start short of the window's leading edge.
        .onGeometryChange(for: CGFloat.self) { navigator.windowWidth / 2 - $0.frame(in: .global).minX } action: { foldX = $0 }
        .background { HingeWatch(halfOpen: $halfOpen) }
        // Its own writes as it appears are never his toggle (`ShellPose.keepsVisibilityWrite`'s `sinceShown`).
        .onAppear { navigator.splitAppeared(true) }
        #if DEBUG
        .task { await proofSidebarTap() }
        #endif
        .onDisappear { navigator.splitAppeared(false) }
        #if DEBUG
        // The Duo proof's notes (the split of the tab on screen, Home's or Work's): the split's own
        // width, the column the sidebar and the detail share, and the sidebar's state.
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { if probed { LayoutProbe.note("split.width", String(Int($0.rounded()))) } }
        .onChange(of: sidebarWord, initial: true) { if probed { LayoutProbe.note("sidebar", sidebarWord) } }
        .onChange(of: chosenWord, initial: true) { if probed { LayoutProbe.note("sidebar.chosen", chosenWord) } }
        #endif
    }

    #if DEBUG
    private var probed: Bool { navigator.focused && navigator.tab != .search }

    /// `stack` collapsed, `visible` tiled beside the detail, `overlay` over it, `hidden` behind the toggle.
    private var sidebarWord: String {
        switch navigator.pose {
        case .stack: "stack"
        case .split(let mode): navigator.sidebarVisible ? (mode == .tiled ? "visible" : "overlay") : "hidden"
        }
    }

    /// His own toggle for the tab, which a wide route never writes: `shown` or `hidden`.
    private var chosenWord: String { navigator.sidebarShown ? "shown" : "hidden" }
    #endif

    #if DEBUG
    /// `TC_TEST_ACTION=sidebar-tap`: the button's own action pressed as soon as Work's split stands in a split pose,
    /// inside the startup writes' half second (the m0 part's check).
    private func proofSidebarTap() async {
        guard TestHooks.action == "sidebar-tap", navigator.tab == .work else { return }
        for _ in 0..<ShellPose.settleTries * 10 where !navigator.pose.isSplit {
            try? await Task.sleep(for: .seconds(ShellPose.echoTurn / 2))
        }
        guard navigator.pose.isSplit else { return }
        // The button stands where he would press it (the Outbox's list, pushed in the sidebar): drawn in the bar of the
        // column the toggle sits in, before the action runs.
        let column: SidebarButtonItem.Column = navigator.splitShown ? .sidebar : .detail
        for _ in 0..<ShellPose.settleTries * 10 where SidebarButtonProbe.count(navigator.tab, column) == 0 {
            try? await Task.sleep(for: .seconds(ShellPose.echoTurn / 2))
        }
        let before = navigator.sidebarShown ? "shown" : "hidden"
        let at = Int((navigator.sinceShown * 1000).rounded())
        let drawn = "sidebar \(SidebarButtonProbe.count(navigator.tab, .sidebar)) detail \(SidebarButtonProbe.count(navigator.tab, .detail))"
        navigator.pressSidebar()
        LayoutProbe.note("sidebar.press", "\(before) -> \(navigator.sidebarShown ? "shown" : "hidden") at \(at) ms with \(drawn)")
    }
    #endif

    /// The expanded preference: the remembered toggle, hidden by a wide route
    /// unless he brought it back there (`ShellNavigator.sidebarVisible`),
    /// whatever the collapsed state. The split's own writes around a fold are
    /// dropped (`ShellPose.keepsVisibilityWrite`), and one made just before a
    /// fold is held until the pose has held after it (`ShellNavigator.holdSidebarWrite`).
    private var visibility: Binding<NavigationSplitViewVisibility> {
        Binding(
            get: { navigator.splitShown ? .all : .detailOnly },
            set: { value in
                // A fold writes the split's visibility as it collapses and expands; only the person's toggle is kept.
                let kept = ShellPose.keepsVisibilityWrite(pose: navigator.pose, sincePoseChange: Date().timeIntervalSince(navigator.poseChangedAt), sinceShown: navigator.sinceShown)
                #if DEBUG
                if probed { LayoutProbe.note("sidebar.write", "\(value == .detailOnly ? "detailOnly" : "shown") \(kept ? "kept" : "dropped")") }
                #endif
                navigator.splitWrote(value != .detailOnly, kept: kept)
                // A write that only repeats what is shown is the split settling, not his press.
                if kept, (value != .detailOnly) != navigator.sidebarVisible { navigator.holdSidebarWrite(value != .detailOnly) }
            }
        )
    }

    /// Collapsed: the detail while something is open, else the sidebar. Back
    /// from the detail's root sets `.sidebar`, which clears what was open.
    private var compactColumn: Binding<NavigationSplitViewColumn> {
        Binding(
            get: { navigator.detailRoot == nil ? .sidebar : .detail },
            set: { column in
                guard column == .sidebar, navigator.detailRoot != nil else { return }
                navigator.detailRoot = nil
                navigator.detailStack = NavigationPath()
            }
        )
    }
}

/// The shell's sidebar button on one page of a column, in place of the system's toggle, on the side the toggle used:
/// the sidebar's bar at its trailing edge while the sidebar shows, the detail's at its leading edge while it does not
/// (the overlay pose keeps it there under the overlay too). Never in a stack. Every page of each column wears it, the
/// root and each page pushed over it, so the system's toggle never comes back on a pushed page.
struct SidebarButtonItem: ViewModifier {
    typealias Column = SidebarButtonPlace.Column

    let navigator: ShellNavigator
    let column: Column

    private var shows: Bool { SidebarButtonPlace.shows(in: column, pose: navigator.pose, sidebarShown: navigator.splitShown) }

    func body(content: Content) -> some View {
        content
            .toolbar(removing: .sidebarToggle)
            .toolbar {
                if shows {
                    ToolbarItem(placement: SidebarButtonPlace.edge(of: column) == .trailing ? .topBarTrailing : .topBarLeading) {
                        Button(navigator.splitShown ? "Hide Sidebar" : "Show Sidebar", systemImage: "sidebar.leading") { navigator.pressSidebar() }
                            .accessibilityIdentifier("shell-sidebar-button")
                            #if DEBUG
                            .onAppear { SidebarButtonProbe.moved(navigator, column, by: 1) }
                            .onDisappear { SidebarButtonProbe.moved(navigator, column, by: -1) }
                            #endif
                    }
                }
            }
    }
}

/// A column of the split, as each page in it reads it: the pages a screen pushes itself (Page Preview, a thread's diff,
/// report, HTML render, agents list, a version compare, an agent's detail) wear the shell's sidebar button too, where
/// the system's toggle stood on every page of the column (council 13, Opus 2.1).
struct SidebarButtonColumn {
    let navigator: ShellNavigator
    let column: SidebarButtonItem.Column
}

extension EnvironmentValues {
    @Entry var sidebarButtonColumn: SidebarButtonColumn? = nil
}

/// The shell's sidebar button on a page a screen pushes itself, in the column it is pushed in; nothing outside a split's
/// column (a sheet, a stack of its own).
private struct SidebarButtonPage: ViewModifier {
    @Environment(\.sidebarButtonColumn) private var column

    func body(content: Content) -> some View {
        if let column {
            content.modifier(SidebarButtonItem(navigator: column.navigator, column: column.column))
        } else {
            content
        }
    }
}

extension View {
    /// The shell's sidebar button on a page this screen pushes itself (`SidebarButtonPage`).
    func sidebarButtonPage() -> some View { modifier(SidebarButtonPage()) }
}

#if DEBUG
/// The proofs' count of the shell's sidebar buttons in each column's bar, per tab (`sidebar.buttons.<column>`): a
/// toolbar item appears only while its page is the top one of a column that shows.
@MainActor
enum SidebarButtonProbe {
    private static var drawn: [String: Int] = [:]

    static func count(_ tab: AppTab, _ column: SidebarButtonItem.Column) -> Int { drawn["\(tab).\(column.rawValue)"] ?? 0 }

    static func moved(_ navigator: ShellNavigator, _ column: SidebarButtonItem.Column, by delta: Int) {
        let key = "\(navigator.tab).\(column.rawValue)"
        drawn[key] = max(0, (drawn[key] ?? 0) + delta)
        if navigator.focused { LayoutProbe.note("sidebar.buttons.\(column.rawValue)", String(drawn[key] ?? 0)) }
    }
}
#endif

/// The fold's division (iOS 27.1): while the hinge is partially open the
/// two panels are a tabletop and the sidebar takes the left one, so the
/// seam sits on the fold; fully open or closed the 320 pt ideal holds. The
/// SDK's hinge read is `UIHingeInteraction` (status and angle; no region),
/// and the inner display's panels are equal, so the window's centre line is
/// the fold. An ideal, never a forced width: a forced one makes the split
/// write its own visibility back.
private struct HingeWatch: UIViewRepresentable {
    @Binding var halfOpen: Bool

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.isUserInteractionEnabled = false
        if #available(iOS 27.1, *) {
            view.addInteraction(UIHingeInteraction { _, update in
                let open = update.hinge?.status == .partiallyOpen
                if open != halfOpen { halfOpen = open }
            })
        }
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {}
}

/// The detail's empty state: a title only, no description and no button;
/// the list is beside it and the shell never opens a thread the person did
/// not pick.
struct DetailPlaceholder: View {
    let title: LocalizedStringKey
    let symbol: String

    var body: some View {
        ContentUnavailableView(title, systemImage: symbol)
    }
}
