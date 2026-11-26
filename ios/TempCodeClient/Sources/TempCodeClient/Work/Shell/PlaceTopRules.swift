import Foundation

/// Where a Work place's list comes back to when it is built again (a fold, a pose change, a return): the row it
/// showed at its top (`PlaceTop` in Work/Shell/WorkPlaceScreen.swift).
public enum PlaceTopRules {
    /// The kept row only while the list draws it as a row; else none, and the list stays at its top. A section's
    /// own id, a row folded under "3 more" or one in a section not built yet is no place to scroll to: the list
    /// cannot show it, and asking it to ends the app.
    public static func target(kept: String?, rows: [String]) -> String? {
        guard let kept, rows.contains(kept) else { return nil }
        return kept
    }
}
