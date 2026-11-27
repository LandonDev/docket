import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// Work search on the phone (Work/Search/WorkSearchModel.swift), replayed step by step against the window's own
/// model: Fixtures/search/model.json, written by scripts/ios-work-search-fixture.test.ts.
@Suite struct WorkSearchModelTests {
    private struct Fixture: Decodable {
        struct Case: Decodable {
            var name: String
            var scoped: Bool?
            var jobs: [String: String]?
            var steps: [Step]
        }

        struct Host: Decodable {
            var id: String
            var name: String
            var home: Bool
            var workspaceId: String?
            var model: WorkSearchModel.Host { .init(id: id, name: name, home: home, workspaceId: workspaceId) }
        }

        struct Step: Decodable {
            var op: String
            var text: String?
            var kind: String?
            var scope: String?
            var within: [String]?
            var hosts: [Host]?
            var offline: [String]?
            var unsearched: String?
            var host: String?
            var source: Source?
            var answer: WorkSearchAnswer?
            var gen: Int?
            var by: Int?
            var id: String?
            var expect: Expect

            enum CodingKeys: String, CodingKey { case op, text, kind, scope, within, hosts, offline, unsearched, host, source, answer, gen, by, id, expect }

            init(from decoder: any Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                op = try c.decode(String.self, forKey: .op)
                text = try c.decodeIfPresent(String.self, forKey: .text)
                kind = try c.decodeIfPresent(String.self, forKey: .kind)
                scope = try c.decodeIfPresent(String.self, forKey: .scope)
                within = try c.decodeIfPresent([String].self, forKey: .within)
                hosts = try c.decodeIfPresent([Host].self, forKey: .hosts)
                offline = try c.decodeIfPresent([String].self, forKey: .offline)
                unsearched = try c.decodeIfPresent(String.self, forKey: .unsearched)
                host = try c.decodeIfPresent(String.self, forKey: .host)
                // `source` is a string on a source's answer and a {source, kind} on a failure.
                if let name = try? c.decodeIfPresent(String.self, forKey: .source) {
                    source = Source(source: name, kind: "")
                } else {
                    source = try c.decodeIfPresent(Source.self, forKey: .source)
                }
                answer = try c.decodeIfPresent(WorkSearchAnswer.self, forKey: .answer)
                gen = try c.decodeIfPresent(Int.self, forKey: .gen)
                by = try c.decodeIfPresent(Int.self, forKey: .by)
                id = try c.decodeIfPresent(String.self, forKey: .id)
                expect = try c.decode(Expect.self, forKey: .expect)
            }
        }

        struct Source: Decodable { var source: String; var kind: String }

        struct Expect: Decodable {
            var rows: [Row]
            var active: String?
            var busy: Bool
            var gen: Int
            var mix: Bool
            var params: [JSONValue]?
            var ask: [Source]?
        }

        struct Row: Decodable, Equatable, CustomStringConvertible {
            var type: String
            var id: String
            var host: String?
            var key: String?
            var label: String?
            var kind: String?
            var text: String?
            var cause: Bool?
            var description: String { "\(type) \(id) \(label ?? text ?? "")" }
        }

        var cases: [Case]
    }

    private static let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/search/model.json")
    private static let fixture: Fixture = try! JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))

    private static func row(_ row: WorkSearchModel.Row) -> Fixture.Row {
        switch row {
        case .heading(let id, let label): .init(type: "heading", id: id, label: label)
        case .hit(let id, let hit, let host): .init(type: "hit", id: id, host: host, key: hit.key)
        case .all(let id, let kind, let label): .init(type: "all", id: id, label: label, kind: kind)
        case .widen(let id, let label): .init(type: "widen", id: id, label: label)
        case .note(let id, let text, let cause): .init(type: "note", id: id, text: text, cause: cause ? true : nil)
        }
    }

    private static func json(_ value: some Encodable) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
    }

    @Test(arguments: WorkSearchModelTests.fixture.cases.map(\.name))
    func `each step draws the window's rows`(name: String) throws {
        let c = try #require(Self.fixture.cases.first { $0.name == name })
        let jobOf: (String?) -> String = { id in id.map { c.jobs?[$0] ?? $0 } ?? "" }
        var model = WorkSearchModel()
        for (index, step) in c.steps.enumerated() {
            var params: [Methods.WorkSearchQuery.Params]?
            var ask: [WorkSearchModel.Pending]?
            switch step.op {
            case "begin":
                let hosts = (step.hosts ?? []).map(\.model)
                model = model.begin(text: step.text ?? "", kind: step.kind, scope: step.scope, within: step.within, hosts: hosts, offline: step.offline ?? [], unsearched: step.unsearched)
                params = hosts.map { model.params(for: $0) }
            case "instant":
                let landed = model.landInstant(gen: step.gen ?? model.gen, host: step.host!, step.answer!)
                model = landed.model
                ask = landed.ask
                let host = model.hosts.first { $0.id == step.host }
                params = host.map { h in landed.ask.map { model.params(for: h, sources: [$0.source]) } } ?? []
            case "source":
                model = model.landSource(gen: step.gen ?? model.gen, host: step.host!, source: step.source!.source, step.answer!)
            case "failed":
                model = model.failed(gen: step.gen ?? model.gen, host: step.host!, source: step.source.map { .init(source: $0.source, kind: $0.kind) })
            case "step":
                model = model.step(model.rows(scoped: c.scoped == true, jobOf: jobOf), by: step.by!)
            case "point":
                model = model.point(step.id!)
            default:
                Issue.record("unknown op \(step.op)")
            }
            let rows = model.rows(scoped: c.scoped == true, jobOf: jobOf)
            let at = "\(name) step \(index) (\(step.op))"
            #expect(rows.map(Self.row) == step.expect.rows, "\(at)")
            #expect(model.active(in: rows) == step.expect.active, "\(at)")
            #expect(model.busy == step.expect.busy, "\(at)")
            #expect(model.gen == step.expect.gen, "\(at)")
            #expect(WorkSearchModel.placesMix(jobs: 1, rows: rows) == step.expect.mix, "\(at)")
            if let want = step.expect.params { #expect(try (params ?? []).map(Self.json) == want, "\(at) params") }
            if let want = step.expect.ask { #expect((ask ?? []).map { "\($0.source) \($0.kind)" } == want.map { "\($0.source) \($0.kind)" }, "\(at) ask") }
        }
    }

    /// `work.search.opened` sends back the very hit the host gave: every hit in the fixture, decoded and encoded
    /// again, is the same JSON (a view's `with`, a file's ref, a chip, a flag, a null).
    @Test func `a hit goes back to its host unchanged`() throws {
        struct Raw: Decodable { var cases: [RawCase] }
        struct RawCase: Decodable { var steps: [RawStep] }
        struct RawStep: Decodable { var answer: RawAnswer? }
        struct RawAnswer: Decodable { var groups: [RawGroup] }
        struct RawGroup: Decodable { var hits: [JSONValue] }
        let raw = try JSONDecoder().decode(Raw.self, from: Data(contentsOf: Self.url))
        let hits = raw.cases.flatMap(\.steps).compactMap(\.answer).flatMap(\.groups).flatMap(\.hits)
        #expect(hits.count > 40)
        for hit in hits {
            let decoded = try JSONDecoder().decode(WorkSearchHit.self, from: JSONEncoder().encode(hit))
            #expect(try Self.json(decoded) == hit)
        }
    }

    @Test func `the quiet words`() {
        let box = WorkSearchModel.Host(id: "box", name: "The box", home: true)
        #expect(WorkSearchModel.quietLine(cause: "lifeos", line: "Work is off on this host.", host: box, hosts: 1).line == "Work is off on the box.")
        #expect(WorkSearchModel.quietLine(cause: "lifeos", line: "fetch failed", host: box, hosts: 1).line == "LifeOS did not answer the box.")
        #expect(WorkSearchModel.quietLine(cause: "lifeos", line: "Something else.", host: box, hosts: 1).line == "Something else.")
        #expect(WorkSearch.nameInLine("This Mac") == "this Mac")
        #expect(WorkSearch.nameInLine("The Purdue Office") == "The Purdue Office")
        #expect(WorkSearch.matches("cafe bud", "Café", "Budget"))
        #expect(!WorkSearch.matches("cafe zz", "Café", "Budget"))
    }

    /// Nothing found with a cause standing: the empty screen says the cause in place of the spelling hint.
    @Test func `the causes of an empty search`() {
        let nothing = WorkSearchModel.Row.note(id: "nothing", text: "Nothing for “budget”", cause: false)
        let lifeos = WorkSearchModel.Row.note(id: "quiet:lifeos", text: "Not signed in to LifeOS on Mac.", cause: true)
        let offline = WorkSearchModel.Row.note(id: "quiet:offline:box", text: "The box is offline.", cause: true)
        #expect(WorkSearchModel.emptyCauses([nothing, lifeos, offline]) == "Not signed in to LifeOS on Mac.\nThe box is offline.")
        #expect(WorkSearchModel.emptyCauses([nothing]) == nil)
        #expect(WorkSearchModel.emptyCauses([.heading(id: "heading:mail", label: "Mail"), lifeos]) == nil)
    }
}
