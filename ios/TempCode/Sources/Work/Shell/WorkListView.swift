import SwiftUI
import TempCodeClient
import TempCodeContract

/// The Work list: the Work tab's root, and the left column on the open Duo.
/// The places for every job at once, then a row a job, Work Chats, and the
/// foot (Review, the Digest, Computers while something is driven or a host keeps
/// the Windows VM, Connections while one does not work). A place pushes its
/// list in this column; what he picks there opens in the detail. The rows and
/// their order are the client package's `WorkList.sections`; a place has a row
/// only once this build draws it (`WorkPlace.shipped`).
struct WorkListView: View {
    @Environment(AppModel.self) private var model
    @Environment(ShellNavigator.self) private var navigator
    /// New Work workspace, from the Jobs header's +.
    @State private var addingWork = false

    var body: some View {
        let clients = model.registry.ordered
        let work = HomeSections.home(hosts: HomeRows.inputs(clients)).work
        // Computers while something is driven or a host keeps the Windows VM; Connections while one does not work (M5b).
        let computers = !ComputerEntries.tiles(clients).isEmpty || clients.contains { $0.work.isOn && WinvmWords.shows($0.work.winvm) }
        let list = WorkList.sections(work: work, driving: computers, broken: ConnectionsFeed.shared.needsHim)
        List {
            Section {
                ForEach(list.places, id: \.self) { place in
                    WorkPlaceRow(place: place, count: place == .outbox ? OutboxEntries.count(clients) : 0, line: place == .today ? TodayFeed.store.line : nil)
                }
            }
            Section {
                ForEach(list.jobs) { WorkspaceEntryRow(entry: $0) }
            } header: {
                SectionHeader("Jobs") {
                    // Each entry only where some host's key may do it (KeyMay): never a press the host refuses.
                    if clients.contains(where: { $0.work.isOn && $0.work.may(.workspaceCreate) }) {
                        Button("New Job", systemImage: "plus") { addingWork = true }
                            .labelStyle(.iconOnly)
                            .font(TextStep.meta.font.weight(.semibold))
                            // An explicit ink, as the band's title: the hierarchical secondary nests a step dimmer
                            // inside a section header and drew this, the phone's one way to make a job, near 1.9:1.
                            .foregroundStyle(Color(.secondaryLabel))
                            .frame(minWidth: Layout.rowHeight, minHeight: Layout.rowHeight)
                            .contentShape(Rectangle())
                            .buttonStyle(.pressable)
                            .accessibilityIdentifier("new-work-workspace")
                    }
                }
                .listRowInsets(EdgeInsets())
            }
            Section {
                if let chats = list.chats { WorkspaceEntryRow(entry: chats) }
                ForEach(list.foot, id: \.self) { WorkPlaceRow(place: $0) }
                // While a show runs on one of his computers: its clicker, one row a computer.
                ForEach(clients.filter { $0.work.isOn && $0.work.may(.slidesShowPress) }, id: \.environment.id) { client in
                    if let live = ShowRows.running(Array(client.work.shows.values)) { ShowingRow(client: client, live: live) }
                }
            }
        }
        .listStyle(.plain)
        .listSectionSpacing(10)
        .navigationTitle("Work")
        .shellTitleDisplay()
        .toolbar {
            // Capture (Work/Capture): one sheet for a note typed or said, a receipt, a photo or a file.
            if CaptureButton.offered(clients) {
                ToolbarItem(placement: .primaryAction) { CaptureButton() }
            }
            ToolbarItem(placement: .primaryAction) {
                Button("Work Settings", systemImage: "gearshape") { navigator.open(.workSettings) }
            }
            .highVisibility()
        }
        .listOnScreen("work")
        // Today's line on its row comes from Today's own store, fed from here before Today first opens.
        .task { TodayFeed.start(model.registry) }
        // Connections and the VM's state, read when the list shows (the feed waits a few minutes between reads).
        .task(id: clients.filter { $0.work.isOn && $0.work.linked }.map(\.environment.id)) {
            await ConnectionsFeed.shared.read(clients)
            for client in clients where client.work.isOn && client.work.linked && client.work.winvm == nil && client.work.may(.winvmState) {
                _ = try? await client.work.winvmState()
            }
        }
        .sheet(isPresented: $addingWork) { NewWorkWorkspaceSheet() }
        #if DEBUG
        .task(id: model.ready) { if model.ready, TestHooks.sheet == "new-work" { try? await Task.sleep(for: .seconds(2)); addingWork = true } }
        #endif
    }
}

/// A place's row on the Work list: its glyph in the 28 pt mark slot, its
/// name, and what waits there as a plain stamp. Held is not Needs you, so a
/// count is never amber. Today's row says the day on a second line
/// (`TodayModel.workListLine`: "Budget sync at 2:00 PM", else what is due), never the
/// Outbox's count beside it.
struct WorkPlaceRow: View {
    @Environment(ShellNavigator.self) private var navigator
    @Environment(\.dynamicTypeSize) private var typeSize
    let place: WorkPlace
    var count = 0
    /// The line under the name; only Today's row has one.
    var line: String?
    @ScaledMetric(relativeTo: .subheadline) private var icon: CGFloat = 28

    var body: some View {
        Button { navigator.open(.place(place)) } label: {
            HStack(spacing: Layout.rowGap + 2) {
                Image(systemName: place.glyph)
                    .font(TextStep.title.font.weight(.medium))
                    .foregroundStyle(.secondary)
                    .frame(width: icon, height: icon)
                VStack(alignment: .leading, spacing: 2) {
                    Text(place.title)
                        .textStep(.title, weight: .medium)
                    if let line {
                        Text(line)
                            .textStep(.meta)
                            // Wraps at accessibility sizes: "Budget sync at 2:00 PM" read whole, not cut short.
                            .lineLimit(typeSize.isAccessibilitySize ? 3 : 1)
                    }
                }
                Spacer(minLength: 8)
                if count > 0 {
                    // The stamp step in `label`: the hierarchical tertiary measured 1.7:1 on white (IOS-DESIGN "Work on the phone").
                    Text(count, format: .number)
                        .textStep(.stamp, tint: Color(.label))
                        .contentTransition(.numericText())
                }
            }
            .padding(.vertical, 8)
            .frame(minHeight: Layout.rowHeight + 8)
            .contentShape(Rectangle())
            .separatorAtTextEdge(icon + Layout.rowGap + 2)
        }
        .buttonStyle(.pressable)
        .listRowInsets(Layout.rowInsets)
        .animation(Motion.numeric, value: count)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(count > 0 ? "\(place.title), \(count) \(place == .outbox ? "held" : "waiting")" : [place.title, line].compactMap { $0 }.joined(separator: ", "))
        .accessibilityIdentifier("work-\(place.rawValue)")
    }
}

extension WorkPlace {
    /// The place's name: its row, its list's title.
    var title: String {
        switch self {
        case .today: "Today"
        case .outbox: "Outbox"
        case .mail: "Mail"
        case .messages: "Messages"
        case .tasks: "Tasks"
        case .agenda: "Agenda"
        case .files: "Files"
        case .people: "People"
        case .review: "Review"
        case .digest: "Digest"
        case .computers: "Computers"
        case .connections: "Connections"
        }
    }

    /// One SF Symbol a place, the same wherever the place is named.
    var glyph: String {
        switch self {
        case .today: "sun.max"
        case .outbox: WorkGlyph.outbox
        case .mail: "envelope"
        case .messages: "bubble.left.and.bubble.right"
        case .tasks: "checkmark.circle"
        case .agenda: "calendar"
        case .files: "folder"
        case .people: "person.2"
        case .review: "chart.bar.doc.horizontal"
        case .digest: DigestScreen.glyph
        case .computers: ComputersGlyph.row
        case .connections: "link"
        }
    }
}

/// A place's list in the sidebar column (`Route.place`). `job` narrows a place
/// to one Work workspace where the place can be narrowed.
struct WorkPlaceList: View {
    let place: WorkPlace
    let job: String?

    var body: some View {
        switch place {
        case .outbox: OutboxScreen()
        case .digest: DigestScreen()
        case .computers: ComputersScreen()
        case .today: TodayScreen()
        // LifeOS's own screens for every job, in the detail (`ShellPaths.lifePlaces`); Mail with its Waiting On.
        case .mail: LifePlaceScreen(view: .mail, job: job)
        case .tasks: LifePlaceScreen(view: .tasks, job: job)
        case .agenda: LifePlaceScreen(view: .agenda, job: job)
        // Every job's conversations in the sidebar; one opens in the detail (`Route.chat`).
        case .messages: MessagesScreen(job: job)
        // Every job's people in the sidebar; a person's page opens in the detail (`Route.person`).
        case .people: PeopleScreen(job: job)
        // Every job's places in the sidebar; a folder pushes there (`Route.folder`), a file opens in the detail.
        case .files: FilesPlaceScreen(job: job)
        // The week across every job in the sidebar; a row's thing opens in the detail (Work/Review).
        case .review: ReviewScreen()
        // Each host's sign-ins and helpers, while one does not work (Work/Places, M5b).
        case .connections: ConnectionsScreen()
        }
    }
}
