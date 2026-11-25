import Foundation
import TempCodeContract

/// Away by kind on the phone (docs/agents/away-from-computer.md, src/shared/away.ts): one switch for Code
/// threads and one for Work threads, each with its tally. A host one release behind sends `enabled` alone
/// and takes `enabled` alone: the phone then shows it one switch, Away, for both.
public enum AwayKinds {
    public enum Kind: String, CaseIterable, Sendable, Hashable {
        case code, work
    }

    /// The host names each kind in its state.
    public static func byKind(_ state: AwayState) -> Bool {
        state.code != nil || state.work != nil
    }

    /// A kind's switch; an older host's `enabled` stands for both.
    public static func on(_ state: AwayState, _ kind: Kind) -> Bool {
        (kind == .code ? state.code : state.work) ?? state.enabled
    }

    /// Any kind is away: a stretch is running.
    public static func any(_ state: AwayState) -> Bool {
        Kind.allCases.contains { on(state, $0) }
    }

    /// When a kind last flipped; an older host's `at` stands for both.
    public static func stamp(_ state: AwayState, _ kind: Kind) -> Int {
        Int((kind == .code ? state.codeAt : state.workAt) ?? state.at)
    }

    /// When the running stretch began: the earliest flip among the kinds that are on. Nil when none is.
    public static func since(_ state: AwayState) -> Int? {
        Kind.allCases.filter { on(state, $0) }.map { stamp(state, $0) }.min()
    }

    /// What `away.set` carries: the kind alone to a host that knows kinds, `enabled` (both) to an older one.
    public static func params(_ kind: Kind?, on: Bool, byKind: Bool) -> Methods.AwaySet.Params {
        guard byKind, let kind else { return .init(enabled: on) }
        return kind == .code ? .init(code: on) : .init(work: on)
    }

    /// A thread's kind from its row: Work when stamped `work`, Code otherwise (a row the lists no longer hold too).
    public static func kind(of scope: SessionScope?) -> Kind {
        scope == .work ? .work : .code
    }

    /// The stretch's decisions by kind, each thread by its row's scope.
    public static func decided(_ tally: AwayDecided, scope: (String) -> SessionScope?) -> [Kind: Int] {
        var out: [Kind: Int] = [:]
        for thread in tally.threads where thread.count > 0 {
            out[kind(of: scope(thread.sessionId)), default: 0] += Int(thread.count)
        }
        return out
    }

    /// One switch of the host menu.
    public struct Switch: Hashable, Sendable, Identifiable {
        /// Nil: an older host's one switch, for both kinds.
        public var kind: Kind?
        public var title: String
        public var on: Bool
        /// Decisions threads of this kind made without him this stretch; 0 shows nothing.
        public var decided: Int

        public var id: String { kind?.rawValue ?? "both" }

        /// "3 decisions", under the title while there are any.
        public var tally: String? {
            decided > 0 ? (decided == 1 ? "1 decision" : "\(decided) decisions") : nil
        }
    }

    /// The host menu's switches: Away for Code and Away for Work, or one Away for an older host.
    public static func switches(_ snapshot: AwaySnapshot, scope: (String) -> SessionScope?) -> [Switch] {
        let counts = decided(snapshot.decided, scope: scope)
        guard byKind(snapshot.state) else {
            return [Switch(kind: nil, title: "Away", on: snapshot.state.enabled, decided: counts.values.reduce(0, +))]
        }
        return Kind.allCases.map { kind in
            Switch(kind: kind, title: kind == .code ? "Away for Code" : "Away for Work", on: on(snapshot.state, kind), decided: counts[kind] ?? 0)
        }
    }
}
