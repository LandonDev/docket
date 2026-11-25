import AppIntents
import TempCodeClient

/// Capture from outside the app (docs/agents/work-capture.md "The phone"): the Action button, Control Center,
/// the Lock Screen and Shortcuts run one of these. Each opens the app on the Capture sheet and does nothing
/// else: it files no note, sends nothing and starts no thread; only his Save in the sheet does. Compiled into
/// the app and the widget extension (the controls name them); the system runs them in the app.
nonisolated struct CaptureIntent: AppIntent {
    static let title: LocalizedStringResource = "Capture"
    static let description = IntentDescription("Opens Capture in TempCode, ready to type a note.")
    static let openAppWhenRun = true

    init() {}

    @MainActor
    func perform() async throws -> some IntentResult {
        CaptureDesk.shared.open(.typed)
        return .result()
    }
}

/// The same sheet with the keyboard down, so the hold control is under the thumb.
nonisolated struct VoiceNoteIntent: AppIntent {
    static let title: LocalizedStringResource = "Voice Note"
    static let description = IntentDescription("Opens Capture in TempCode, ready to hold and talk.")
    static let openAppWhenRun = true

    init() {}

    @MainActor
    func perform() async throws -> some IntentResult {
        CaptureDesk.shared.open(.voice)
        return .result()
    }
}
