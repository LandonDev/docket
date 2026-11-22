import AppKit
import ApplicationServices

extension GiveFront {
    /// The writes on the Mac.
    @discardableResult
    public static func give(pid: Int32) -> Bool {
        give(pid: pid, write: live)
    }

    static func live(_ write: Write, _ pid: Int32) -> Bool {
        switch write {
        case .activate:
            return NSRunningApplication(processIdentifier: pid)?.activate(options: []) ?? false
        case .axFrontmost:
            return AX.set(AX.app(pid), "AXFrontmost", kCFBooleanTrue) == .success
        }
    }
}
