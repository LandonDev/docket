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
        #expect(AwayWords.summary([.off, .on]) == "On")
        #expect(AwayWords.summary([.on, .waiting]) == "On")
        #expect(AwayWords.summary([.off, .off]) == "Off")
    }

    @Test func `a read still out is bones, never Off`() {
        #expect(AwayWords.summary([.waiting]) == nil)
        #expect(AwayWords.summary([.off, .waiting]) == nil)
    }

    @Test func `a computer that could not be read makes Off partial, and none read says nothing`() {
        #expect(AwayWords.summary([.off, .unread, .off]) == "Off on 2 of 3")
        #expect(AwayWords.summary([.unread]) == nil)
        #expect(AwayWords.summary([]) == nil)
    }

    @Test func `each computer by its answer, its read and its link`() {
        #expect(AwayWords.computer(away: true, read: .answered, transport: .open) == .on)
        #expect(AwayWords.computer(away: false, read: .answered, transport: .reconnecting) == .off)
        #expect(AwayWords.computer(away: nil, read: .waiting, transport: .open) == .waiting)
        #expect(AwayWords.computer(away: nil, read: .waiting, transport: .connecting) == .waiting)
        #expect(AwayWords.computer(away: nil, read: .unsupported, transport: .open) == .unread)
        #expect(AwayWords.computer(away: nil, read: .failed("x"), transport: .open) == .unread)
        // Out of reach: an answer held from before is not taken as his setting now.
        #expect(AwayWords.computer(away: false, read: .answered, transport: .offline) == .unread)
        #expect(AwayWords.computer(away: true, read: .answered, transport: .unauthorized) == .unread)
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
        #expect(SignInWords.refusal(refused, link: true) == "That sign-in link is invalid or expired. Make a new link on the computer.")
        #expect(SignInWords.refusal(refused, link: false) == "The computer refused that key. Make a new one on the computer.")
    }

    @Test func `each other refusal in plain words`() {
        #expect(SignInWords.refusal(.invalidPairingLink, link: true) == "That is not a sign-in link. Copy the whole link from the computer.")
        #expect(SignInWords.refusal(.invalidKey, link: false) == "That is not a key. Copy the whole key from the computer.")
        #expect(SignInWords.refusal(.notAClientKey, link: true) == "That key is for a bot. Make a key for this phone on the computer.")
        #expect(SignInWords.refusal(.keyStore("errSecDuplicateItem"), link: true) == "This phone could not keep the key. Try again.")
        #expect(SignInWords.refusal(.api(.rateLimited(retryAfterSeconds: 30)), link: true) == "Too many attempts, try again in 30 s.")
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
