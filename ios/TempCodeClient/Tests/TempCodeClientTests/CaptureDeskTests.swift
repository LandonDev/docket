import Foundation
import Testing
@testable import TempCodeClient

/// The Capture sheet's door and its Save (Work/Capture/CaptureDesk.swift).
@MainActor @Suite struct CaptureDeskTests {
    @Test func `opening only shows the sheet`() {
        let desk = CaptureDesk()
        desk.open(.voice)
        #expect(desk.shown == .voice)
        // A second way in while it is up keeps the sheet as it is.
        desk.open(.typed)
        #expect(desk.shown == .voice)
        #expect(!desk.receiptNext)
    }

    @Test func `Scan Receipt closes the sheet, then the camera opens once`() {
        let desk = CaptureDesk()
        desk.open(.typed)
        desk.scanReceipt()
        #expect(desk.shown == nil)
        #expect(desk.closed())
        #expect(!desk.closed())
        desk.open(.typed)
        desk.shown = nil
        #expect(!desk.closed())
    }

    @Test func `what Save does`() {
        typealias D = CaptureRules.Draft
        #expect(CaptureRules.plan(D(hasWords: true, files: 0, job: nil, busy: false)) == .init(note: true, files: false))
        #expect(CaptureRules.plan(D(hasWords: false, files: 2, job: "box/w1", busy: false)) == .init(note: false, files: true))
        #expect(CaptureRules.plan(D(hasWords: true, files: 1, job: "box/w1", busy: false)) == .init(note: true, files: true))
        // Nothing to save, files with nowhere to go, or a save already on its way.
        #expect(CaptureRules.plan(D(hasWords: false, files: 0, job: "box/w1", busy: false)) == nil)
        #expect(CaptureRules.plan(D(hasWords: true, files: 1, job: nil, busy: false)) == nil)
        #expect(CaptureRules.plan(D(hasWords: true, files: 0, job: nil, busy: true)) == nil)
    }

    @Test func `the files' failure line counts each file once`() {
        // A pick that would not copy in, and one still in the sheet that Save could not queue, of three added.
        #expect(CaptureRules.failedLine(unpicked: ["a.pdf"], unqueued: ["b.pdf"], files: 2) == "Could not read 2 of 3 files.")
        #expect(CaptureRules.failedLine(unpicked: [], unqueued: ["b.pdf"], files: 1) == "Could not read b.pdf.")
        #expect(CaptureRules.failedLine(unpicked: [], unqueued: [], files: 2) == nil)
    }

    @Test func `the job a file goes to`() {
        let environment = PairedEnvironment(id: "box", name: "The box", origin: URL(string: "https://box.example")!, caps: [.read, .operate], keyId: "K1", keyName: "iphone", addedAt: 0)
        let host = ShareTargets.Host(id: "box", name: "The box", environment: environment, workspaces: [
            .init(id: "w1", name: "Cosmic", sector: "cosmic", folderName: "Cosmic"),
            .init(id: "w2", name: "Purdue", sector: "purdue", folderName: "Purdue", lastUsedAt: 5),
        ])
        let targets = ShareTargets(hosts: [host]).ordered
        #expect(CaptureRules.job(picked: "box/w1", sector: "purdue", targets: targets)?.workspace.id == "w1")
        #expect(CaptureRules.job(picked: nil, sector: "cosmic", targets: targets)?.workspace.id == "w1")
        // Unsorted, or a sector with no job here: the last one a file went to.
        #expect(CaptureRules.job(picked: nil, sector: nil, targets: targets)?.workspace.id == "w2")
        #expect(CaptureRules.job(picked: nil, sector: "ref", targets: targets)?.workspace.id == "w2")
        #expect(CaptureRules.job(picked: nil, sector: nil, targets: []) == nil)
        // The top of the job's own folder unless a save went deeper there.
        #expect(targets.first?.destination().folder == .top(name: "Purdue"))
        #expect(CaptureRules.queuedLine(1, job: "Purdue") == "1 file goes to Purdue.")
        #expect(CaptureRules.queuedLine(3, job: "Purdue") == "3 files go to Purdue.")
    }
}
