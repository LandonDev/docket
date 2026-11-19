import Foundation

/// What a pressed Send in LifeOS's composer may go with (milestone 47). The
/// composer hands the host its subject and every recipient (to, cc and bcc
/// in one list); the draft as LifeOS holds it at the press must still say
/// those, or the phone refuses, since the host's own check compares the
/// draft with what the phone read and cannot catch a change in between. A
/// change to the words alone is not seen here: work-kit's `LifeHeldSend`
/// does not carry them yet.
public enum HeldSendCheck {
    public static func matches(pressedSubject: String, pressedTo: [String], subject: String?, to: [String], cc: [String], bcc: [String]) -> Bool {
        let held = Set((to + cc + bcc).map(normal))
        return (subject ?? "").trimmingCharacters(in: .whitespacesAndNewlines) == pressedSubject.trimmingCharacters(in: .whitespacesAndNewlines)
            && held == Set(pressedTo.map(normal))
    }

    private static func normal(_ address: String) -> String {
        address.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}
