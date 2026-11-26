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

    /// The rows answer the words they were asked for: typed past, they are neither drawn nor taken by Search.
    @Test func rowsAnswerOnlyTheirOwnWords() {
        #expect(FilesGoToRules.current(answered: "budget", text: "budget"))
        #expect(FilesGoToRules.current(answered: "budget", text: " budget "))
        #expect(FilesGoToRules.current(answered: "", text: ""))
        #expect(!FilesGoToRules.current(answered: "budget", text: "budget memo"))
        #expect(!FilesGoToRules.current(answered: nil, text: ""))
    }

    /// One spelling of a size on every phone screen (round 1, R1-F15): "KB", never "kB" beside it.
    @Test func aSizeHasOneSpelling() {
        #expect(FilesRules.size(15_389) == ByteCountFormatter.string(fromByteCount: 15_389, countStyle: .file))
        #expect(FilesRules.size(15_389).contains("KB"))
        #expect(!FilesRules.size(15_389).contains("kB"))
        #expect(FilesRules.factDetail(size: 2_048, changed: nil)?.contains("KB") == true)
    }

    /// Files names a file as the reader's bar does: our own two endings dropped, any other kept (round 1, R1-F12).
    @Test func filesDropOurOwnEndings() {
        #expect(ReaderVerbs.title("Travel memo.tcdoc") == "Travel memo")
        #expect(ReaderVerbs.title("Travel budget.tcsheet") == "Travel budget")
        #expect(ReaderVerbs.title("Spring budget.pdf") == "Spring budget.pdf")
    }
}
