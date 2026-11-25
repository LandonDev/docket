import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// Where LifeOS's screens read and which sectors each shows (M1c): a job's page its own sector alone, the
/// every-job places on the whole session, narrowed by the job filter.
@Suite struct LifeReachTests {
    private func ws(_ id: String, kind: WorkspaceKind? = .work, sector: String?, link: String? = nil) -> WorkspaceMeta {
        WorkspaceMeta(id: id, name: id.capitalized, path: "/w/\(id)", git: false, linkId: link, kind: kind, sector: sector, createdAt: 1)
    }

    private let box = [LifeReach.Job(id: "box:purdue", environmentId: "box", workspaceId: "purdue", name: "Purdue", sector: "purdue"),
                       LifeReach.Job(id: "box:ref", environmentId: "box", workspaceId: "ref", name: "Ref", sector: "ref")]
    private let mac = [LifeReach.Job(id: "mac:cosmic", environmentId: "mac", workspaceId: "cosmic", name: "Cosmic", sector: "cosmic")]

    // MARK: - a job's own page

    @Test func `a job's page shows its own sector alone, and a workspace with no sector shows none, never every sector`() {
        #expect(LifeReach.sectors(ofJob: "purdue") == ["purdue"])
        #expect(LifeReach.sectors(ofJob: nil) == [])
        #expect(LifeReach.sectors(ofJob: "") == [])
    }

    @Test func `a host's jobs are its Work workspaces that name a sector, keyed as the Work list keys them`() {
        let jobs = LifeReach.jobs(environmentId: "box", workspaces: [
            ws("purdue", sector: "purdue"), ws("code", kind: .code, sector: nil), ws("loose", sector: nil), ws("ref", sector: "ref", link: "L1")
        ])
        #expect(jobs.map(\.id) == ["box:purdue", "link:L1"])
        #expect(jobs.map(\.sector) == ["purdue", "ref"])
    }

    // MARK: - where the every-job places read

    @Test func `a whole session known down gives way to the next host that can sign, and the first stands when all are down`() {
        let hosts = [LifeReach.Host(environmentId: "box", open: true, mayToken: true), LifeReach.Host(environmentId: "mac", open: true, mayToken: true)]
        // The box signed out of LifeOS: the Mac reads the day, as the desktop passes a down reader over.
        #expect(LifeReach.reach(jobs: box + mac, hosts: hosts, down: ["box"]) == .whole(environmentId: "mac"))
        #expect(LifeReach.reach(jobs: box + mac, hosts: hosts, home: "box", down: ["box"]) == .whole(environmentId: "mac"))
        // Both down: the first stays, so the page says its state, never the per-job reach.
        #expect(LifeReach.reach(jobs: box + mac, hosts: hosts, down: ["box", "mac"]) == .whole(environmentId: "box"))
        // A refusal still sends the places per job; a down host is no refusal.
        #expect(LifeReach.reach(jobs: box + mac, hosts: hosts, refused: ["mac"], down: ["box"]) == .whole(environmentId: "box"))
    }

    @Test func `the whole session comes from the Work home, else the first open host that holds a job and may sign`() {
        let hosts = [LifeReach.Host(environmentId: "box", open: true, mayToken: true), LifeReach.Host(environmentId: "mac", open: true, mayToken: true)]
        #expect(LifeReach.reach(jobs: box + mac, hosts: hosts) == .whole(environmentId: "box"))
        #expect(LifeReach.reach(jobs: box + mac, hosts: hosts, home: "mac") == .whole(environmentId: "mac"))
        // A home that is offline, or whose key may not sign, gives way to the next.
        let macDown = [hosts[0], LifeReach.Host(environmentId: "mac", open: false, mayToken: true)]
        #expect(LifeReach.reach(jobs: box + mac, hosts: macDown, home: "mac") == .whole(environmentId: "box"))
        // A host that holds no job is not a signer unless it is the home.
        let bare = [LifeReach.Host(environmentId: "pc", open: true, mayToken: true), hosts[1]]
        #expect(LifeReach.reach(jobs: box + mac, hosts: bare) == .whole(environmentId: "mac"))
        #expect(LifeReach.reach(jobs: box + mac, hosts: bare, home: "pc") == .whole(environmentId: "pc"))
    }

    @Test func `a host that refuses the whole session leaves the places per job, each on a host that may sign`() {
        let hosts = [LifeReach.Host(environmentId: "box", open: true, mayToken: true), LifeReach.Host(environmentId: "mac", open: true, mayToken: false)]
        #expect(LifeReach.reach(jobs: box + mac, hosts: hosts, refused: ["box"]) == .perJob(box))
        // Another signer takes the whole session before it goes per job.
        let both = [hosts[0], LifeReach.Host(environmentId: "mac", open: true, mayToken: true)]
        #expect(LifeReach.reach(jobs: box + mac, hosts: both, refused: ["box"]) == .whole(environmentId: "mac"))
    }

    @Test func `with nothing that can read LifeOS the places say why in one line`() {
        #expect(LifeReach.reach(jobs: [], hosts: []) == .unavailable("No job is linked to LifeOS."))
        #expect(LifeReach.reach(jobs: box, hosts: [LifeReach.Host(environmentId: "box", open: false, mayToken: true)]) == .unavailable("No computer that holds a job is online."))
        #expect(LifeReach.reach(jobs: box, hosts: [LifeReach.Host(environmentId: "box", open: true, mayToken: false)]) == .unavailable("This phone’s key can’t read LifeOS."))
    }

    // MARK: - the job filter

    @Test func `on the whole session the filter offers All Jobs, then a job a sector, the signer's own first`() {
        let twin = LifeReach.Job(id: "mac:purdue", environmentId: "mac", workspaceId: "p2", name: "Purdue", sector: "purdue")
        let jobs = [twin] + mac + box
        let reach = LifeReach.Reach.whole(environmentId: "box")
        let offered = LifeReach.offered(reach, jobs: jobs)
        #expect(offered.map(\.id) == ["box:purdue", "mac:cosmic", "box:ref"])
        #expect(LifeReach.offersAll(reach))
        #expect(LifeReach.pick(nil, jobs: jobs, offered: offered, all: true) == nil)
        // The other host's copy of a job picks the kept one.
        #expect(LifeReach.pick("mac:purdue", jobs: jobs, offered: offered, all: true) == "box:purdue")
        #expect(LifeReach.pick("gone", jobs: jobs, offered: offered, all: true) == nil)
    }

    @Test func `All Jobs shows every job's sector and no other; a pick shows its own`() {
        let offered = box + mac
        #expect(LifeReach.sectors(pick: nil, offered: offered) == ["purdue", "ref", "cosmic"])
        #expect(LifeReach.sectors(pick: "box:ref", offered: offered) == ["ref"])
        #expect(!LifeReach.sectors(pick: nil, offered: offered).contains("life"))
    }

    @Test func `per job there is no All Jobs: the first job stands until he picks another`() {
        let reach = LifeReach.Reach.perJob(box)
        let offered = LifeReach.offered(reach, jobs: box + mac)
        #expect(!LifeReach.offersAll(reach))
        #expect(offered.map(\.id) == ["box:purdue", "box:ref"])
        #expect(LifeReach.pick(nil, jobs: box + mac, offered: offered, all: false) == "box:purdue")
        #expect(LifeReach.pick("box:ref", jobs: box + mac, offered: offered, all: false) == "box:ref")
        // A job on a host that cannot sign is not offered.
        #expect(LifeReach.pick("mac:cosmic", jobs: box + mac, offered: offered, all: false) == "box:purdue")
        #expect(LifeReach.offered(.unavailable("x"), jobs: box).isEmpty)
    }

    @Test func `Start Thread on an every-job item starts in its sector's job on the signing host`() {
        #expect(LifeReach.workspace(forSector: "ref", on: "box", jobs: box + mac) == "ref")
        #expect(LifeReach.workspace(forSector: "cosmic", on: "box", jobs: box + mac) == nil)
        #expect(LifeReach.workspace(forSector: nil, on: "box", jobs: box) == nil)
    }
}
