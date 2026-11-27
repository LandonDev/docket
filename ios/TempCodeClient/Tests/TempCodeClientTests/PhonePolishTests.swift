import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// The phone's non-Work screens, polished: the rules behind their states and
/// words, one suite each (docs/IOS-DESIGN.md).
@Suite struct CatalogSlotTests {
    @Test func `a fresh draft spins until the catalog lands, never guessing a provider`() {
        #expect(CatalogLoad.slot(hasCatalog: false, modelKnown: false, failed: false, retrying: false) == .spinner)
        #expect(CatalogLoad.slot(hasCatalog: true, modelKnown: true, failed: false, retrying: false) == .picked)
        // A thread's own model is known before its catalog: its glyph and name are facts, not a guess.
        #expect(CatalogLoad.slot(hasCatalog: false, modelKnown: true, failed: false, retrying: false) == .picked)
    }

    @Test func `the failed line holds through Retry until the ask answers`() {
        #expect(CatalogLoad.slot(hasCatalog: false, modelKnown: false, failed: true, retrying: false) == .failed(retrying: false))
        #expect(CatalogLoad.slot(hasCatalog: false, modelKnown: false, failed: false, retrying: true) == .failed(retrying: true))
    }
}

/// A notice's subtitle with two hosts (Push/HostDirectory.swift, linked under Shared/).
@Suite struct PushSubtitleTests {
    let hosts = ["env_mac": "Mac", "env_box": "Build box"]

    @Test func `the host joins with "on", under the name he gave it`() {
        let tc: [AnyHashable: Any] = ["environmentId": "env_box", "host": "box"]
        #expect(HostDirectory.subtitle("temp-code", tc: tc, hosts: hosts) == "temp-code on Build box")
        #expect(HostDirectory.subtitle("", tc: tc, hosts: hosts) == "Build box")
    }

    @Test func `the host's own name when the directory lacks it, nothing with one host or none named`() {
        #expect(HostDirectory.subtitle("temp-code", tc: ["environmentId": "env_gone", "host": "box"], hosts: hosts) == "temp-code on box")
        #expect(HostDirectory.subtitle("temp-code", tc: ["environmentId": "env_box", "host": "box"], hosts: ["env_box": "box"]) == nil)
        #expect(HostDirectory.subtitle("temp-code", tc: [:], hosts: hosts) == nil)
        #expect(HostDirectory.subtitle("temp-code", tc: ["host": ""], hosts: hosts) == nil)
    }
}

/// What Search shows over an empty list (`SearchStatus`).
@Suite struct SearchStatusTests {
    @Test func `computers still connecting spin, never "Every computer is offline."`() {
        #expect(SearchStatus.of(paired: 2, open: 0, connecting: 1, queryLength: 0, searching: false, answered: false) == .spinner)
        #expect(SearchStatus.of(paired: 2, open: 0, connecting: 0, queryLength: 5, searching: false, answered: false) == .offline)
    }

    @Test func `nothing paired offers pairing, and no hint repeats the field's prompt`() {
        #expect(SearchStatus.of(paired: 0, open: 0, connecting: 0, queryLength: 0, searching: false, answered: false) == .noHosts)
        #expect(SearchStatus.of(paired: 1, open: 1, connecting: 0, queryLength: 1, searching: false, answered: false) == .none)
    }

    @Test func `a query spins while out, then says no results only for its own answer`() {
        #expect(SearchStatus.of(paired: 1, open: 1, connecting: 0, queryLength: 4, searching: true, answered: false) == .spinner)
        #expect(SearchStatus.of(paired: 1, open: 1, connecting: 0, queryLength: 4, searching: false, answered: true) == .noResults)
        #expect(SearchStatus.of(paired: 1, open: 1, connecting: 0, queryLength: 4, searching: false, answered: false) == .none)
    }

    @Test func `a query whose reads failed names the computers instead of "No Results"`() {
        let mac = SearchHostFoot(environmentId: "a", name: "Mac", state: .answered(ms: 120))
        let box = SearchHostFoot(environmentId: "b", name: "box", state: .failed)
        let mini = SearchHostFoot(environmentId: "c", name: "Mac mini", state: .failed)
        let away = SearchHostFoot(environmentId: "d", name: "PC", state: .offline)
        #expect(SearchStatus.of(paired: 2, open: 2, connecting: 0, queryLength: 4, searching: false, answered: true, hosts: [box, mini]) == .failed(["box", "Mac mini"]))
        #expect(SearchStatus.of(paired: 3, open: 2, connecting: 0, queryLength: 4, searching: false, answered: true, hosts: [mac, box, away]) == .noResultsFailed(["box"]))
        #expect(SearchStatus.of(paired: 2, open: 1, connecting: 0, queryLength: 4, searching: false, answered: true, hosts: [mac, away]) == .noResults)
        #expect(SearchStatus.failedLine(["box"]) == "Couldn't search box.")
        #expect(SearchStatus.failedLine(["box", "Mac"]) == "Couldn't search box or Mac.")
        #expect(SearchStatus.failedLine(["box", "Mac", "Mac mini"]) == "Couldn't search box, Mac or Mac mini.")
    }
}

/// Home holds a reconnecting host 1.5 s before its status row (`HomeSections.troubled`).
@Suite struct HomeHoldTests {
    @Test func `a blink gets no row, a held drop does, a refusal at once`() {
        let reconnecting = EnvironmentStatus(transport: .reconnecting)
        #expect(!HomeSections.troubled(reconnecting, awayMs: 400))
        #expect(HomeSections.troubled(reconnecting, awayMs: 1_500))
        #expect(HomeSections.troubled(EnvironmentStatus(transport: .unauthorized), awayMs: 0))
        #expect(HomeSections.troubled(EnvironmentStatus(transport: .offline), awayMs: 0))
        let unreachable = EnvironmentStatus(transport: .connecting, nextRetryAt: 5, attempts: 1)
        #expect(!HomeSections.troubled(unreachable, awayMs: 100))
        #expect(HomeSections.troubled(unreachable, awayMs: 2_000))
        #expect(!HomeSections.troubled(EnvironmentStatus(transport: .open), awayMs: 9_000))
    }
}

/// No screen shows a Swift dump: `ActionError.wrap` ends in plain words.
@Suite struct ActionErrorWrapTests {
    private enum Bare: Error { case broke }
    private struct Said: Error, CustomStringConvertible { let description: String }

    @Test func `an error with no sentence reads plainly, one with a sentence keeps it`() {
        #expect(ActionError.wrap(TransportError.cancelled).message == "That didn't go through")
        #expect(ActionError.wrap(Bare.broke).message == ActionError.plainFallback)
        #expect(ActionError.wrap(NSError(domain: "x", code: 3)).message == ActionError.plainFallback)
        #expect(ActionError.wrap(Said(description: "MacBook is out of reach.")).message == "MacBook is out of reach.")
        // The system's own errors say a sentence, never "Error Domain=…".
        #expect(!ActionError.wrap(URLError(.timedOut)).message.contains("Domain="))
    }

    @Test func `the host's own words and the blocks still come through`() {
        #expect(ActionError.wrap(TransportError.server(method: "session.rename", message: "unknown session")).message == "unknown session")
        #expect(ActionError.wrap(ActionError.refused(message: "No", forbidden: false)).message == "No")
    }
}

/// A host's own notice has no thread: its tap lands on Hosts, never nowhere.
@Suite struct PushHostEventTests {
    @Test func `host_down and host_up open Hosts`() {
        let down = PushTarget(userInfo: ["tc": ["environmentId": "env_box", "event": "host_down"]])
        #expect(down?.hostEvent == true)
        #expect(down?.route == .hosts)
        #expect(PushTarget(userInfo: ["tc": ["environmentId": "env_box", "event": "host_up"]])?.route == .hosts)
    }

    @Test func `any other notice without a thread still opens nothing`() {
        #expect(PushTarget(userInfo: ["tc": ["environmentId": "env_box", "event": "finished"]]) == nil)
        #expect(PushTarget(userInfo: ["tc": ["event": "host_down"]]) == nil)
    }
}

/// A question resolved with nothing chosen says Dismissed, not an empty card.
@Suite struct QuestionDismissedTests {
    @Test func `resolved with no answer, or only blanks, is dismissed`() {
        #expect(CardDecision.dismissed(resolved: true, answers: nil))
        #expect(CardDecision.dismissed(resolved: true, answers: [[], [" "]]))
        #expect(!CardDecision.dismissed(resolved: true, answers: [["Yes"]]))
        #expect(!CardDecision.dismissed(resolved: false, answers: nil))
    }
}

/// The slot's words beside a mark that already says the state (`StripWords.drawn`).
@Suite struct StripWordsDrawnTests {
    @Test func `a stopped or queued mark leads with the detail, never the word again`() {
        #expect(StripWords.stopped.drawn(markSaysIt: true) == (nil, "The harness is gone"))
        #expect(StripWords(title: "Queued", detail: "Waiting for memory").drawn(markSaysIt: true) == (nil, "Waiting for memory"))
        // With nothing more to say, the word stays: a mark alone beside a clock would say too little.
        #expect(StripWords(title: "Queued").drawn(markSaysIt: true) == ("Queued", nil))
        #expect(StripWords.paused(batch: 2).drawn(markSaysIt: false) == ("Paused", "and 2 batch threads with it"))
    }
}

/// A project's archive is one menu away in every pose (`ThreadStripRules.showsRecent`).
@Suite struct RecentMenuTests {
    @Test func `the open Duo keeps the menu for the archive`() {
        #expect(ThreadStripRules.showsRecent(split: true, shelf: true, archived: true))
        #expect(!ThreadStripRules.showsRecent(split: true, shelf: true, archived: false))
        #expect(ThreadStripRules.showsRecent(split: false, shelf: true, archived: false))
        #expect(!ThreadStripRules.showsRecent(split: false, shelf: false, archived: false))
    }
}

/// The project plan's start rows and the research report's state, each said once.
@Suite struct PlanAndReportWordsTests {
    @Test func `the plan's start rows take the desktop's words`() {
        #expect(ProjectPlan.planLabel(next: 3) == "Plan milestone 3")
        #expect(ProjectPlan.orchestrateLabel(next: 3) == "Orchestrate milestone 3")
        #expect(ProjectPlan.planLabel(next: nil) == "Plan the next milestone")
    }

    @Test func `a report is complete, in progress, or stopped`() {
        #expect(ReportStateWord.of(complete: true, running: true) == "Complete")
        #expect(ReportStateWord.of(complete: false, running: true) == "In progress")
        #expect(ReportStateWord.of(complete: false, running: false) == "Stopped")
    }
}

/// A refused batch switch's alert: what did not happen as the title, why as the message.
@Suite struct BoardFailureWordsTests {
    @Test func `the title counts, the message names the first refusal`() {
        let words = BoardActions.failureWords(.pause, failed: 2, firstTitle: "Backfill", firstError: "not running")
        #expect(words.title == "Couldn't pause 2 threads")
        #expect(words.message == "Backfill: not running")
        #expect(BoardActions.failureWords(.archive, failed: 1, firstTitle: "A", firstError: "e").title == "Couldn't archive 1 thread")
    }
}
