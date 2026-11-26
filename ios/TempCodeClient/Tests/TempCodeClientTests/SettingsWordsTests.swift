import Testing
@testable import TempCodeClient

@Suite("AwayWords")
struct AwayWordsTests {
    @Test func `each switch in the desktop's row names`() {
        #expect(AwayWords.title(.code) == "Code threads")
        #expect(AwayWords.title(.work) == "Work threads")
        #expect(AwayWords.title(nil) == "Code and Work threads")
    }

    @Test func `the root row says On while any computer is away, Off only once every one answered Off`() {
        #expect(AwayWords.summary([.switches(on: false), .switches(on: true)]) == "On")
        #expect(AwayWords.summary([.switches(on: true), .waiting]) == "On")
        #expect(AwayWords.summary([.switches(on: false), .switches(on: false)]) == "Off")
    }

    @Test func `a read still out is bones, never Off`() {
        #expect(AwayWords.summary([.waiting]) == nil)
        #expect(AwayWords.summary([.switches(on: false), .waiting]) == nil)
    }

    @Test func `computers that could not be read are counted as not read, never as on`() {
        #expect(AwayWords.summary([.switches(on: false), .unreachable, .unreachable, .unsupported, .failed("x")]) == "Off, 4 not read")
        #expect(AwayWords.summary([.switches(on: false), .unreachable]) == "Off, 1 not read")
    }

    @Test func `every read settled and none answered: Not read, so the bones end`() {
        #expect(AwayWords.summary([.unreachable, .unreachable]) == "Not read")
        #expect(AwayWords.summary([.failed("x"), .unsupported]) == "Not read")
    }

    @Test func `switches only once this link's read answered`() {
        #expect(AwayWords.section(away: true, read: .answered, transport: .open) == .switches(on: true))
        #expect(AwayWords.section(away: false, read: .answered, transport: .reconnecting) == .switches(on: false))
        #expect(AwayWords.section(away: nil, read: .answered, transport: .open) == .waiting)
        // A held answer from before does not count until the new read answers, nor after it fails.
        #expect(AwayWords.section(away: false, read: .waiting, transport: .open) == .waiting)
        #expect(AwayWords.section(away: true, read: .failed("The box did not answer."), transport: .open) == .failed("The box did not answer."))
        #expect(AwayWords.section(away: nil, read: .unsupported, transport: .open) == .unsupported)
        // Out of reach: whatever is held.
        #expect(AwayWords.section(away: false, read: .answered, transport: .offline) == .unreachable)
        #expect(AwayWords.section(away: true, read: .waiting, transport: .unauthorized) == .unreachable)
        #expect(AwayWords.Section.switches(on: false).answered)
        #expect(!AwayWords.Section.waiting.answered)
    }
}

@Suite("WorkRowState")
struct WorkRowStateTests {
    @Test func `shown once any computer has answered, on or off`() {
        #expect(WorkRowState.of([(answered: false, settled: false), (answered: true, settled: true)]) == .shown)
    }

    @Test func `waiting in its place while a computer has yet to connect`() {
        #expect(WorkRowState.of([(answered: false, settled: false)]) == .waiting)
        #expect(WorkRowState.of([(answered: false, settled: true), (answered: false, settled: false)]) == .waiting)
    }

    @Test func `gone when every computer is connected and none knows Work`() {
        #expect(WorkRowState.of([(answered: false, settled: true)]) == .hidden)
        #expect(WorkRowState.of([]) == .hidden)
    }
}

@Suite("SignInWords")
struct SignInWordsTests {
    @Test func `an expired link says so and the way forward, never the host's pairing code`() {
        let refused = EnvironmentStoreError.api(.unauthorized("invalid or expired pairing code"))
        #expect(SignInWords.refusal(refused, link: true) == "That sign-in link is invalid or expired. Make a new one with Add… under Who can sign in (on a Mac, in Sharing).")
        #expect(SignInWords.refusal(refused, link: false) == "The computer refused that key. Make a new one with Add… under Who can sign in (on a Mac, in Sharing).")
    }

    @Test func `each other refusal in plain words`() {
        #expect(SignInWords.refusal(.invalidPairingLink, link: true) == "That is not a sign-in link. Copy the whole link from the computer.")
        #expect(SignInWords.refusal(.invalidKey, link: false) == "That is not a key. Copy the whole key from the computer.")
        #expect(SignInWords.refusal(.notAClientKey, link: true) == "That key is for a bot. Make a key for this phone on the computer.")
        #expect(SignInWords.refusal(.keyStore("errSecDuplicateItem"), link: true) == "This phone could not keep the key. Try again.")
        #expect(SignInWords.refusal(.api(.rateLimited(retryAfterSeconds: 30)), link: true) == "Too many attempts, try again in 30 s.")
    }
}

@Suite("SignInWords hints")
struct SignInHintTests {
    @Test func `the hints name the press, and where it is on a Mac`() {
        #expect(SignInWords.linkHint == "In Docket's Settings, press Add… under Who can sign in (on a Mac, in Sharing), then paste the link here.")
        #expect(SignInWords.keyHint == "In Docket's Settings, make a key with Add… under Who can sign in (on a Mac, in Sharing), then enter it here with the computer's address.")
        #expect(SignInWords.refusedKeyHint == "In Docket's Settings, press Add… under Who can sign in (on a Mac, in Sharing), then sign in again.")
    }

    @Test func `every way back to a sign-in names the same press, never a page only one kind of computer has`() {
        let expired = SignInWords.refusal(.api(.unauthorized("invalid or expired pairing code")), link: true)
        for line in [SignInWords.linkHint, SignInWords.keyHint, SignInWords.refusedKeyHint, expired] {
            #expect(line.contains(SignInWords.route))
            #expect(!line.contains("computer's page"))
            #expect(!line.contains("Settings → Sharing"))
        }
    }
}

@Suite("NotificationWords")
struct NotificationWordsTests {
    @Test func `the switch's own On and Off are not said again beside it`() {
        #expect(NotificationWords.beside("On") == nil)
        #expect(NotificationWords.beside("Off") == nil)
    }

    @Test func `a state the switch cannot show is said`() {
        #expect(NotificationWords.beside("Registering…") == "Registering…")
        #expect(NotificationWords.beside("No relay") == "No relay")
        #expect(NotificationWords.beside("Failed") == "Failed")
        #expect(NotificationWords.beside("Not allowed") == "Not allowed")
    }
}
