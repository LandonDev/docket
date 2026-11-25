import LifeKit
import SwiftUI
import TempCodeClient
import TempCodeContract

/// LifeOS's people as LifeKit reads them (docs/agents/work-people.md "The phone"): `people:directory` a sector and
/// `people:page` for one person, live queries on the LifeOS session the place signs (`LifeReach`: the whole session,
/// else the job's own), held only while their screen is on screen (`holdingChats`). On LifeKit's fixture day
/// (`TC_TEST_LIFE_FIXTURES`) the reads are `PeopleFixtures`'s, in memory.
@MainActor
enum PeopleReads {
    /// One sector's people, newest contact first.
    static func directory(_ store: LifeStore, sector: String) -> LiveQuery<[DirectoryPerson]> {
        store.live.query("people:directory", ["sector": .string(sector)], cache: "people-\(sector)")
    }

    /// One person's page in the sector, with the guest links' items asked about (`shared`). Nil inside: no such
    /// person there.
    static func page(_ store: LifeStore, personId: String, sector: String, shared: [GuestLinkRow]) -> LiveQuery<PersonPage?> {
        let asked: [Arg] = PeopleRules.sharedAsk(shared).map { pair in .object(pair.mapValues { .string($0) }) }
        return store.live.query("people:page", ["id": .string(personId), "sector": .string(sector), "shared": .list(asked)])
    }
}

#if DEBUG
/// People on LifeKit's fixture day: three people in two jobs, Dana Lee with mail, a meeting, a task each way, a guest
/// link and a form she answered.
enum PeopleFixtures {
    static var on: Bool { TestHooks.lifeFixtures }

    private static let now = Date().timeIntervalSince1970 * 1000
    private static let hour = 3_600_000.0

    static let people: [DirectoryPerson] = [
        DirectoryPerson(id: "p-dana", name: "Dana Lee", emails: ["dana@cosmicgames.example"], lastAt: now - 2 * hour, sector: "cosmic"),
        DirectoryPerson(id: "p-priya", name: "Priya Shah", emails: ["pshah@purdue.example"], lastAt: now - 26 * hour, sector: "purdue"),
        DirectoryPerson(id: "p-tom", name: "Tom Beck", emails: ["tom@cosmicgames.example", "tbeck@mail.example"], lastAt: now - 6 * 24 * hour, sector: "cosmic")
    ]

    static func page(_ personId: String) -> PersonPage? {
        guard let person = people.first(where: { $0.id == personId }) else { return nil }
        let who = PersonPage.Person(id: person.id, name: person.name, notes: person.id == "p-dana" ? "Producer on the spring update." : "", emails: person.emails, phones: [])
        guard person.id == "p-dana" else { return PersonPage(person: who, lastAt: person.lastAt) }
        return PersonPage(
            person: who,
            lastAt: person.lastAt,
            mail: [PersonPage.Mail(id: "t-plan", subject: "Release plan for the spring update", snippet: "Here is the plan", lastMessageAt: now - 2 * hour, unread: true)],
            coming: [PersonPage.Event(id: "e-sync", title: "Budget sync", startsAt: now + 3 * hour, endsAt: now + 3.75 * hour, location: "Studio B")],
            recent: [PersonPage.Event(id: "e-review", title: "Build review", startsAt: now - 3 * 24 * hour)],
            tasks: [
                PersonPage.Task(id: "k-art", title: "Send the art list", dueAt: now + 24 * hour, relation: "asked"),
                PersonPage.Task(id: "k-quote", title: "Quote for the trailer", relation: "waiting")
            ],
            shared: [PersonPage.Shared(table: "docs", id: "d-plan", title: "Spring update plan")]
        )
    }

    static let answered = [MsFormAnswered(formId: "f-survey", title: "Playtest survey", tenant: "t", at: now - 5 * 24 * hour)]
}
#endif
