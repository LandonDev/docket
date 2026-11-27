import SwiftUI
import TempCodeClient
import TempCodeContract

/// Every computer being driven now, on every connected host (`useComputers` in src/renderer/src/lib/computers.ts):
/// each host's rows, joined to its threads' titles.
@MainActor
enum ComputerEntries {
    static func tiles(_ clients: [EnvironmentClient]) -> [ComputerTile] {
        let byId = Dictionary(clients.map { ($0.environment.id, $0) }, uniquingKeysWith: { first, _ in first })
        return ComputerTiles.tiles(
            byHost: byId.mapValues(\.computerRows),
            titleOf: { host, thread in byId[host]?.session(thread)?.title },
            nameOf: { host in byId[host]?.environment.name ?? host },
            paneOf: { host, thread in byId[host].map { pane(of: thread, on: $0) } ?? thread }
        )
    }

    /// The thread whose Work pane holds `thread`'s browser: its root, by the parent chain the phone holds (`threadRoot`).
    static func pane(of thread: String, on client: EnvironmentClient) -> String {
        var at = thread
        for _ in 0..<64 {
            guard let parent = client.session(at)?.parentId else { break }
            at = parent
        }
        return at
    }
}

/// The Work list's Computers row shows while anything is being driven on a connected host (`WorkList.sections`).
enum ComputersGlyph {
    /// a held computer act's glyph (`WorkGlyph` for `.computerAct`): the same machine
    static let row = "macwindow"
}

/// The Computers list (docs/IOS-DESIGN.md "Work on the phone"): the Windows VM a host keeps, with Wake and Sleep,
/// then a tile per live session, the one that acted last first: the picture at the list's width, live where the host gives a stream and one muted line where it does not;
/// the thread's title, which opens the thread; what it is doing and where it runs. A tap on the picture opens it full
/// screen, where Take Over, Hand Back and Stop are.
struct ComputersScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(ShellNavigator.self) private var navigator

    var body: some View {
        let clients = model.registry.ordered
        let tiles = ComputerEntries.tiles(clients)
        let machines = clients.filter { $0.work.isOn && WinvmWords.shows($0.work.winvm) }
        let hosts = clients.map { ComputersState.Host(name: $0.environment.name, linked: $0.work.linked, read: $0.computersRead, failure: $0.computersFailure) }
        let failed = clients.filter { $0.work.linked && $0.computersFailure != nil }
        List {
            // A connected host whose read failed: its words and Try Again, over whatever it said last.
            ForEach(failed, id: \.environment.id) { client in
                Section {
                    FailedRead(words: ComputersState.failedLine(WorkSearch.nameInLine(client.environment.name), failure: client.computersFailure ?? ""),
                               retry: { await client.readComputers() }, identifier: "computers-failed", tint: Tint.destructiveText)
                }
            }
            // The Windows VM a host keeps (M5b): how it stands, and Wake or Sleep for a key that may.
            ForEach(machines, id: \.environment.id) { client in
                if let state = client.work.winvm {
                    Section { WinvmRow(client: client, state: state) }
                }
            }
            ForEach(tiles) { tile in
                if let client = clients.first(where: { $0.environment.id == tile.host }) {
                    Section { ComputerTileView(client: client, tile: tile) }
                }
            }
            // Live tiles from one computer while another is away: the list says whose it is not, once, quietly.
            let away = ComputersState.away(hosts)
            if !(tiles.isEmpty && machines.isEmpty && failed.isEmpty), !away.isEmpty {
                Section {} footer: {
                    Text("Not connected to \(WorkSearch.nameInLine(ComputersState.names(away))).")
                        .textStep(.meta)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .listStyle(.insetGrouped)
        .overlay {
            if tiles.isEmpty, machines.isEmpty {
                // A failed read is its row above, a first read waits, hosts all away are named, and an idle list names
                // the ones away (`ComputersState`).
                switch ComputersState.of(hosts) {
                case .failed:
                    EmptyView()
                case .reading:
                    ProgressView()
                case .away(let names):
                    ContentUnavailableView("Not Connected to \(WorkSearch.nameInLine(ComputersState.names(names)))", systemImage: ComputersGlyph.row)
                case .idle(let away):
                    ContentUnavailableView("No Computer in Use", systemImage: ComputersGlyph.row,
                                           description: away.isEmpty ? nil : Text("Not connected to \(WorkSearch.nameInLine(ComputersState.names(away)))."))
                }
            }
        }
        .navigationTitle("Computers")
        // The pose's title, as the places beside it in the Work list's foot (Review, the Digest, Connections).
        .shellTitleDisplay()
        .accessibilityIdentifier("computers")
        #if DEBUG
        .onChange(of: tiles.count, initial: true) { _, count in LayoutProbe.note("computerTiles", "\(count)") }
        #endif
    }
}

/// The Windows VM: its name, how it stands in a few words (the step it is on while it moves, the last thing that went
/// wrong in the destructive ink), and the one press it offers: Wake while it sleeps, Sleep while it is awake. The
/// `work.winvm` push keeps the row in step while Wake waits for Windows.
private struct WinvmRow: View {
    let client: EnvironmentClient
    let state: WinvmStatePhone
    @State private var pressing = false
    @State private var error: String?

    var body: some View {
        HStack(spacing: Layout.rowGap) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Windows VM").textStep(.title, weight: .medium)
                Text(WinvmWords.line(state)).textStep(.meta).foregroundStyle(.secondary).lineLimit(2)
                if let error = error ?? state.error {
                    Text(error).textStep(.meta, tint: Tint.destructiveText).lineLimit(3)
                }
            }
            Spacer(minLength: 8)
            if pressing || WinvmWords.moving(state) {
                ProgressView()
            } else if let press = WinvmWords.press(state), client.work.may(press == .wake ? .winvmWake : .winvmSleep) {
                Button(press == .wake ? "Wake" : "Sleep") { Task { await run(press) } }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .accessibilityIdentifier("winvm-\(press == .wake ? "wake" : "sleep")")
            }
        }
        .frame(minHeight: Layout.rowHeight)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("winvm-row")
    }

    private func run(_ press: WinvmWords.Press) async {
        pressing = true
        error = nil
        defer { pressing = false }
        do {
            _ = try await (press == .wake ? client.work.wakeWinvm() : client.work.sleepWinvm())
        } catch {
            self.error = ActionError.wrap(error).message
        }
    }
}

private struct ComputerTileView: View {
    @Environment(ShellNavigator.self) private var navigator
    let client: EnvironmentClient
    let tile: ComputerTile

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            LivePicture(client: client, threadId: tile.threadId, place: tile.place)
            Button {
                navigator.open(.thread(environmentId: tile.host, sessionId: tile.threadId, seq: nil))
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(tile.title)
                        .textStep(.title, weight: .medium)
                        .lineLimit(1)
                    // What it is doing, then where it runs, told apart by weight, never joined with a dot.
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        if let doing { Text(doing).textStep(.meta).lineLimit(1) }
                        Text(tile.place).textStep(.meta, weight: .medium).lineLimit(1).layoutPriority(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.pressable)
            .accessibilityIdentifier("computer-tile-title")
        }
        .listRowInsets(EdgeInsets(top: 12, leading: Layout.textEdge, bottom: 12, trailing: Layout.textEdge))
        .accessibilityIdentifier("computer-tile")
    }

    /// What it is doing, or that he drives it (`tileLine` on the desktop); where it runs is said beside it.
    private var doing: String? { tile.driving ? "You are driving" : tile.doing }
}
