import AppKit
import ApplicationServices

extension GiveFront {
    /// The writes on the Mac, the front read as the restores read it (`AX.focusedAppPid`).
    @discardableResult
    public static func give(pid: Int32) -> Bool {
        give(pid: pid, write: live, isFront: { AX.isFrontApp(pid) }, sleep: { usleep(useconds_t($0) * 1_000) })
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
