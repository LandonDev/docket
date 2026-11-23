import Foundation
import Testing
@testable import TempCodeClient

/// A show on a scripted host. Each press is taken when it arrives, in order, as the host would; its answer can
/// be held back and let go in any order, to stand for a slow network.
@MainActor
final class FakeClickerHost {
    var current: ClickerShow?
    var calls: [String] = []
    var refusal: String?
    var holding = false
    private var gates: [Int: CheckedContinuation<Void, Never>] = [:]
    /// Answers held back so far, let go or not.
    private var held = 0

    init(_ show: ClickerShow?) {
        current = show
    }

    var wire: ClickerWire {
        ClickerWire(state: { self.current }, press: { press, rev in try await self.press(press, rev) })
    }

    private func press(_ press: ClickerPress, _ rev: Int) async throws -> ClickerShow? {
        calls.append("\(press.rawValue) \(rev)")
        let index = calls.count - 1
        let answer: Result<ClickerShow?, ClickerRefusal>
        if let refusal {
            answer = .failure(ClickerRefusal(refusal))
        } else if var show = current {
            switch press {
            case .next: show.slide += 1
            case .previous: show.slide -= 1
            case .blank: show.blank.toggle()
            case .end: break
            }
            if show.notesSlide != show.slide {
                show.notes = "Notes \(show.slide)"
                show.notesSlide = show.slide
            }
            show.rev += 1
            current = press == .end ? nil : show
            answer = .success(current)
        } else {
            answer = .success(nil)
        }
        if holding {
            await withCheckedContinuation {
                gates[index] = $0
                held += 1
            }
        }
        return try answer.get()
    }

    /// Lets the answer to the call at `index` go.
    func release(_ index: Int) {
        gates.removeValue(forKey: index)?.resume()
    }

    func waitForCalls(_ count: Int) async {
        while calls.count < count || (holding && held < count) { await Task.yield() }
    }
}

@MainActor
@Suite struct ClickerModelTests {
    private let show = ClickerShow(itemId: "deck", name: "Nationals kickoff", slide: 4, count: 12, notes: "Welcome the teams.", startedAt: 1_000, rev: 7)

    private func loaded(_ show: ClickerShow?) async -> (ClickerModel, FakeClickerHost) {
        let host = FakeClickerHost(show)
        let model = ClickerModel(wire: host.wire)
        await model.load()
        return (model, host)
    }

    @Test func `the show loads`() async {
        let (model, _) = await loaded(show)
        #expect(model.loaded)
        #expect(model.show == show)
        #expect(model.show?.position == "4 / 12")
        #expect(!model.ended)
    }

    @Test func `no show running when the screen opens reads as ended; a failed read keeps its words`() async {
        let (model, _) = await loaded(nil)
        #expect(model.loaded)
        #expect(model.ended)
        let failing = ClickerModel(wire: ClickerWire(state: { throw ClickerRefusal("The box did not answer.") }, press: { _, _ in nil }))
        await failing.load()
        #expect(!failing.loaded)
        #expect(failing.failure == "The box did not answer.")
    }

    @Test func `a press moves the count at once and sends the press with the rev it was made on`() async {
        let (model, host) = await loaded(show)
        #expect(model.press(.next))
        #expect(model.show?.slide == 5, "before the host answers")
        #expect(host.calls.isEmpty, "sent in a task of its own")
        await model.settle()
        #expect(host.calls == ["next 7"])
        #expect(model.show == host.current)
        #expect(model.show?.rev == 8)
        #expect(model.press(.previous))
        await model.settle()
        #expect(host.calls == ["next 7", "previous 8"])
        #expect(model.show?.slide == 4)
    }

    @Test func `Blank turns at once and the host's answer stands`() async {
        let (model, host) = await loaded(show)
        #expect(model.press(.blank))
        #expect(model.show?.blank == true)
        await model.settle()
        #expect(host.calls == ["blank 7"])
        #expect(model.show?.blank == true)
    }

    @Test func `Next on the last slide and Previous on the first send nothing`() async {
        var last = show
        last.slide = 12
        let (atEnd, endHost) = await loaded(last)
        #expect(!atEnd.press(.next))
        #expect(atEnd.show?.slide == 12)
        var first = show
        first.slide = 1
        let (atStart, startHost) = await loaded(first)
        #expect(!atStart.press(.previous))
        await atEnd.settle()
        await atStart.settle()
        #expect(endHost.calls.isEmpty)
        #expect(startHost.calls.isEmpty)
        #expect(atStart.press(.next), "the other way still steps")
    }

    @Test func `another device's press arrives as a push and moves the count; an older push is ignored`() async {
        let (model, _) = await loaded(show)
        var moved = show
        moved.slide = 9
        moved.notes = "Thank the sponsors."
        moved.notesSlide = 9
        moved.rev = 11
        model.apply(moved)
        #expect(model.show?.slide == 9)
        #expect(model.show?.notes == "Thank the sponsors.")
        var stale = show
        stale.slide = 2
        stale.rev = 10
        model.apply(stale)
        #expect(model.show?.slide == 9)
    }

    @Test func `the show ending, by a push or by End Show, says so`() async {
        let (pushed, _) = await loaded(show)
        pushed.apply(nil)
        #expect(pushed.ended)
        #expect(pushed.show == nil)
        #expect(!pushed.press(.next), "nothing to press")

        let (ending, host) = await loaded(show)
        #expect(ending.press(.end))
        #expect(!ending.ended, "the screen waits for the host to end it")
        await ending.settle()
        #expect(host.calls == ["end 7"])
        #expect(ending.ended)
    }

    @Test func `a refused press puts the slide back and keeps the host's words until a press lands`() async {
        let (model, host) = await loaded(show)
        host.refusal = "This key can read, not act."
        #expect(model.press(.next))
        #expect(model.show?.slide == 5)
        await model.settle()
        #expect(model.show?.slide == 4)
        #expect(model.show?.rev == 7)
        #expect(model.refusal == "This key can read, not act.")
        host.refusal = nil
        #expect(model.press(.next))
        await model.settle()
        #expect(model.refusal == nil)
        #expect(model.show?.slide == 5)
    }

    @Test func `two quick presses reach the wire in order, the second on the rev the first left`() async {
        let (model, host) = await loaded(show)
        host.holding = true
        #expect(model.press(.next))
        #expect(model.press(.next))
        #expect(model.show?.slide == 6, "the count follows his finger")
        await host.waitForCalls(1)
        await Task.yield()
        #expect(host.calls == ["next 7"], "the second waits for the first's answer")
        host.release(0)
        await host.waitForCalls(2)
        #expect(host.calls == ["next 7", "next 8"])
        #expect(model.show?.slide == 6, "the count never steps back between the two answers")
        host.release(1)
        await model.settle()
        #expect(model.show?.slide == 6)
        #expect(model.show?.rev == 9)
        #expect(model.show == host.current)
    }

    @Test func `a refused first press drops the presses queued behind it and puts the count back`() async {
        let (model, host) = await loaded(show)
        host.holding = true
        host.refusal = "This key can read, not act."
        #expect(model.press(.next))
        #expect(model.press(.next))
        #expect(model.press(.blank))
        await host.waitForCalls(1)
        host.release(0)
        await model.settle()
        #expect(host.calls == ["next 7"])
        #expect(model.show == show)
        #expect(model.refusal == "This key can read, not act.")
    }

    @Test func `a push behind his presses on the way does not pull the count back`() async {
        let (model, host) = await loaded(show)
        host.holding = true
        #expect(model.press(.next))
        #expect(model.press(.next))
        await host.waitForCalls(1)
        var echo = show
        echo.slide = 5
        echo.rev = 8
        model.apply(echo)
        #expect(model.show?.slide == 6)
        host.release(0)
        await host.waitForCalls(2)
        host.release(1)
        await model.settle()
        #expect(model.show?.slide == 6)
    }

    @Test func `the notes never show another slide's words: none until the host says the new slide's`() async {
        let (model, host) = await loaded(show)
        #expect(model.notes == "Welcome the teams.")
        host.holding = true
        #expect(model.press(.next))
        #expect(model.show?.slide == 5)
        #expect(model.notes == nil, "slide 4's notes are not slide 5's")
        await host.waitForCalls(1)
        host.release(0)
        await model.settle()
        #expect(model.notes == "Notes 5")
    }

    @Test func `the host's notes are taken as soon as they match the slide, with presses still on the way`() async {
        let (model, host) = await loaded(show)
        host.holding = true
        #expect(model.press(.next))
        #expect(model.press(.blank))
        await host.waitForCalls(1)
        #expect(model.notes == nil)
        host.release(0)
        await host.waitForCalls(2)
        #expect(model.notes == "Notes 5", "slide 5's notes, while Blank is on its way")
        #expect(model.show?.blank == true)
        host.release(1)
        await model.settle()
        #expect(model.notes == "Notes 5")
    }

    @Test func `a show that carries every slide's notes gives the new slide's at once`() async {
        var all = show
        all.allNotes = (1...12).map { "Notes \($0)" }
        let (model, host) = await loaded(all)
        host.holding = true
        #expect(model.press(.next))
        #expect(model.notes == "Notes 5", "before the host answers")
        #expect(model.press(.previous))
        #expect(model.press(.previous))
        #expect(model.notes == "Notes 3")
        await host.waitForCalls(1)
        host.release(0)
        await host.waitForCalls(2)
        host.release(1)
        await host.waitForCalls(3)
        host.release(2)
        await model.settle()
        #expect(model.show?.slide == 3)
        #expect(model.notes == "Notes 3")
    }

    @Test func `a pushed show whose notes are for another slide shows none`() async {
        let (model, _) = await loaded(show)
        var pushed = show
        pushed.slide = 6
        pushed.rev = 9
        model.apply(pushed)
        #expect(model.show?.slide == 6)
        #expect(model.notes == nil)
    }
}
