import LifeKit
import SwiftUI
import TempCodeClient
import TempCodeContract

/// The head of a Work workspace's screen (milestone 47): Mail, Tasks,
/// Agenda and Projects (the projects plan's milestone 8) on the Home row
/// grid, then Files (the files pillar's F9), then Routines, each opening its
/// screen. While LifeOS is out of reach the four LifeOS rows sit at half
/// strength.
struct WorkViewRows: View {
    let client: EnvironmentClient
    let workspace: WorkspaceMeta
    /// LifeOS on this host is signed out or out of reach.
    let dimmed: Bool

    var body: some View {
        ForEach(LifeViewScreen.Kind.allCases) { view in
            WorkViewRow(title: view.title, symbol: view.symbol, route: route(view.rawValue), id: "work-view-\(view.rawValue)")
                .opacity(dimmed ? 0.5 : 1)
        }
        WorkViewRow(title: "Files", symbol: "folder", route: route("files"), id: "work-view-files")
        WorkViewRow(title: "Routines", symbol: "clock.arrow.circlepath", route: route("routines"), id: "work-view-routines")
    }

    private func route(_ view: String) -> Route {
        .workView(environmentId: client.environment.id, workspaceId: workspace.id, view: view)
    }
}

/// One row of a Work workspace's head, on the Home row grid (WorkspaceEntryRow):
/// the glyph in the 28 pt mark slot, the name, no chevron; every row pushes.
struct WorkViewRow: View {
    @Environment(ShellNavigator.self) private var navigator
    let title: String
    let symbol: String
    let route: Route
    let id: String
    @ScaledMetric(relativeTo: .subheadline) private var icon: CGFloat = 28

    var body: some View {
        Button { navigator.open(route) } label: {
            HStack(spacing: Layout.rowGap + 2) {
                Image(systemName: symbol)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(width: icon, height: icon)
                Text(title)
                    .textStep(.title, weight: .medium)
                    .lineLimit(1)
                Spacer(minLength: 8)
            }
            .padding(.vertical, 8)
            .frame(minHeight: Layout.rowHeight + 8)
            .contentShape(Rectangle())
            .separatorAtTextEdge(icon + Layout.rowGap + 2)
        }
        .buttonStyle(.pressable)
        .listRowInsets(Layout.rowInsets)
        .accessibilityAddTraits(.isLink)
        .accessibilityIdentifier(id)
    }
}

/// Where a view row leads: the workspace's LifeOS screen, its Files, or its Routines.
struct WorkViewScreen: View {
    @Environment(AppModel.self) private var model
    let environmentId: String
    let workspaceId: String
    let view: String

    var body: some View {
        if let client = model.registry.client(environmentId), let workspace = client.workspaces.first(where: { $0.id == workspaceId }) {
            if let kind = LifeViewScreen.Kind(rawValue: view) {
                LifeViewScreen(host: WorkLifeHost.of(client, workspace: workspace), view: kind)
            } else if view == "files" {
                FilesScreen(client: client, workspace: workspace)
            } else {
                RoutinesScreen(client: client, workspace: workspace)
            }
        } else {
            ContentUnavailableView("Workspace Not Found", systemImage: "folder")
        }
    }
}
