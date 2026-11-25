import Foundation
import TempCodeContract

/// Where LifeOS's screens read, and which sectors each shows (the plan "All of Work on the iPhone", M1c).
///
/// A job's own page (`Route.workView`) shows that job's sector alone, on the job's own token. The places for
/// every job at once (Tasks and Agenda, Mail once it ships) read through one token of the whole LifeOS session
/// (`work.lifeos.jwt {}`), signed by the Work home when it can, else by the first open host that holds a job;
/// the job filter narrows what they show. A host that refuses the whole session leaves the places per job, each
/// on its own host's token, with no All Jobs; with no host that may sign at all, the places say why in one line.
public enum LifeReach {
    /// A job: a Work workspace linked to a LifeOS sector.
    public struct Job: Hashable, Sendable, Identifiable {
        /// The workspace's entry key (`ProjectPairs.key`), as `Route.place`'s `job` names it.
        public var id: String
        public var environmentId: String
        public var workspaceId: String
        public var name: String
        public var sector: String

        public init(id: String, environmentId: String, workspaceId: String, name: String, sector: String) {
            self.id = id
            self.environmentId = environmentId
            self.workspaceId = workspaceId
            self.name = name
            self.sector = sector
        }
    }

    /// A host as the phone sees it now.
    public struct Host: Hashable, Sendable {
        public var environmentId: String
        /// A live socket to it.
        public var open: Bool
        /// This key may ask it for a LifeOS token (`KeyMay`, `work.lifeos.jwt`).
        public var mayToken: Bool
        /// Its name when it is a Mac reached through the box with its screen locked, whose key would read LifeOS once
        /// it unlocks (`KeyMay.lifeosLocked`): the places say that, not the key (council 18, Opus 3.1).
        public var locked: String?

        public init(environmentId: String, open: Bool, mayToken: Bool, locked: String? = nil) {
            self.environmentId = environmentId
            self.open = open
            self.mayToken = mayToken
            self.locked = locked
        }

        /// A host as its key reads on its lane now.
        public init(environmentId: String, name: String, open: Bool, key: KeyMay) {
            self.init(environmentId: environmentId, open: open, mayToken: key(.lifeosJwt), locked: key.lifeosLocked ? name : nil)
        }
    }

    public enum Reach: Hashable, Sendable {
        /// Every job through the whole-session token this host signs.
        case whole(environmentId: String)
        /// Each job through its own host's token: the filter offers these, and no All Jobs.
        case perJob([Job])
        /// Nothing here can read LifeOS: why, in one line.
        case unavailable(String)
    }

    /// One host's jobs: its Work workspaces that name a sector, in its order.
    public static func jobs(environmentId: String, workspaces: [WorkspaceMeta]) -> [Job] {
        workspaces.compactMap { workspace in
            guard workspace.kind == .work, let sector = workspace.sector, !sector.isEmpty else { return nil }
            return Job(id: ProjectPairs.key(environmentId, workspace), environmentId: environmentId, workspaceId: workspace.id, name: workspace.name, sector: sector)
        }
    }

    /// Where the places read. `home` is the Work home's host when the phone knows it; `refused` the hosts that
    /// would not sign the whole session; `down` the hosts whose whole session is known down (LifeOS signed out
    /// there, or out of reach): one gives way to the next host that can sign, as the desktop's Today passes a down
    /// reader over, and only when every one is down does the first stand, to say why.
    public static func reach(jobs: [Job], hosts: [Host], home: String? = nil, refused: Set<String> = [], down: Set<String> = []) -> Reach {
        guard !jobs.isEmpty else { return .unavailable("No job is linked to LifeOS.") }
        let holding = Set(jobs.map(\.environmentId))
        let open = hosts.filter { $0.open && holding.contains($0.environmentId) }
        guard !open.isEmpty else { return .unavailable("No computer that holds a job is online.") }
        let signers = open.filter(\.mayToken)
        guard !signers.isEmpty else {
            if let name = open.lazy.compactMap(\.locked).first { return .unavailable("\(name) is locked.") }
            return .unavailable("This iPhone’s key can’t read LifeOS.")
        }
        let homeHost = hosts.first { $0.environmentId == home && $0.open && $0.mayToken }
        let order = (homeHost.map { [$0] } ?? []) + signers.filter { $0.environmentId != home }
        let whole = order.filter { !refused.contains($0.environmentId) }
        if let pick = whole.first(where: { !down.contains($0.environmentId) }) ?? whole.first {
            return .whole(environmentId: pick.environmentId)
        }
        let able = Set(signers.map(\.environmentId))
        return .perJob(jobs.filter { able.contains($0.environmentId) })
    }

    /// The hosts Today passed over (the desktop's `tried`, today/env.ts), forgotten when the hosts that can sign
    /// change. A host found down is passed over, and stays so while the host read in its place is up, even once its
    /// own session is made again: Today keeps the reader that can read the day. Only while every host not passed
    /// over is down is a passed host that is no longer down tried again.
    public struct PassedOver: Hashable, Sendable {
        public private(set) var signers: [String] = []
        public private(set) var ids: Set<String> = []

        public init() {}

        /// The set `reach` passes over now (its `down`), from the signers in order and the hosts down now.
        public mutating func update(signers: [String], down: Set<String>) -> Set<String> {
            if signers != self.signers {
                self.signers = signers
                ids = []
            }
            ids.formUnion(down.intersection(signers))
            if !signers.contains(where: { !ids.contains($0) && !down.contains($0) }) { ids.formIntersection(down) }
            return ids
        }
    }

    /// The jobs the filter offers, one a sector (a job two hosts hold is one job): on `whole`, the signing
    /// host's own first.
    public static func offered(_ reach: Reach, jobs: [Job]) -> [Job] {
        switch reach {
        case .whole(let environmentId):
            return unique(jobs.filter { $0.environmentId == environmentId } + jobs.filter { $0.environmentId != environmentId }, order: jobs)
        case .perJob(let able):
            return unique(able, order: able)
        case .unavailable:
            return []
        }
    }

    /// Whether the filter starts with All Jobs.
    public static func offersAll(_ reach: Reach) -> Bool {
        if case .whole = reach { return true }
        return false
    }

    /// The pick that stands. A job is matched by its key, else by the sector of the job the key names (another
    /// host's copy of the same job). Nil is All Jobs where the filter offers it; per job, the first job.
    public static func pick(_ pick: String?, jobs: [Job], offered: [Job], all: Bool) -> String? {
        if let pick {
            if offered.contains(where: { $0.id == pick }) { return pick }
            if let sector = jobs.first(where: { $0.id == pick })?.sector, let same = offered.first(where: { $0.sector == sector }) { return same.id }
        }
        return all ? nil : offered.first?.id
    }

    /// The sectors an every-job place shows: the picked job's, or for All Jobs every offered job's. A sector no
    /// job links to (his own Life, say) is never in a place of Work.
    public static func sectors(pick: String?, offered: [Job]) -> [String] {
        if let pick, let job = offered.first(where: { $0.id == pick }) { return [job.sector] }
        return unique(offered.map(\.sector))
    }

    /// The sectors a job's own page shows: its own alone. A workspace with no sector shows no sector's rows;
    /// it never falls back to every sector.
    public static func sectors(ofJob sector: String?) -> [String] {
        guard let sector, !sector.isEmpty else { return [] }
        return [sector]
    }

    /// The job Start Thread on an item of `sector` starts in, on the signing host: its own job of that sector.
    public static func workspace(forSector sector: String?, on environmentId: String, jobs: [Job]) -> String? {
        guard let sector else { return nil }
        return jobs.first { $0.environmentId == environmentId && $0.sector == sector }?.workspaceId
    }

    private static func unique(_ jobs: [Job], order: [Job]) -> [Job] {
        var seen = Set<String>()
        let kept = jobs.filter { seen.insert($0.sector).inserted }
        // In the order the hosts list them, whichever host's copy was kept.
        let rank = Dictionary(order.enumerated().map { ($1.sector, $0) }, uniquingKeysWith: { first, _ in first })
        return kept.sorted { (rank[$0.sector] ?? 0) < (rank[$1.sector] ?? 0) }
    }

    private static func unique(_ values: [String]) -> [String] {
        var seen = Set<String>()
        return values.filter { seen.insert($0).inserted }
    }
}
