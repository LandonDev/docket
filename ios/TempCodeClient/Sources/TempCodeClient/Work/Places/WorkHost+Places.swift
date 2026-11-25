import Foundation
import TempCodeContract

/// A job's small places (M5b): the thin calls over the socket. Each press is drawn only where KeyMay says the host
/// would take it; the host checks again at its door, and Reopen's person check asks approve on the key itself.
extension WorkHost {
    // MARK: - plays and routines

    /// The job's plays, proposals first, as its host keeps them.
    public func plays(_ workspaceId: String) async throws -> [PlayPhoneRow] {
        try await socket.request(Methods.WorkRoutinesPlays.self, .init(workspaceId: workspaceId)).plays
    }

    /// Starts the play as a new Work thread with what he typed; the answer names the thread.
    public func startPlay(_ play: PlayPhoneRow, inputs: PlayRun.Inputs) async throws -> String {
        let params = Methods.WorkRoutinesPlayStart.Params(id: play.id, inputs: .init(chips: [], date: inputs.date, text: inputs.text))
        return try await socket.request(Methods.WorkRoutinesPlayStart.self, params).sessionId
    }

    /// A routine's last runs, newest first.
    public func runs(_ routineId: String, limit: Int = RoutineRuns.shown) async throws -> [RoutineRunPhone] {
        try await socket.request(Methods.WorkRoutinesRuns.self, .init(id: routineId, limit: limit)).runs
    }

    /// Run Now: the run it started, or the one already running; nil when nothing fired.
    public func runNow(_ routineId: String) async throws -> RoutineRunPhone? {
        try await socket.request(Methods.WorkRoutinesRunNow.self, .init(id: routineId))
    }

    // MARK: - templates

    public func templates(_ workspaceId: String) async throws -> [TemplatePhone] {
        try await socket.request(Methods.WorkTemplatesList.self, .init(workspaceId: workspaceId)).templates
    }

    /// A new file from the template in the folder he is in, its fields filled; the phone's own day fills Date.
    public func makeFromTemplate(_ workspaceId: String, template: TemplatePhone, into: FolderRef, values: [String: String], today: Date = Date()) async throws -> Methods.WorkTemplatesMake.Output {
        let fields = TemplateFill.fields(values, of: template)
        return try await socket.request(Methods.WorkTemplatesMake.self, .init(workspaceId: workspaceId, template: template.id, into: into, fields: fields.isEmpty ? nil : fields, today: TemplateFill.day(today)))
    }

    // MARK: - dashboards

    /// Every figure read again, now.
    public func refreshDashboard(_ itemId: String) async throws -> DashboardPhoneView {
        try await socket.request(Methods.WorkDashboardsRefresh.self, .init(itemId: itemId))
    }

    // MARK: - forms

    /// The job's own forms (TempCode's), newest change first.
    public func ourForms(_ workspaceId: String) async throws -> [FormListPhoneRow] {
        try await socket.request(Methods.WorkFormsList.self, .init(workspaceId: workspaceId))
    }

    /// Close, or (with approve on the key) Reopen, one of our published forms. Reopen is outward (the form takes
    /// answers again): its frame is asked again where the socket releases it, under the key the owner's check passed
    /// (`PressLedger.guarded`); Close goes as it is.
    public func setFormOpen(_ itemId: String, open: Bool, key: String? = nil) async throws -> Methods.WorkFormsClose.Output {
        let call = { [socket] in try await socket.request(Methods.WorkFormsClose.self, .init(itemId: itemId, open: open)) }
        guard open else { return try await call() }
        return try await presses.guarded(host: environment.id, key: key, method: .formsReopen) { try await call() }
    }

    public func msform(_ workspaceId: String, formId: String) async throws -> MsFormPhoneRow {
        try await socket.request(Methods.WorkMsformsGet.self, .init(workspaceId: workspaceId, formId: formId))
    }

    public func msformAnswers(_ workspaceId: String, formId: String) async throws -> MsFormResponsesPhone {
        try await socket.request(Methods.WorkMsformsResponses.self, .init(workspaceId: workspaceId, formId: formId))
    }

    /// Close, or (with approve on the key) Reopen, a Microsoft form: Forms stops or starts taking answers.
    public func setMsformOpen(_ workspaceId: String, formId: String, open: Bool, key: String? = nil) async throws -> MsFormPhoneRow {
        let call = { [socket] in try await socket.request(Methods.WorkMsformsClose.self, .init(workspaceId: workspaceId, formId: formId, open: open)) }
        guard open else { return try await call() }
        return try await presses.guarded(host: environment.id, key: key, method: .msformsReopen) { try await call() }
    }

    /// He read its answers: what was new is seen, and the digest's tell of it is done.
    public func msformSeen(_ workspaceId: String, formId: String) async throws -> MsFormPhoneRow {
        try await socket.request(Methods.WorkMsformsSeen.self, .init(workspaceId: workspaceId, formId: formId))
    }

    // MARK: - Connections

    /// This host's connections; `fresh` is his own Check Again.
    public func health(fresh: Bool = false) async throws -> HealthReportPhone {
        try await socket.request(Methods.WorkHealth.self, .init(fresh: fresh ? true : nil))
    }

    public func lapses() async throws -> [LapsePhone] {
        try await socket.request(Methods.WorkLapses.self, .init())
    }

    // MARK: - the Windows VM

    public func winvmState() async throws -> WinvmStatePhone {
        let state = try await socket.request(Methods.WorkWinvmState.self, .init())
        winvm = state
        return state
    }

    /// Wake answers once Windows is up; the `work.winvm` push says each step meanwhile.
    public func wakeWinvm() async throws -> WinvmStatePhone {
        let state = try await socket.request(Methods.WorkWinvmWake.self, .init())
        winvm = state
        return state
    }

    public func sleepWinvm() async throws -> WinvmStatePhone {
        let state = try await socket.request(Methods.WorkWinvmSleep.self, .init())
        winvm = state
        return state
    }
}
