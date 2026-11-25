import SwiftUI
import TempCodeClient
import UIKit

/// Settings → a long press on the version line. Two checks run on the
/// thread the person last opened, with the drivers the simulator's `perf`
/// proof uses (Sources/Perf): the scroll check moves the transcript at
/// 3,000 pt/s up and back twice, the typing check types 120 characters into
/// its composer and takes them out again. Each pushes that thread, runs, and
/// comes back with what the phone measured. Work Checks holds this launch's
/// marks, the list check (`WorkListCheck`: 1,000 sample files in the Files
/// place's frame, pushed, scrolled and counted, then popped), the repeating
/// tasks alive (`TickLedger`) and the Work cache's size and protection; under
/// them is iOS's own scroll hitch measure from MetricKit, when it has sent
/// one. Settings' grammar:
/// an inset grouped list, no glyphs, one sentence of footer.
struct DiagnosticsScreen: View {
    @Environment(AppModel.self) private var model
    @State private var scroll: PerfReport?
    @State private var typing: PerfReport?
    /// The thread pushed for the check that is running.
    @State private var running: ThreadKey?
    @State private var failure: String?
    @State private var shared: URL?
    /// The list check's fixture, pushed while it runs.
    @State private var listing = false
    @State private var listCheck = WorkListCheck()
    private let session = PerfSession.shared

    var body: some View {
        let target = session.lastThread
        let title = target.flatMap { key in model.registry.client(key.environmentId)?.session(key.sessionId)?.title }
        let hitch = HitchMetrics.stored
        List {
            Section {
                LabeledContent("Thread") {
                    Text(title ?? "None")
                        .lineLimit(1)
                }
                if let failure {
                    InlineFieldError(message: failure)
                        .rowAppearTransition()
                }
            } footer: {
                Text(title == nil ? "Open a thread, then come back here." : "Both checks run on the thread you last opened.")
            }

            Section {
                Button("Run Scroll Check") { start(.scrollCheck) }
                    .disabled(title == nil)
                if let scroll {
                    LabeledContent("Late Frames", value: DiagnosticsText.late(scroll.late, of: scroll.frames.count))
                    LabeledContent("Longest Frame", value: DiagnosticsText.ms(scroll.frames.worst))
                    LabeledContent("Hitch Time", value: DiagnosticsText.hitch(scroll.hitchMsPerS))
                    LabeledContent("Main Thread", value: DiagnosticsText.ms(scroll.cpuMs.p95))
                }
            } header: {
                Text("Scrolling")
            } footer: {
                Text("Smooth is under 1% late, no frame over 34 ms, under 5 ms of hitches per second and 4 ms of main thread in most frames.")
            }

            Section {
                Button("Run Typing Check") { start(.typingCheck) }
                    .disabled(title == nil)
                if let typing {
                    LabeledContent("Key to Screen", value: DiagnosticsText.ms(typing.keyWallMs.p95))
                    LabeledContent("Slowest Key", value: DiagnosticsText.ms(typing.keyWallMs.worst))
                }
            } header: {
                Text("Typing")
            } footer: {
                Text("Smooth is 17 ms for most keys and 34 ms for the slowest, not counting the keyboard's own delay.")
            }

            Section {
                LabeledContent("First Frame", value: DiagnosticsText.mark(LaunchClock.marks.firstFrameMs))
                LabeledContent("Cached Row", value: DiagnosticsText.mark(LaunchClock.marks.cachedRowMs))
                Button("Run List Check") { listing = true }
                    .disabled(listCheck.running)
                if let list = listCheck.report {
                    if let note = list.note {
                        InlineFieldError(message: "The check did not run: \(note).")
                    } else {
                        LabeledContent("Rows Built", value: DiagnosticsText.rows(list))
                        if let misses = DiagnosticsText.listMisses(list) { LabeledContent("Rebuilt", value: misses) }
                        LabeledContent("Late Frames", value: DiagnosticsText.late(list.late, of: list.frames))
                        LabeledContent("Hitch Time", value: DiagnosticsText.hitch(list.hitchMsPerS))
                    }
                }
                LabeledContent("Repeating Tasks", value: DiagnosticsText.clocks(TickLedger.names))
                LabeledContent("Work Cache", value: DiagnosticsText.size(WorkCacheFile.bytes()))
                LabeledContent("Protection", value: DiagnosticsText.protection(WorkCacheFile.protection()))
            } header: {
                Text("Work Checks")
            } footer: {
                Text("Times from this launch's start. The list check scrolls 1,000 sample files.")
            }

            Section {
                LabeledContent("Display", value: DiagnosticsText.display(maxFramesPerSecond: screenRate, medianMs: (scroll ?? typing)?.frames.p50))
                LabeledContent("Scroll Hitches", value: hitch.map { DiagnosticsText.hitch($0.msPerSecond) } ?? "No Report Yet")
            } header: {
                Text("From iOS")
            } footer: {
                Text(iosFooter(hitch))
            }

            if let shared {
                Section {
                    ShareLink("Share Report", item: shared)
                }
            }
        }
        .listStyle(.insetGrouped)
        .monospacedDigit()
        .navigationTitle("Diagnostics")
        .navigationBarTitleDisplayMode(.inline)
        .animation(Motion.rowAppear, value: failure)
        .navigationDestination(item: $running) { key in
            if let client = model.registry.client(key.environmentId) {
                ThreadScreen(client: client, sessionId: key.sessionId, performsLaunchAction: false)
            }
        }
        .navigationDestination(isPresented: $listing) { WorkListFixture(check: listCheck) }
        .onChange(of: listCheck.report) { _, report in
            guard report != nil else { return }
            listing = false
            shared = DiagnosticsFile.write(scroll: scroll, typing: typing, list: listCheck.report, hitch: HitchMetrics.stored)
        }
        .onChange(of: session.report) { _, report in
            if let report { land(report) }
        }
        .task(id: running) { await giveUp() }
    }

    private var screenRate: Int {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        return scene?.screen.maximumFramesPerSecond ?? 60
    }

    private func iosFooter(_ hitch: HitchMetrics.Stored?) -> String {
        if ProcessInfo.processInfo.isLowPowerModeEnabled { return "Low Power Mode holds the screen to 60 Hz." }
        guard let hitch else { return "iOS measures every scroll in the app and reports at most once a day." }
        return "iOS measured every scroll in the app up to \(hitch.end.formatted(date: .abbreviated, time: .omitted))."
    }

    private func start(_ run: PerfRun) {
        guard let target = session.lastThread else { return }
        failure = nil
        session.ask(run, sessionId: target.sessionId)
        running = target
    }

    private func land(_ report: PerfReport) {
        running = nil
        if let note = report.note {
            failure = "The check did not run: \(note)."
            return
        }
        if report.run == PerfRun.scrollCheck.rawValue { scroll = report } else { typing = report }
        shared = DiagnosticsFile.write(scroll: scroll, typing: typing, list: listCheck.report, hitch: HitchMetrics.stored)
    }

    /// A thread that never opened its transcript (it is gone from its host) takes no check.
    private func giveUp() async {
        guard running != nil else { return }
        try? await Task.sleep(for: .seconds(20))
        guard !Task.isCancelled, session.running == nil, session.request != nil else { return }
        session.cancel()
        running = nil
        failure = "The check did not run: the thread did not open."
    }
}

/// The report Share sends: the checks as they were measured, and the phone they ran on.
enum DiagnosticsFile {
    private struct Report: Codable {
        var app: String
        var device: String
        var system: String
        var scroll: PerfReport?
        var typing: PerfReport?
        var list: WorkListReport?
        var scrollHitch: HitchMetrics.Stored?
    }

    static func write(scroll: PerfReport?, typing: PerfReport?, list: WorkListReport?, hitch: HitchMetrics.Stored?) -> URL? {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "0"
        let build = info?["CFBundleVersion"] as? String ?? "0"
        let report = Report(app: "\(version) (\(build))", device: UIDevice.current.model, system: UIDevice.current.systemVersion, scroll: scroll, typing: typing, list: list, scrollHitch: hitch)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .prettyPrinted]
        encoder.dateEncodingStrategy = .iso8601
        let url = FileManager.default.temporaryDirectory.appending(path: "TempCode-diagnostics.json")
        guard let data = try? encoder.encode(report), (try? data.write(to: url, options: .atomic)) != nil else { return nil }
        return url
    }
}

/// The Work cache's file as it sits on disk: its bytes with the SQLite sidecars, and the database's protection class.
enum WorkCacheFile {
    static func bytes() -> Int64? {
        let path = WorkCacheStore.defaultPath().path(percentEncoded: false)
        let sizes = ["", "-wal", "-shm"].compactMap { (try? FileManager.default.attributesOfItem(atPath: path + $0))?[.size] as? Int64 }
        return sizes.isEmpty ? nil : sizes.reduce(0, +)
    }

    static func protection() -> String? {
        let path = WorkCacheStore.defaultPath().path(percentEncoded: false)
        return ((try? FileManager.default.attributesOfItem(atPath: path))?[.protectionKey] as? FileProtectionType)?.rawValue
    }
}
