import Testing
@testable import TempCodeClient

@Suite("AwayWords")
struct AwayWordsTests {
    @Test func `each switch in the desktop's row names`() {
        #expect(AwayWords.title(.code) == "Code threads")
        #expect(AwayWords.title(.work) == "Work threads")
        #expect(AwayWords.title(nil) == "Code and Work threads")
    }

    @Test func `the root row says On while any computer has any kind away`() {
        #expect(AwayWords.summary([]) == "Off")
        #expect(AwayWords.summary([false, false]) == "Off")
        #expect(AwayWords.summary([false, true]) == "On")
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
