/// Every repeating task a screen keeps alive, by name (plan TE_fWkYrofJc §5 "Battery"): a task registers when it
/// starts and leaves when it ends, so the `work-perf` run `rest-today` and Settings → Diagnostics' Work Checks read
/// what is alive. A task's name is one of the clocks docs/IOS-DESIGN.md "Clocks" lists for its screen, and
/// scripts/ios-tick-ledger.test.ts holds every unbounded loop in a Work view to that list. It records in every
/// build: one dictionary write when a task starts and one when it ends.
@MainActor
enum TickLedger {
    private static var alive: [String: Int] = [:]

    static func begin(_ name: String) { alive[name, default: 0] += 1 }

    static func end(_ name: String) {
        alive[name, default: 0] -= 1
        if alive[name] ?? 0 <= 0 { alive[name] = nil }
    }

    /// Each name once per task alive.
    static var names: [String] { alive.sorted { $0.key < $1.key }.flatMap { Array(repeating: $0.key, count: $0.value) } }
}
