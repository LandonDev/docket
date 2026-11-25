#if canImport(os)
import os
#endif

/// The app's signposts, under the subsystem `dev.landon.tempcode`, one
/// category each (docs/IOS-DESIGN.md "The Work perf proof"). Instruments'
/// Points of Interest and os_signpost tracks show them on the phone; they
/// cost a few nanoseconds when nothing is recording. Where `os` is missing
/// (the package's tests on Linux) every call does nothing.
///
///     Signposts.launch.event("firstFrame")
///     let mark = Signposts.file.begin("first")
///     …
///     mark.end()
public struct Signposts: Sendable {
    /// A cold launch: `firstFrame` when the root view's first frame is on
    /// screen, `cachedRow` when Home's first row from the cache is on screen.
    /// The process start is the system's, read from `sysctl` (`LaunchMarks`).
    public static let launch = Signposts(category: "launch")
    /// Unused until a Work place lists: an interval from a place opening to its first rows on screen.
    public static let list = Signposts(category: "list")
    /// Unused until the first page lands: `first`, a file opened to its first page, and `whole`, to its last byte.
    public static let file = Signposts(category: "file")
    /// Unused until the presses are marked: an interval from a press to the host's answer.
    public static let press = Signposts(category: "press")

    public static let subsystem = "dev.landon.tempcode"

    #if canImport(os)
    private let signposter: OSSignposter
    #endif

    private init(category: String) {
        #if canImport(os)
        signposter = OSSignposter(subsystem: Self.subsystem, category: category)
        #endif
    }

    /// One point in time.
    public func event(_ name: StaticString) {
        #if canImport(os)
        signposter.emitEvent(name)
        #endif
    }

    /// The start of an interval; `end()` closes it. Two may overlap.
    public func begin(_ name: StaticString) -> Interval {
        #if canImport(os)
        Interval(signposter: signposter, name: name, state: signposter.beginInterval(name, id: signposter.makeSignpostID()))
        #else
        Interval()
        #endif
    }

    /// An interval begun and not yet ended.
    public struct Interval {
        #if canImport(os)
        let signposter: OSSignposter
        let name: StaticString
        let state: OSSignpostIntervalState
        #endif

        public func end() {
            #if canImport(os)
            signposter.endInterval(name, state)
            #endif
        }
    }
}
