import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// A LifeOS session that cannot read, in the one rule Today, Mail, Tasks, Agenda, People and Messages share
/// (Work/Today/LifeosDown.swift), held to the desktop's lifeosDown.ts and lifeosWords.ts.
@Suite struct LifeosDownTests {
    @Test func theStateAHostNamesIsItsDownStateAndAConnectIsAWait() {
        #expect(TodayDown.of(state: "signed-out") == .signedOut)
        // The token's own fallback name for a refusal with no state.
        #expect(TodayDown.of(state: "signedOut") == .signedOut)
        #expect(TodayDown.of(state: "refused") == .refused)
        #expect(TodayDown.of(state: "pairing") == .pairing)
        #expect(TodayDown.of(state: "off") == .off)
        #expect(TodayDown.of(state: "unreachable") == .unreachable)
        #expect(TodayDown.of(state: "connecting") == nil)
        #expect(TodayDown.of(state: "connected") == nil)
        // The host's own silence, or a state this build does not know.
        #expect(TodayDown.of(state: nil) == .unanswered)
        #expect(TodayDown.of(state: "asleep") == .unanswered)
    }

    @Test func theWordsNameTheComputer() {
        #expect(TodayDown.signedOut.words(host: "The box") == "Not signed in to LifeOS on the box")
        #expect(TodayDown.unreachable.words(host: "The box") == "LifeOS did not answer the box")
        #expect(TodayDown.unanswered.words(host: "the box") == "The box did not answer")
        #expect(TodayDown.refused.words(host: "Mac") == "LifeOS refused Mac’s sign-in")
        #expect(TodayDown.pairing.words(host: "The box") == "The LifeOS sign-in on the box waits for your approval")
        #expect(TodayDown.off.words(host: "The box") == "Work is off on the box")
        #expect(TodayDown.signedOut.words(host: nil) == "Not signed in to LifeOS")
        #expect(LifeosWords.connecting(host: "The box") == "LifeOS is still connecting on the box")
        #expect(LifeosWords.connecting(host: nil) == "LifeOS is still connecting")
        #expect(LifeosWords.signInElsewhere(host: "The box") == "Sign in from a computer that manages the box")
    }

    /// Try Again only for silence; a sign-in missing, refused or waiting is mended on a computer.
    @Test func onlySilenceIsAskedAgain() {
        #expect(TodayDown.unreachable.isSilence && TodayDown.unanswered.isSilence)
        for down in [TodayDown.signedOut, .refused, .pairing, .off, .withheld, .locked] { #expect(!down.isSilence) }
        #expect(TodayDown.signedOut.wantsSignIn && TodayDown.refused.wantsSignIn && TodayDown.pairing.wantsSignIn)
        for down in [TodayDown.off, .unreachable, .unanswered, .withheld, .locked] { #expect(!down.wantsSignIn) }
    }

    /// Every place that reads LifeOS offers the one press Mail does: People and Messages included (round 5, sitting F).
    @Test func aSignInOffersOpenOnTheComputerWhereThisKeyMay() {
        #expect(LifeosPress.of(.signedOut, connecting: false, maySignIn: true, host: "Mac") == .open("Open on Mac"))
        #expect(LifeosPress.of(.refused, connecting: false, maySignIn: true, host: "Mac") == .open("Open on Mac"))
        #expect(LifeosPress.of(.signedOut, connecting: false, maySignIn: false, host: "Mac") == LifeosPress.none)
        #expect(LifeosPress.of(.unanswered, connecting: false, maySignIn: false, host: "Mac") == .tryAgain)
        #expect(LifeosPress.of(.off, connecting: false, maySignIn: true, host: "Mac") == LifeosPress.none)
        #expect(LifeosPress.of(nil, connecting: true, maySignIn: true, host: "Mac") == .wait)
        #expect(LifeosPress.of(nil, connecting: false, maySignIn: true, host: "Mac") == LifeosPress.none)
        // A sign-in this key may not open says where it is mended, after the reason in a list's one line.
        #expect(LifeosPress.elsewhere(.signedOut, maySignIn: false, host: "The box") == "Sign in from a computer that manages the box")
        #expect(LifeosPress.elsewhere(.signedOut, maySignIn: true, host: "The box") == nil)
        #expect(LifeosPress.elsewhere(.unanswered, maySignIn: false, host: "The box") == nil)
        #expect(LifeosPress.line("Not signed in to LifeOS on Mac", down: .signedOut, maySignIn: false, host: "Mac")
            == "Not signed in to LifeOS on Mac. Sign in from a computer that manages Mac.")
        #expect(LifeosPress.line("LifeOS did not answer.", down: nil, maySignIn: false, host: "Mac") == "LifeOS did not answer.")
    }

    /// The `@` list's line about LifeOS follows the host's status as it lands: an answer read before the host said its
    /// state and one read after say the one state in one way (m4-01 said "did not answer", m4-30 "Not signed in").
    @MainActor @Test func theMentionLineFollowsTheHostsStatus() async {
        var state: String?
        let ask = MentionAsk(fetch: { _ in MentionAnswer(hits: [], failed: [.task]) },
                             failWords: { MentionWords.failed($0, lifeos: state, host: "The box") },
                             sleep: { _ in })
        await ask.ask("")
        #expect(ask.note == "LifeOS did not answer the box")
        state = "signed-out"
        #expect(ask.note == "Not signed in to LifeOS on the box")
    }
}
