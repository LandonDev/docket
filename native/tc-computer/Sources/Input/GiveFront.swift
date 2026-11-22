import Foundation

/// Gives the front back to the person's app after the service moved it: a `front` hold's restore (§26.4),
/// the session tier's (`input.restoreSession`) and the front guard's undo of a steal (§23.3).
///
/// `NSRunningApplication.activate` comes first: `AXFrontmost` on an app with no window, Finder over the
/// desktop, answers success and does nothing (macOS 27.2, 2026-11-22: 0 of 18 writes took, at any delay,
/// once or twice; `activate` took 3 of 3 in about 31 ms, and so it did on Finder with a window and on any
/// other app). macOS refuses a background caller only the activation of itself, not of another app.
/// `AXFrontmost` follows, as it always worked for an app with a window. Never `NSWorkspace.openApplication`
/// here: it reopens Finder, which leaves a new window behind when it had none. Foundation only; the live
/// writes are GiveFrontLive.swift.
public enum GiveFront {
    public enum Write: Equatable, Sendable {
        case activate
        case axFrontmost
    }

    /// The writes, in order; the second runs whatever the first answered.
    public static let writes: [Write] = [.activate, .axFrontmost]

    /// Each write once, through `write`; true when any was accepted.
    @discardableResult
    public static func give(pid: Int32, write: (Write, Int32) -> Bool) -> Bool {
        writes.reduce(false) { accepted, next in write(next, pid) || accepted }
    }
}
