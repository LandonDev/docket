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

/// Home's row while anything is being driven on a connected host, shaped as the Outbox row: the glyph in the mark
/// slot and "Computers". It carries no count (the desktop's rail row carries none either).
struct ComputersHomeRow: View {
    @Environment(ShellNavigator.self) private var navigator
    @ScaledMetric(relativeTo: .subheadline) private var icon: CGFloat = 28

    var body: some View {
        Button { navigator.open(.computers) } label: {
            HStack(spacing: Layout.rowGap + 2) {
                Image(systemName: ComputersGlyph.row)
                    .font(TextStep.title.font.weight(.medium))
                    .foregroundStyle(.secondary)
                    .frame(width: icon, height: icon)
                Text("Computers")
                    .textStep(.title, weight: .medium)
                Spacer(minLength: 8)
            }
            .padding(.vertical, 8)
            .frame(minHeight: Layout.rowHeight + 8)
            .contentShape(Rectangle())
            .separatorAtTextEdge(icon + Layout.rowGap + 2)
        }
        .buttonStyle(.pressable)
        .listRowInsets(Layout.rowInsets)
        .accessibilityIdentifier("home-computers")
    }
}

enum ComputersGlyph {
    /// a held computer act's glyph (`WorkGlyph` for `.computerAct`): the same machine
    static let row = "macwindow"
}

/// The Computers list (docs/IOS-DESIGN.md "Work on the phone"): a tile per live session, the one that acted last
/// first: the picture at the list's width, live where the host gives a stream and one muted line where it does not;
/// the thread's title, which opens the thread; what it is doing and where it runs. A tap on the picture opens it full
/// screen, where Take Over, Hand Back and Stop are.
struct ComputersScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(ShellNavigator.self) private var navigator

    var body: some View {
        let clients = model.registry.ordered
        let tiles = ComputerEntries.tiles(clients)
        List {
            ForEach(tiles) { tile in
                if let client = clients.first(where: { $0.environment.id == tile.host }) {
                    Section { ComputerTileView(client: client, tile: tile) }
                }
            }
        }
        .listStyle(.insetGrouped)
        .overlay {
            if tiles.isEmpty {
                ContentUnavailableView("Nothing Is Being Driven", systemImage: ComputersGlyph.row, description: Text("A browser or an app an agent is using shows here, live."))
            }
        }
        .navigationTitle("Computers")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("computers")
        #if DEBUG
        .onChange(of: tiles.count, initial: true) { _, count in LayoutProbe.note("computerTiles", "\(count)") }
        #endif
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
                    Text(meta)
                        .textStep(.meta)
                        .lineLimit(1)
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

    /// What it is doing (or that he drives it) and where it runs, said once (`tileLine` and `Facts` on the desktop).
    private var meta: String {
        let line = tile.driving ? "You are driving" : tile.doing
        return [line, tile.place].compactMap { $0 }.joined(separator: " · ")
    }
}
