import AppIntents

/// The App Shortcuts the system offers without setup: the Action button's list, Spotlight and Siri.
nonisolated struct TempCodeShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: CaptureIntent(), phrases: ["Capture in \(.applicationName)"], shortTitle: "Capture", systemImageName: "plus")
        AppShortcut(intent: VoiceNoteIntent(), phrases: ["Voice note in \(.applicationName)", "Take a voice note in \(.applicationName)"], shortTitle: "Voice Note", systemImageName: "mic")
    }
}
