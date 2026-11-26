import AppIntents
import SwiftUI
import WidgetKit

/// Capture's two controls, for Control Center, the Lock Screen and the Action button: each runs its intent
/// (Shared/CaptureIntents.swift), which opens the app on the sheet and files nothing by itself.
struct CaptureControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "dev.landon.tempcode.capture") {
            ControlWidgetButton(action: CaptureIntent()) {
                Label("Capture", systemImage: "plus")
            }
        }
        .displayName("Capture")
        .description("Opens Capture in Docket.")
    }
}

struct VoiceNoteControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "dev.landon.tempcode.voice-note") {
            ControlWidgetButton(action: VoiceNoteIntent()) {
                Label("Voice Note", systemImage: "mic")
            }
        }
        .displayName("Voice Note")
        .description("Opens Capture in Docket, ready to talk.")
    }
}
