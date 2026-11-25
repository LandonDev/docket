import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// What the phone may keep of Work on its disk, and when it lets go (WorkCache.swift).
struct WorkCacheRuleTests {
    static let secret = "gl_9f2c7e1d-secret"
    static let ticket = "tkt_4471ab"

    /// A held mail with a body and an attachment, and a guest link with its secret and a ticket.
    static func items() throws -> [TodaySources.HeldItem] {
        let json = """
        [
          {"environmentId": "mac", "ref": {"at": "host", "id": "h1"}, "kind": "mail.send", "summary": "Send to Dana Lee: Travel budget", "verb": "Send",
           "workspaceId": "w1", "state": "held", "createdAt": 1795500000000, "why": "rule", "updatedAt": 1795500000000,
           "payload": {"subject": "Travel budget", "body": "The whole private body of the mail", "attachments": [{"name": "budget.xlsx", "data": "UEsDBBQ"}]}},
          {"environmentId": "mac", "ref": {"at": "host", "id": "h2"}, "kind": "share.guestLink", "summary": "Share Brief.docx by link", "verb": "Share",
           "workspaceId": "~work", "state": "held", "createdAt": 1795500100000, "why": "rule", "updatedAt": 1795500100000,
           "payload": {"url": "https://share.example/g/\(secret)", "secret": "\(secret)", "ticket": "\(ticket)"}},
          {"environmentId": "mac", "ref": {"at": "host", "id": "h3"}, "kind": "mail.send", "summary": "Send: gone", "verb": "Send",
           "state": "sent", "createdAt": 1795500200000, "why": "rule", "updatedAt": 1795500200000}
        ]
        """
        return try JSONDecoder().decode([TodaySources.HeldItem].self, from: Data(json.utf8))
    }

    @Test func `a waiting row keeps the act's words, its target and its time, and nothing of the payload`() throws {
        let rows = WorkCache.waiting(try Self.items(), names: [TodayPlace(environmentId: "mac", workspaceId: "w1"): "Purdue Esports"])
        #expect(rows.map(\.ref) == ["host:h1", "host:h2"])
        #expect(rows[0].act == "Send to Dana Lee" && rows[0].about == "Travel budget" && rows[0].place == "Purdue Esports" && rows[0].at == 1795500000000)
        #expect(rows[1].place == "Work Chats")
        let kept = String(decoding: try JSONEncoder().encode(rows), as: UTF8.self)
        for leak in ["private body", "budget.xlsx", "UEsDBBQ", Self.secret, Self.ticket, "share.example"] {
            #expect(!kept.contains(leak), "\(leak) was kept")
        }
    }

    @Test func `a Today row is kept with its words and target, and no verb`() throws {
        var row = TodayRow(key: "mail:m1", section: "waiting", sector: "purdue", title: "Dana Lee")
        row.when = "6 days"
        let place = TodayPlace(environmentId: "mac", workspaceId: "w1")
        row.open = .mail(place, threadId: "m1")
        row.acts = [TodayAct("Nudge", .nudge(place, threadId: "m1"))]
        let kept = WorkCache.today([row])
        #expect(kept.first?.acts == [] && kept.first?.open == row.open && kept.first?.when == "6 days")
        let back = try JSONDecoder().decode([TodayRow].self, from: JSONEncoder().encode(kept))
        #expect(back == kept)
    }

    @Test func `Today's held rows keep no payload either`() throws {
        let rows = TodaySources.heldRows(try Self.items(), now: 1795500300000, names: [:], calendar: .current)
        let kept = String(decoding: try JSONEncoder().encode(WorkCache.today(rows)), as: UTF8.self)
        for leak in ["private body", "budget.xlsx", Self.secret, Self.ticket] { #expect(!kept.contains(leak), "\(leak) was kept") }
    }

    @Test func `a kept row drops its live line, and a launch on a later day paints no row of the day`() {
        var meeting = TodayRow(key: "event:e1", section: "meetings", sector: "purdue", title: "Budget sync")
        meeting.whenLine = "Now"
        var held = TodayRow(key: "held:box:host:1", section: "held", sector: nil, title: "H")
        held.when = "7:42 AM"
        let kept = WorkCache.today([meeting, held])
        #expect(kept.allSatisfy { $0.whenLine == nil })
        let value = WorkCacheValue.todayRows([meeting, held], day: "2026-11-24")
        #expect(value.todayShown(on: "2026-11-24").map(\.key) == ["event:e1", "held:box:host:1"])
        #expect(value.todayShown(on: "2026-11-25").map(\.key) == ["held:box:host:1"])
        // Rows kept before the day was are of no known day.
        #expect(WorkCacheValue.today(kept).todayShown(on: "2026-11-24").map(\.key) == ["held:box:host:1"])
    }

    @Test func `money, chat and response rows are kept under the host their press opens on`() {
        let mac = TodayPlace(environmentId: "mac", workspaceId: "w")
        var money = TodayRow(key: "money:mac:w:1:toHim", section: "money", sector: "purdue", title: "M")
        money.open = .money(mac)
        var chat = TodayRow(key: "chat:c:1", section: "messages", sector: "purdue", title: "C")
        chat.open = .chat(mac, chatId: "c")
        var form = TodayRow(key: "msforms:mac:w:f", section: "msforms", sector: "purdue", title: "F")
        form.open = .form(mac, formId: "f", tenant: "t")
        #expect(WorkCache.todayByHost([money, chat, form], lifeosHost: "box")["mac"]?.count == 3)
    }

    @Test func `the fence refuses a closed host's writes, and any write queued before its close`() {
        let host = "fence-\(UUID().uuidString)"
        let before = WorkCacheFence.stamp(host)
        #expect(WorkCacheFence.admits(host, stamp: before))
        WorkCacheFence.close(host)
        #expect(!WorkCacheFence.admits(host, stamp: before))
        #expect(!WorkCacheFence.admits(host, stamp: WorkCacheFence.stamp(host)))
        WorkCacheFence.open(host)
        // Queued before the close: refused even now it is open. Queued after: written.
        #expect(!WorkCacheFence.admits(host, stamp: before))
        #expect(WorkCacheFence.admits(host, stamp: WorkCacheFence.stamp(host)))
        #expect(WorkCacheFence.admits("never-closed-\(UUID().uuidString)", stamp: nil))
    }

    @Test func `a purge refuses every write queued before it and keeps the host open`() {
        let host = "purge-\(UUID().uuidString)"
        let before = WorkCacheFence.stamp(host)
        WorkCacheFence.purge(host)
        #expect(!WorkCacheFence.admits(host, stamp: before))
        #expect(WorkCacheFence.admits(host, stamp: WorkCacheFence.stamp(host)))
        #expect(WorkCacheDrop.workOff(host: "a").host == "a" && WorkCacheDrop.signedOut(account: "k").host == nil)
    }

    @Test func `purges made with no file are kept and taken once, in order`() {
        let suite = "work-cache-purges-\(UUID().uuidString)"
        let purges = WorkCachePurges(defaults: { UserDefaults(suiteName: suite)! })
        purges.add(.capabilityLost(host: "mac"))
        purges.add(.workOff(host: "box"))
        purges.add(.capabilityLost(host: "mac"))
        #expect(purges.take() == [.capabilityLost(host: "mac"), .workOff(host: "box")])
        #expect(purges.take().isEmpty)
    }

    @Test func `a LifeOS sign-out takes the rows its session read out of every host's keys, and nothing else`() {
        func row(_ key: String, _ section: String, by: String?) -> TodayRow {
            var r = TodayRow(key: key, section: section, sector: "purdue", title: key)
            r.suppliedBy = by
            return r
        }
        // Box's whole session read a wait for a job on the Mac: kept under the Mac's key.
        let macKey = WorkCache.Key(host: "mac", account: "k", keyGeneration: 1, scope: .today)
        let boxKey = WorkCache.Key(host: "box", account: "k", keyGeneration: 1, scope: .today)
        var book = WorkCacheBook()
        book.put(.todayRows([row("mail:1", "waiting", by: "box"), row("mail:2", "waiting", by: "mac"), row("held:mac:host:1", "held", by: nil)], day: "d"), at: macKey)
        book.put(.todayRows([row("event:1", "meetings", by: nil), row("held:box:host:1", "held", by: nil)], day: "d"), at: boxKey)
        #expect(book.drop(.lifeosSignedOut(host: "box")).isEmpty)
        // Box's own rows go wherever kept, and rows of no known supplier; the Mac's session's row and held rows stay.
        #expect(book.today([macKey], day: "d").map(\.key) == ["mail:2", "held:mac:host:1"])
        #expect(book.today([boxKey], day: "d").map(\.key) == ["held:box:host:1"])
    }

    @Test func `rows are kept under the host they came from`() {
        var held = TodayRow(key: "held:box:host:1", section: "held", sector: nil, title: "H")
        held.open = .held(environmentId: "box", ref: .host(.init(id: "1")))
        var task = TodayRow(key: "task:1", section: "due", sector: "purdue", title: "T")
        task.workspace = TodayPlace(environmentId: "mac", workspaceId: "w")
        let review = TodayRow(key: "review:1", section: "also", sector: nil, title: "R")
        let byHost = WorkCache.todayByHost([held, task, review], lifeosHost: "pc")
        #expect(byHost["box"]?.map(\.key) == ["held:box:host:1"])
        #expect(byHost["mac"]?.map(\.key) == ["task:1"])
        #expect(byHost["pc"]?.map(\.key) == ["review:1"])
    }

    static let keys: [WorkCache.Key] = [
        .init(host: "mac", account: "a", keyGeneration: 1, scope: .today),
        .init(host: "mac", account: "a", keyGeneration: 2, scope: .outbox),
        .init(host: "mac", account: "b", keyGeneration: 2, workspaceId: "w", scope: .folder("f")),
        .init(host: "box", account: "a", keyGeneration: 1, scope: .digest),
    ]

    @Test func `a replaced key drops what an older key read, on its host alone`() {
        #expect(WorkCacheDrop.keyReplaced(host: "mac", generation: 2).drops(Self.keys) == [Self.keys[0]])
    }

    @Test func `a lost capability, Work off and a removed host drop everything of that host`() {
        for change in [WorkCacheDrop.capabilityLost(host: "mac"), .workOff(host: "mac"), .hostRemoved(host: "mac")] {
            #expect(change.drops(Self.keys) == Set(Self.keys.prefix(3)))
        }
        #expect(WorkCacheDrop.hostRemoved(host: "pc").drops(Self.keys).isEmpty)
    }

    @Test func `a sign-out drops the account on every host`() {
        #expect(WorkCacheDrop.signedOut(account: "a").drops(Self.keys) == [Self.keys[0], Self.keys[1], Self.keys[3]])
    }

    @Test func `a key names its scope, and a folder its id`() throws {
        let key = WorkCache.Key(host: "mac", account: "a", keyGeneration: 3, workspaceId: "w", scope: .folder("Shared/Q3"))
        #expect(try JSONDecoder().decode(WorkCache.Key.self, from: JSONEncoder().encode(key)) == key)
        #expect(key != WorkCache.Key(host: "mac", account: "a", keyGeneration: 3, workspaceId: "w", scope: .folder("Shared")))
    }
}
