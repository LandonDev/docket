import Foundation

/// Gives the front back to the person's app after the service moved it: a `front` hold's restore (§26.4),
/// the session tier's (`input.restoreSession`) and the front guard's undo of a steal (§23.3).
///
/// `NSRunningApplication.activate` first: `AXFrontmost` on an app with no window, Finder over the desktop,
/// answers success and does nothing (macOS 27.2, 2026-11-22: 0 of 18 writes took, at any delay, once or
/// twice; `activate` took 3 of 3 in about 31 ms, and so it did on Finder with a window and on any other
/// app). macOS refuses a background caller only the activation of itself, not of another app.
/// `AXFrontmost` only when `activate` was refused or the app is not front `fallbackMs` later: written right
/// after an `activate` that took, it let the next app launched in the background take the front (6 of 10
/// trials; either write alone, 0 of 20). Never `NSWorkspace.openApplication` here: it reopens Finder, which
/// leaves a new window behind when it had none. Foundation only; the live writes are GiveFrontLive.swift.
public enum GiveFront {
    public enum Write: Equatable, Sendable {
        case activate
        case axFrontmost
    }

    /// how long `activate` has to bring the app front before `AXFrontmost` is written
    public static let fallbackMs = 100
    /// how often the front is read meanwhile
    public static let pollMs = 10

    /// `activate`, then `AXFrontmost` only if the app is not front by `fallbackMs`; true when it is front,
    /// or a write was accepted (the caller polls the front itself).
    @discardableResult
    public static func give(pid: Int32, write: (Write, Int32) -> Bool, isFront: () -> Bool, sleep: (Int) -> Void) -> Bool {
        if write(.activate, pid) {
            var waited = 0
            while true {
                if isFront() { return true }
                if waited >= fallbackMs { break }
                sleep(pollMs)
                waited += pollMs
            }
            _ = write(.axFrontmost, pid)
            return true
        }
        return write(.axFrontmost, pid)
    }
}
