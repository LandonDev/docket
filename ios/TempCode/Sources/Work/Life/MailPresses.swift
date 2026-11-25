import LifeKit
import LifeKitUI
import SwiftUI
import TempCodeClient
import TempCodeContract
import UIKit

/// His Send in LifeKitUI's composer (docs/agents/ios-client.md "Presses"), the phone's rule for every outward press:
/// the owner's check first (`WorkLifeHost.hold`), then five seconds with Undo in Mail's capsule in which the host hears
/// nothing (`SendWait`), then, if the link and the key he pressed under still hold, one `work.mail.send` of the draft
/// as he saw it. The composer closes on the press; the draft stays in LifeOS whatever happens, so Undo, leaving the
/// screen or a lost link send nothing and leave it in Drafts.
@MainActor @Observable
final class MailPresses {
    /// One composer Send: the draft and when he asked it to go.
    nonisolated struct Mail: Sendable, Hashable {
        var draftId: String
        var sendAt: Date?
        var sendZone: String?
    }

    typealias Wait = SendWait<Mail>

    /// What the send needs that the wait does not carry: the host, what he saw, and the Mail place to tell.
    private struct Target {
        let client: EnvironmentClient
        let seen: Methods.WorkMailSend.Params.Seen
        weak var scene: LifeScene?
    }

    static let shared = MailPresses()

    private(set) var wait = Wait()
    @ObservationIgnored private var targets: [String: Target] = [:]
    @ObservationIgnored private var timer: Task<Void, Never>?
    @ObservationIgnored private var background: NSObjectProtocol?
    /// The press whose capsule with Undo is up, so each countdown gets one, and only one, as it starts.
    @ObservationIgnored private var offered: String?
    /// How each press that left the wait ended, for a late Undo's words (`SendWait.lateUndo`).
    @ObservationIgnored private var ended: [String: Wait.Ended] = [:]
    /// The Mail place that said Checking for a draft, by host and draft, so the late answer is said where he read it.
    @ObservationIgnored private var checking: [String: WeakScene] = [:]
    private struct WeakScene { weak var scene: LifeScene?; var scheduled: Bool }

    private init() {
        // Leaving the screen cancels what waits: nothing goes early, nothing goes unseen.
        background = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { MailPresses.shared.leftScreen() }
        }
    }

    /// The ledger's late answers and read-backs for a composer Send reach Mail (`WorkHost.mailHeard`), set at launch
    /// so one read back after a relaunch is said too.
    func attach() {
        WorkHost.mailHeard = { host, draftId, state in MailPresses.shared.heard(host: host, draftId: draftId, state: state) }
    }

    /// What became of a Send that was Checking, said where he is (`say`): not sent and may have gone wait for his tap.
    func heard(host: String, draftId: String, state: PressState) {
        let kept = checking.removeValue(forKey: "\(host)|\(draftId)")
        guard let said = MailRules.heardLate(state, scheduled: kept?.scheduled) else { return }
        // Its "Checking whether it went" no longer holds: the outcome takes its place, found sent or not.
        FleetToastCenter.shared.withdraw(HeldSendRefusal.checking.errorDescription ?? "")
        say(said.line, sticky: said.tell, on: kept?.scene)
    }

    /// The Mail places whose own capsule is on screen now (`LifeViewScreen`, the only one with LifeKit's `.foot()`),
    /// counted by scene: a scene kept alive for a job he left, or a person's page, draws none.
    private var footed: [ObjectIdentifier: Int] = [:]
    /// A person's page drawing TempCode's own Undo for its scene's countdown, counted by scene the same way.
    private var pages: [ObjectIdentifier: Int] = [:]

    /// Counts `scene` as shown on a person's page until the calling view's task ends.
    func pageShown(_ scene: LifeScene) async {
        let id = ObjectIdentifier(scene)
        pages[id, default: 0] += 1
        TickLedger.begin("mail.page"); defer { TickLedger.end("mail.page") }
        while !Task.isCancelled { try? await Task.sleep(for: .seconds(3600)) }
        pages[id, default: 1] -= 1
        if pages[id] == 0 { pages[id] = nil }
    }

    /// The press counting its five seconds while no page that offers its Undo is on screen (he left Mail or the
    /// person's page): the tab's foot shows its Undo instead (`ElsewhereUndo`).
    var offScreenCounting: Wait.Press? {
        wait.countingOffScreen { press in
            guard let scene = targets[press.id]?.scene else { return false }
            let id = ObjectIdentifier(scene)
            return footed[id, default: 0] > 0 || pages[id, default: 0] > 0
        }
    }

    /// Counts `scene` as on screen until the calling view's task ends (it disappears, or its scene is replaced).
    func footShown(_ scene: LifeScene) async {
        let id = ObjectIdentifier(scene)
        footed[id, default: 0] += 1
        TickLedger.begin("mail.foot"); defer { TickLedger.end("mail.foot") }
        while !Task.isCancelled { try? await Task.sleep(for: .seconds(3600)) }
        footed[id, default: 1] -= 1
        if footed[id] == 0 { footed[id] = nil }
    }

    private func shows(_ scene: LifeScene?) -> Bool {
        scene.map { footed[ObjectIdentifier($0), default: 0] > 0 } ?? false
    }

    /// An outcome said where he will see it. Mail's capsule when its place is on screen; and the Work notice, sticky for
    /// what he must act on (not sent, may have gone, checking), plain and gone in four seconds for a success, which
    /// goes there only when no Mail capsule shows.
    private func say(_ line: String, sticky: Bool, on scene: LifeScene?) {
        let places = MailRules.outcomePlaces(sticky: sticky, capsuleShown: shows(scene))
        if places.capsule, let writes = scene?.writes {
            if sticky { writes.fail(line) } else { writes.record(Act("Send", "compose:send", [:], announce: line, failed: "Not sent")) }
        }
        switch places.notice {
        case .sticky?: FleetToastCenter.shared.post(message: line)
        // A Mail outcome comes with no press of his just then: under an unread failure it is not queued.
        case .plain?: FleetToastCenter.shared.post(note: line, own: false)
        case nil: break
        }
    }

    /// A Send of this draft already waits or is on its way.
    func holds(host: String, draftId: String) -> Bool {
        ([wait.counting, wait.inFlight].compactMap { $0 } + wait.queued).contains { $0.host == host && $0.payload.draftId == draftId }
    }

    /// His Send, past the owner's check: it waits its turn, and the words the composer closes on. The capsule with
    /// Undo is Mail's own, put up for whichever press counts once the composer has said its words (they replace any
    /// capsule up, so the one counting is shown again).
    func press(client: EnvironmentClient, scene: LifeScene?, mail: Mail, seen: Methods.WorkMailSend.Params.Seen, key: String?) -> String {
        let id = UUID().uuidString
        let line = mail.sendAt == nil ? "Sending" : "Scheduling"
        targets[id] = Target(client: client, seen: seen, scene: scene)
        offered = nil
        wait.press(Wait.Press(id: id, host: client.environment.id, hostName: client.environment.name, rev: 0, line: line, payload: mail, key: key), now: Self.now)
        schedule()
        watchLinks()
        return line
    }

    /// The countdown that started and has no capsule yet gets one: on a later main-actor turn, after whatever the
    /// composer that closed just now writes (`SendWait.toOffer`).
    private func offerCounting() {
        Task { @MainActor [weak self] in
            guard let self, let press = wait.toOffer(after: offered), let scene = targets[press.id]?.scene else { return }
            offered = press.id
            Self.offerUndo(press.id, line: press.line, mail: press.payload, on: scene)
        }
    }

    /// Mail's capsule for the wait: his words with Undo for as long as the five seconds last.
    private static func offerUndo(_ id: String, line: String, mail: Mail, on scene: LifeScene) {
        guard let deadline = shared.wait.deadline, shared.wait.counting?.id == id else { return }
        // The way back is made when he asks for it (a capsule tap, a shake, ⌘Z), with words for one that came too late:
        // Writes says them as the act's failure, so a late Undo is never silent and never says the mail came back.
        let back = { [weak scene] (_: Arg) -> Act? in
            let late = shared.wait.lateUndo(id, ended: shared.ended[id]) ?? "Couldn't undo"
            var act = Act("Undo Send", "compose:undoSend", [:], failed: late)
            act.send = {
                guard MailPresses.shared.undo(id) else { throw HeldSendRefusal.gate(late) }
                scene?.present(.compose(.draft(id: mail.draftId)), facing: .leading)
                return .null
            }
            return act
        }
        let act = Act("Send", "compose:send", [:], announce: line, failed: "Not sent", feedback: .light,
                      undoWindow: max(1, deadline - now), undo: back)
        scene.writes.record(act)
        AccessibilityNotification.Announcement("\(line). Undo for five seconds.").post()
    }

    /// The press counting its five seconds that was made from this Mail place, for a page that draws no Mail capsule
    /// of its own (a person's page draws TempCode's `UndoCapsule` from it).
    func counting(on scene: LifeScene?) -> Wait.Press? {
        guard let scene, let press = wait.counting, targets[press.id]?.scene === scene else { return nil }
        return press
    }

    /// Undo from TempCode's own capsule: as Mail's, nothing sent and the draft opened again.
    func takeBack(_ press: Wait.Press) {
        let scene = targets[press.id]?.scene
        if undo(press.id) { scene?.present(.compose(.draft(id: press.payload.draftId)), facing: .leading) }
    }

    /// Undo inside the five seconds: nothing was sent, and the draft opens again as LifeOS holds it.
    @discardableResult
    func undo(_ id: String) -> Bool {
        guard wait.undo(id, now: Self.now) != nil else { return false }
        targets[id] = nil
        ended[id] = .notSent
        schedule()
        return true
    }

    private func leftScreen() {
        let held = [wait.counting].compactMap { $0 } + wait.queued
        wait.leftScreen()
        tell(held)
        schedule()
    }

    /// What went back says why: in Mail's capsule, and as the sticky toast the Outbox uses, which waits for his tap
    /// wherever he is (the background, a person's page with no capsule, another screen). The draft is still in Drafts.
    private func tell(_ presses: [Wait.Press]) {
        guard !presses.isEmpty else { return }
        let line = wait.notice?.line ?? "Not sent"
        for press in presses {
            ended[press.id] = .notSent
            if let scene = targets.removeValue(forKey: press.id)?.scene, shows(scene) { scene.writes.fail(line) }
        }
        FleetToastCenter.shared.post(message: line)
    }

    // MARK: - the clock

    private static var now: Double { Date().timeIntervalSince1970 }

    private func schedule() {
        timer?.cancel()
        offerCounting()
        guard let deadline = wait.deadline else { return }
        timer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(max(0, deadline - Self.now)))
            guard !Task.isCancelled else { return }
            self?.fire()
        }
    }

    private func fire() {
        guard let counting = wait.counting else { return }
        guard let target = targets[counting.id] else {
            wait.drop(counting.id, why: .notPaired, now: Self.now)
            return schedule()
        }
        let client = target.client
        let check = Wait.Check(linked: OutboxPresses.linked(client), maySend: client.work.may(.mailSend), rev: 0, key: PressGates.shared.liveKey(counting.host))
        guard let press = wait.due(now: Self.now, check: check) else {
            if let notice = wait.notice, notice.presses.contains(where: { $0.id == counting.id }) { tell([counting]) }
            return schedule()
        }
        let mail = press.payload
        Task {
            // A plain send said "Sending" for its five seconds and says no more; anything else is told.
            let words: String?
            var failed = false
            var end = Wait.Ended.sent
            do {
                // The host answers only once LifeOS has it on its way, or its time is taken (`via: hold` too).
                _ = try await client.work.sendMail(draftId: mail.draftId, seen: target.seen, sendAt: mail.sendAt, sendZone: mail.sendZone, key: press.key)
                words = mail.sendAt == nil ? nil : "Scheduled"
            } catch is PressLedger.Unknown {
                // Gone with no answer: never "not sent". The draft is read back by its status on each link.
                words = HeldSendRefusal.checking.errorDescription ?? ""
                end = .unknown
                checking["\(client.environment.id)|\(mail.draftId)"] = WeakScene(scene: target.scene, scheduled: mail.sendAt != nil)
            } catch {
                words = "Not sent: \(ActionError.wrap(error).message)"
                failed = true
                end = .notSent
            }
            ended[press.id] = end
            // A refusal and Checking wait for his tap wherever he is; "Scheduled" shows in Mail's capsule, or as the
            // plain notice when he wrote it from a page with none (a person's) or has left Mail.
            if let words { say(words, sticky: failed || end == .unknown, on: target.scene) }
            targets[press.id] = nil
            wait.landed(press.id, now: Self.now)
            schedule()
            watchLinks()
        }
    }

    // MARK: - the link

    /// A waiting press's link or key changing: a lost one sends nothing and says so.
    private func watchLinks() {
        let hosts = Set(([wait.counting].compactMap { $0 } + wait.queued).map(\.host))
        guard !hosts.isEmpty else { return }
        withObservationTracking {
            for host in hosts {
                if let client = client(host) { _ = (OutboxPresses.linked(client), client.work.may(.mailSend)) }
            }
        } onChange: { [weak self] in
            Task { @MainActor in self?.recheck(hosts) }
        }
    }

    private func client(_ host: String) -> EnvironmentClient? {
        targets.values.first { $0.client.environment.id == host }?.client
    }

    private func recheck(_ hosts: Set<String>) {
        for host in hosts {
            let held = ([wait.counting].compactMap { $0 } + wait.queued).filter { $0.host == host }
            guard let client = client(host) else { continue }
            if !OutboxPresses.linked(client) {
                wait.linkLost(host: host, now: Self.now)
            } else if !client.work.may(.mailSend) {
                wait.keyLost(host: host, now: Self.now)
            } else {
                continue
            }
            tell(held)
        }
        schedule()
        watchLinks()
    }
}
