#if DEBUG
import Foundation
import TempCodeClient

/// A show held in memory, for the clicker's shots (`TC_TEST_CLICKER`): no host has the show's wire yet.
/// `show` (slide 4), `first`, `last`, `blank`, `ended`, `refused` (a press is refused in the host's words),
/// `nonotes`.
@MainActor
enum ClickerFake {
    static let notes = [
        "Welcome everyone to the Nationals kickoff. Thank the teams for travelling and the staff for the early start.",
        "The weekend at a glance: check-in Friday from 5, group stage Saturday, playoffs and the final Sunday afternoon.",
        "Check-in runs at the CoRec front desk. Every player needs a photo ID and their signed waiver.",
        "Match rules: best of three in the groups, best of five from the quarter-finals. Pauses go through the admin desk only. Remind captains that a no-show at ten minutes is a forfeit.",
        "Stage times are posted on the board by the entrance and in the team channel. Captains confirm by 9 each morning.",
        "Food: the hall opens at 11 and 5. Teams on stage at those times get boxes delivered.",
        "Streaming: the two feature matches each round go out on the main channel. Casters meet at the booth 30 minutes early.",
        "Conduct: one warning, then a map loss. Anything on the stream is reviewed after the match.",
        "Prizes and the trophy go out after the final on the main stage. Photos straight after.",
        "Sponsors: thank RecWell, the student union and the three local partners by name.",
        "Questions go to the admin desk or the team channel. Medical help is at the front desk all weekend.",
        "Good luck to every team. First matches start at 9 tomorrow, so get some sleep.",
    ]

    static func model(_ state: String) -> ClickerModel {
        let start = Date().addingTimeInterval(-12 * 60).timeIntervalSince1970 * 1000
        var show = ClickerShow(itemId: "fake-deck", name: "Nationals kickoff", slide: 4, count: notes.count, notes: notes[3], startedAt: start, rev: 1)
        switch state {
        case "first": show.slide = 1
        case "last": show.slide = notes.count
        case "blank": show.blank = true
        default: break
        }
        show.notes = state == "nonotes" ? "" : notes[show.slide - 1]
        show.notesSlide = show.slide
        let held = Held(state == "ended" ? nil : show, refusing: state == "refused")
        let model = ClickerModel(wire: held.wire)
        if state == "refused" {
            Task {
                await model.load()
                model.press(.next)
            }
        }
        return model
    }

    /// The show as a host would keep it: each press moves it and its `rev`.
    @MainActor
    private final class Held {
        var show: ClickerShow?
        let refusing: Bool

        init(_ show: ClickerShow?, refusing: Bool) {
            self.show = show
            self.refusing = refusing
        }

        var wire: ClickerWire {
            ClickerWire(state: { self.show }, press: { press, _ in try self.press(press) })
        }

        private func press(_ press: ClickerPress) throws -> ClickerShow? {
            if refusing { throw ClickerRefusal("This key can read, not act.") }
            guard var show else { return nil }
            switch press {
            case .next: show.slide = min(show.count, show.slide + 1)
            case .previous: show.slide = max(1, show.slide - 1)
            case .blank: show.blank.toggle()
            case .end:
                self.show = nil
                return nil
            }
            show.notes = ClickerFake.notes[show.slide - 1]
            show.notesSlide = show.slide
            show.rev += 1
            self.show = show
            return show
        }
    }
}
#endif
