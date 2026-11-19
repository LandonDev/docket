import LifeKit
import SwiftUI
import TempCodeClient
import TempCodeContract

/// The head of a Work workspace's screen (milestone 47): Mail, Tasks and
/// Agenda on the Home row grid, then Routines, each opening its screen.
/// While LifeOS is out of reach the three rows sit at half strength.
struct WorkViewRows: View {
    let client: EnvironmentClient
    let workspace: WorkspaceMeta
    /// LifeOS on this host is signed out or out of reach.
    let dimmed: Bool

    var body: some View {
        ForEach(LifeViewScreen.Kind.allCases) { view in
            row(view.title, symbol: view.symbol, view: view.rawValue)
                .opacity(dimmed ? 0.5 : 1)
        }
        row("Routines", symbol: "clock.arrow.circlepath", view: "routines")
    }

    private func row(_ title: String, symbol: String, view: String) -> some View {
        NavigationLink(value: Route.workView(environmentId: client.environment.id, workspaceId: workspace.id, view: view)) {
            Label(title, systemImage: symbol)
                .textStep(.title)
                .frame(minHeight: Layout.rowHeight)
        }
        .listRowInsets(Layout.rowInsets)
        .accessibilityIdentifier("work-view-\(view)")
    }
}

/// Where a view row leads: the workspace's LifeOS screen, or its Routines.
struct WorkViewScreen: View {
    @Environment(AppModel.self) private var model
    let environmentId: String
    let workspaceId: String
    let view: String

    var body: some View {
        if let client = model.registry.client(environmentId), let workspace = client.workspaces.first(where: { $0.id == workspaceId }) {
            if let kind = LifeViewScreen.Kind(rawValue: view) {
                LifeViewScreen(host: WorkLifeHost.of(client, workspace: workspace), view: kind)
            } else {
                RoutinesScreen(client: client, workspace: workspace)
            }
        } else {
            ContentUnavailableView("Workspace Not Found", systemImage: "folder")
        }
    }
}
