import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

private func name(_ name: String) -> FileEntry {
    FileEntry(key: "file:box:/w/\(name)", ref: .file(.init(host: "box", path: "/w/\(name)")), folder: nil, name: name, kind: .pdf, size: 1000, changed: 1_700_000_000_000)
}

private func job(_ id: String, _ name: String) -> FilesRoot.Job {
    FilesRoot.Job(id: id, environmentId: "env_box", workspaceId: "w-\(id)", name: name, sector: "purdue")
}

/// Go To and a failed search in Files (Work/Files/FilesRules.swift `FilesGoToRules`, `FilesFound.notSearched`): a host
/// that could not look is named beside the names the others found, never read as "No Names Match".
struct FilesGoToTests {
    let purdue = job("p", "Purdue Esports")
    let unify = job("u", "Unify")

    @Test func eachJobKeepsItsPlaceAndAFailedHostIsNamed() {
        let merged = FilesGoToRules.merge([(job: unify, entries: nil), (job: purdue, entries: [name("Budget.pdf"), name("Budget old.pdf")])], order: [purdue, unify])
        #expect(merged.rows.map(\.entry.name) == ["Budget.pdf", "Budget old.pdf"])
        #expect(merged.failed == ["Unify"])
        #expect(FilesFound.notSearched(merged.failed) == "Unify was not searched.")
        #expect(FilesFound.notSearched(["Purdue Esports", "Unify"]) == "Purdue Esports and Unify were not searched.")
        #expect(FilesFound.notSearched([]) == nil)
    }

    @Test func aFailedLookupIsNeverNoNamesMatch() {
        #expect(FilesGoToRules.empty(text: "budget", rows: 0, failed: ["Unify"], asking: false) == nil)
        #expect(FilesGoToRules.empty(text: "budget", rows: 0, failed: [], asking: false) == "No Names Match")
        #expect(FilesGoToRules.empty(text: "", rows: 0, failed: [], asking: false) == "Nothing Recent")
        #expect(FilesGoToRules.empty(text: "budget", rows: 0, failed: [], asking: true) == nil)
        #expect(FilesGoToRules.empty(text: "budget", rows: 2, failed: [], asking: false) == nil)
    }
}
