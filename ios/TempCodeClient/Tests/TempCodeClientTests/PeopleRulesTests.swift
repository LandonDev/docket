import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

private let utc: Calendar = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    calendar.locale = Locale(identifier: "en_US")
    return calendar
}()

/// Tue Nov 24 2026, 00:00 UTC.
private let day = 1_795_478_400_000.0

private func link(_ id: String, name: String, item: String, created: Int, expires: Double = day + 9 * 86_400_000, revoked: Int? = nil, role: String = "comment") -> GuestLinkRow {
    let json = """
    {"id":"\(id)","name":"\(name)","source":{"at":"lifeos","table":"docs","id":"\(item)"},"title":"Plan","role":"\(role)",
     "createdAt":\(created),"expiresAt":\(Int(expires)),"revokedAt":\(revoked.map(String.init) ?? "null"),"by":"owner","lastOpenedAt":null,"open":0}
    """
    return try! JSONDecoder().decode(GuestLinkRow.self, from: Data(json.utf8))
}

@Suite struct PeopleRulesTests {
    @Test func `every job's directory is one list: each person once, newest contact first, then by name`() {
        let cosmic = [
            DirectoryPerson(id: "p1", name: "Tom Beck", emails: ["tom@c.example"], lastAt: 10),
            DirectoryPerson(id: "p2", name: "Ana Ruiz", emails: [], lastAt: nil),
        ]
        let purdue = [
            DirectoryPerson(id: "p1", name: "Tom Beck", emails: ["tom@c.example"], lastAt: 10),
            DirectoryPerson(id: "p3", name: "Dana Lee", emails: ["dana@p.example"], lastAt: 30),
            DirectoryPerson(id: "p4", name: "Ben Ode", emails: [], lastAt: nil),
        ]
        let list = PeopleRules.directory([("cosmic", cosmic), ("purdue", purdue)])
        #expect(list.map(\.id) == ["p3", "p1", "p2", "p4"])
        // Tom is the first job's, where his row opens.
        #expect(list.first { $0.id == "p1" }?.sector == "cosmic")
        #expect(list.first { $0.id == "p3" }?.sector == "purdue")
    }

    @Test func `a search keeps the people every typed word is in, by name or address, folded`() {
        let rows = [
            DirectoryPerson(id: "a", name: "José Álvarez", emails: ["jose@club.example"]),
            DirectoryPerson(id: "b", name: "Dana Lee", emails: ["dana@cosmic.example"]),
        ]
        #expect(PeopleRules.find(rows, "jose alv").map(\.id) == ["a"])
        #expect(PeopleRules.find(rows, "COSMIC").map(\.id) == ["b"])
        #expect(PeopleRules.find(rows, "  ").map(\.id) == ["a", "b"])
        #expect(PeopleRules.find(rows, "dana club").isEmpty)
        #expect(PeopleRules.rowLine(rows[0]) == "jose@club.example")
    }

    @Test func `their guest links are the live ones named for them, one an item, the newest`() {
        let links = [
            link("l1", name: "Dana  LEE", item: "d1", created: 1),
            link("l2", name: "dana lee", item: "d1", created: 2),
            link("l3", name: "Dana Lee", item: "d2", created: 3, revoked: 5),
            link("l4", name: "Dana Lee", item: "d3", created: 4, expires: day - 1),
            link("l5", name: "Tom Beck", item: "d4", created: 5),
        ]
        #expect(PeopleRules.links(links, name: "Dana Lee", now: day).map(\.id) == ["l2"])
        #expect(PeopleRules.links(links, name: " ", now: day).isEmpty)
        #expect(PeopleRules.linkWords(links[0], calendar: utc) == "Can comment until Dec 3")
        #expect(PeopleRules.sharedAsk([links[1]]) == [["table": "docs", "id": "d1"]])
    }

    @Test func `the forms they answered are each once, newest first, across their addresses`() {
        let rows = try! JSONDecoder().decode([MsFormsByPerson].self, from: Data("""
        [{"email":"a@x.example","forms":[{"formId":"f1","title":"Survey","tenant":"t","at":10},{"formId":"f2","title":"Sign-up","tenant":"t","at":null}]},
         {"email":"b@x.example","forms":[{"formId":"f1","title":"Survey","tenant":"t","at":10},{"formId":"f3","title":"Poll","tenant":"t","at":30}]}]
        """.utf8))
        #expect(PeopleRules.answered(rows).map(\.formId) == ["f3", "f1", "f2"])
    }

    @Test func `a page draws only the sections that have something, in the desktop's order`() {
        let page = PersonPage(
            person: .init(id: "p", name: "Dana Lee", emails: ["dana@c.example"], phones: ["555 0100"]),
            mail: [.init(id: "m", subject: "Plan", lastMessageAt: 1)],
            recent: [.init(id: "e", title: "Review", startsAt: 1)],
            tasks: [.init(id: "t", title: "Quote", relation: "waiting")]
        )
        #expect(PeopleRules.sections(page, links: [], answered: []) == [.mail, .waiting, .recent])
        let answered = [MsFormAnswered(formId: "f", title: "Survey", tenant: "t", at: nil)]
        #expect(PeopleRules.sections(page, links: [], answered: answered).last == .answered)
        #expect(PeopleRules.reachLine(page.person) == "dana@c.example, 555 0100")
        #expect(PeopleRules.Section.asked.title == "Asked for by Them")
    }

    @Test func `LifeOS's rows decode by their own ids`() throws {
        let person = try JSONDecoder().decode(DirectoryPerson.self, from: Data(#"{"_id":"p1","name":"Dana","emails":["d@x.example"],"lastAt":5}"#.utf8))
        #expect(person.id == "p1")
        #expect(person.sector == nil)
        let page = try JSONDecoder().decode(PersonPage.self, from: Data("""
        {"person":{"_id":"p1","name":"Dana","notes":"","sectors":["cosmic"],"emails":[],"phones":[]},"mail":[],"coming":[{"_id":"e","title":"Sync","startsAt":1}],
         "recent":[],"tasks":[{"_id":"t","title":"Quote","status":"open","relation":"asked"}],"shared":[{"table":"docs","id":"d","title":"Plan"}]}
        """.utf8))
        #expect(page.coming.first?.id == "e")
        #expect(page.tasks.first?.relation == "asked")
    }

    @Test func `a read that fails over a page on screen says so above it, and only then`() {
        #expect(PeopleRules.refreshLine(kept: true, failing: true) == "This person did not refresh")
        #expect(PeopleRules.refreshLine(kept: true, failing: false) == nil)
        // No page: the page's own "Can’t Read This Person" says it.
        #expect(PeopleRules.refreshLine(kept: false, failing: true) == nil)
    }

    @Test func `LifeOS's missing answer closes a kept page, and a pending ask keeps it`() {
        let kept = PersonPage(person: .init(id: "p", name: "Dana Lee", emails: ["dana@c.example"]))
        #expect(PeopleRules.shownPage(answer: .some(nil), kept: kept) == nil)
        #expect(PeopleRules.shownPage(answer: nil, kept: kept) == kept)
        #expect(PeopleRules.shownPage(answer: nil, kept: nil) == nil)
        var fresh = kept
        fresh.person.name = "Dana Lee-Park"
        #expect(PeopleRules.shownPage(answer: .some(fresh), kept: kept) == fresh)
    }
}
