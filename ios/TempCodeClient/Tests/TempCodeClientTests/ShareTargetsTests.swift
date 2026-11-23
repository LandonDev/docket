import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

@Suite struct ShareTargetsTests {
    private func host(_ id: String, _ name: String, _ workspaces: [ShareTargets.Workspace]) -> ShareTargets.Host {
        let environment = PairedEnvironment(id: id, name: name, origin: URL(string: "https://\(id).example")!, caps: [.read, .operate], keyId: "k-\(id)", keyName: "phone", addedAt: 0)
        return ShareTargets.Host(id: id, name: name, environment: environment, workspaces: workspaces)
    }

    private var targets: ShareTargets {
        ShareTargets(hosts: [
            host("box", "The box", [
                .init(id: "w-esports", name: "Esports", sector: "purdue", folderName: "Esports"),
                .init(id: "w-video", name: "video", sector: "hypixel", folderName: "Video", lastUsedAt: 100),
                .init(id: "w-cosmic", name: "Cosmic", sector: "cosmic", folderName: "Cosmic", lastUsedAt: 300)
            ]),
            host("mac", "Mac", [
                .init(id: "w-life", name: "Admin", folderName: "Admin", lastUsedAt: 200),
                .init(id: "w-unsorted", name: "bills", folderName: "Bills")
            ])
        ])
    }

    @Test func `the last used come first, the never used after them by name`() {
        let ordered = targets.ordered
        #expect(ordered.map(\.workspace.id) == ["w-cosmic", "w-life", "w-video", "w-unsorted", "w-esports"])
        #expect(ordered.map(\.id).first == "box/w-cosmic")
        #expect(ordered[1].host.name == "Mac")
    }

    @Test func `a save is remembered: the workspace moves to the top and its last folder is offered first`() {
        var targets = targets
        let events = ShareFolder(name: "Events", host: "box", path: "/srv/work/Esports/Events")
        let esports = targets.ordered.first { $0.workspace.id == "w-esports" }!
        #expect(esports.workspace.folder == .top(name: "Esports"), "the workspace's own folder at first")
        #expect(esports.destination() == ShareDestination(hostId: "box", workspaceId: "w-esports", folder: .top(name: "Esports")))
        targets.used(hostId: "box", workspaceId: "w-esports", folder: events, at: 400)
        let first = targets.ordered[0]
        #expect(first.workspace.id == "w-esports")
        #expect(first.workspace.lastFolder == events)
        #expect(first.destination().folder == events)
        targets.used(hostId: "mac", workspaceId: "w-esports", folder: events, at: 500)
        #expect(targets.ordered[0].workspace.id == "w-esports", "no workspace of that id on that host: nothing changes")
    }

    @Test func `written and read back whole; nothing written reads as empty`() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("targets-\(UUID().uuidString)", isDirectory: true)
        #expect(ShareTargets.read(root: root) == ShareTargets())
        var targets = targets
        targets.used(hostId: "mac", workspaceId: "w-unsorted", folder: .top(name: "Bills"), at: 900)
        try targets.write(root: root)
        #expect(ShareTargets.read(root: root) == targets)
        try Data("{".utf8).write(to: root.appendingPathComponent(ShareTargets.fileName))
        #expect(ShareTargets.read(root: root).hosts.isEmpty)
    }

    @Test func `the app's fresh list keeps the last folder and use the extension recorded`() {
        var earlier = targets
        let events = ShareFolder(name: "Events", host: "box", path: "/srv/work/Esports/Events")
        earlier.used(hostId: "box", workspaceId: "w-esports", folder: events, at: 700)
        let fresh = ShareTargets(hosts: [
            host("box", "The box", [
                .init(id: "w-esports", name: "Esports, renamed", sector: "purdue", folderName: "Esports"),
                .init(id: "w-new", name: "New", folderName: "New")
            ])
        ])
        let kept = fresh.keepingUse(from: earlier)
        #expect(kept.hosts.count == 1, "a host or workspace gone from the app's list stays gone")
        #expect(kept.hosts[0].workspaces[0].name == "Esports, renamed")
        #expect(kept.hosts[0].workspaces[0].lastFolder == events)
        #expect(kept.hosts[0].workspaces[0].lastUsedAt == 700)
        #expect(kept.hosts[0].workspaces[1].lastUsedAt == nil)
    }
}
