import LifeKit
import SwiftUI
import TempCodeClient
import TempCodeContract

/// Today, the Work tab's first place (docs/IOS-DESIGN.md "Today"): every job's day on one list, in the window's
/// order: Waiting on you, Meetings, Due, Waiting on others, Messages, Owed, then Also. The rows paint from the
/// disk on the first frame and the fresh page lands as a diff (`TodayStore`). A row opens its thing; its verbs
/// (the tick, Tomorrow, Nudge) are swipe actions and the context menu, drawn only for a key that may press them
/// and only on a fresh row. None sends to anyone: no owner's check, and Nudge only starts a thread that drafts.
struct TodayScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(ShellNavigator.self) private var navigator
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.shellPose) private var pose
    @Environment(\.scenePhase) private var scenePhase
    @State private var store = TodayFeed.store
    @State private var undos = CapsuleQueue<TodayUndo>()
    @State private var nudging: Set<String> = []

    var body: some View {
        let page = store.page
        let ids = Self.ids(page)
        let held = Self.held(page)
        WorkPlaceScreen(
            place: .today,
            ids: ids,
            loading: page == nil,
            empty: Self.empty(page),
            refresh: { await store.refresh() },
            pick: PlacePick(first: held.map(\.key), rowOf: { route in held.first { $0.route == route }?.key }) { key in
                if let route = held.first(where: { $0.key == key })?.route { navigator.open(route) }
            }
        ) {
            if case .day(let blocks, let offline, _)? = page {
                ForEach(blocks, id: \.id) { block in blockView(block) }
                if !offline.isEmpty {
                    Section {
                        ForEach(offline, id: \.self) { host in
                            TodayLine(words: "\(hostName(host)) is offline.")
                        }
                    }
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            Group {
                if let shown = undos.shown {
                    UndoCapsule(line: shown.item.line, identifier: "today-undo", undo: shown.item.action.map { action in { press(undoing: action, from: shown.id) } })
                }
            }
            .transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: Motion.travel * 3)))
        }
        .clashSheet()
        // Capture (Work/Capture), as on the Work list's bar.
        .toolbar {
            if CaptureButton.offered(model.registry.ordered) {
                ToolbarItem(placement: .primaryAction) { CaptureButton() }
            }
        }
        .animation(Motion.base, value: undos.shown?.id)
        // Each capsule's own time, started when it shows: the next answer waits its turn (`CapsuleQueue`).
        .task(id: undos.shown?.id) {
            guard let id = undos.shown?.id else { return }
            try? await Task.sleep(for: .seconds(FleetToastCenter.lingerSeconds))
            if !Task.isCancelled { undos.ended(id) }
        }
        .task {
            TodayFeed.start(model.registry)
            TodayFeed.onScreen(true)
            await minuteTicks()
        }
        .onDisappear { TodayFeed.onScreen(false) }
        // Back in the foreground (the day's first open among them): the clock is said at once, not at the next minute.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { store.tick(now: Date().timeIntervalSince1970 * 1000) }
        }
        #if DEBUG
        .task(id: store.cached) { await proofTick() }
        #endif
        .accessibilityIdentifier("today")
    }

    // MARK: - blocks

    @ViewBuilder
    private func blockView(_ block: TodayModel.Block) -> some View {
        switch block {
        case .section(let section):
            Section {
                sectionRows(section)
            } header: {
                SectionHeader(section.title)
                    .listRowInsets(EdgeInsets())
            }
        case .lifeos(let down):
            Section {
                // Only silence may answer another try: a sign-out, a refusal or Work off needs him elsewhere.
                TodayLine(words: Self.downWords(down, host: store.lifeHost.isEmpty ? (down == .locked ? lockedName : nil) : hostName(store.lifeHost)), late: Self.silent(down), retry: Self.silent(down) ? { await store.retry(.lifeos(what: "")) } : nil)
            }
        case .connecting:
            Section {
                TodayLine(words: Self.connectingWords(hostName(store.lifeHost)), waits: true)
            }
        case .lost(let failure) where failure.waits:
            // A job's session on another host waits on that host's LifeOS: the wait, the computer named, what it left out.
            Section {
                TodayLine(words: Self.connectingWords(hostName(failure.environmentId)), note: failure.said, waits: true)
            }
        case .lost(let failure):
            // The state first, its computer named, then what it left out; Retry only where the session was silent.
            Section {
                if let down = failure.down {
                    TodayLine(words: Self.downWords(down, host: hostName(failure.environmentId)), note: failure.said, late: Self.silent(down),
                              retry: Self.silent(down) ? failure.retry.map { retry in { await store.retry(retry) } } : nil)
                } else {
                    TodayLine(words: failure.said ?? failure.error, late: true, retry: failure.retry.map { retry in { await store.retry(retry) } })
                }
            }
        case .refused(let hosts):
            Section {
                ForEach(hosts, id: \.self) { host in
                    TodayLine(words: WorkHost.refusedLine(hostName(host)), late: true)
                }
            }
        }
    }

    @ViewBuilder
    private func sectionRows(_ section: TodayModel.ShownSection) -> some View {
        if section.earlier > 0 {
            TodayFold(words: "\(section.earlier) earlier") { unfold(TodayModel.foldKey(.earlier, section.id)) }
                .id(TodayModel.foldKey(.earlier, section.id))
        }
        // A host that did not answer is said first, and the section never says "nothing" beside it, nor while a
        // read it needs is lost or away (the desktop's).
        ForEach(section.failed, id: \.self) { failure in
            TodayLine(words: failure.said ?? Self.hostFailureWords(failure.error, name: hostName(failure.environmentId)), late: true,
                      retry: failure.retry.map { retry in { await store.retry(retry) } })
        }
        switch section.state {
        case .bones:
            TodayBones(tick: section.bones == .tick)
        case .empty:
            if section.failed.isEmpty, !section.away, !section.left { TodayLine(words: section.empty) }
        case .rows:
            ForEach(section.rows) { row in rowView(row) }
        }
        if section.more > 0 {
            TodayFold(words: "\(section.more) more") { unfold(TodayModel.foldKey(.more, section.id)) }
                .id(TodayModel.foldKey(.more, section.id))
        }
        if let note = section.note {
            TodayLine(words: note)
        }
    }

    private func rowView(_ row: TodayRow) -> some View {
        let fresh = store.isFresh(row)
        let acts = fresh ? row.acts.filter { drawn($0, row) } : []
        let tick = fresh ? TodaySources.tick(row).flatMap { drawn(TodayAct("Done", $0), row) ? $0 : nil } : nil
        return TodayRowView(
            row: row,
            job: jobName(row),
            selected: navigator.detailRoot != nil && navigator.detailRoot == row.route,
            tick: tick.map { press in { act(row, press) } },
            open: row.route.map { route in {
                // A thread's request opens its sheet, as the Outbox's Asked row does.
                if case .request(let environmentId, let requestId)? = row.open {
                    OutboxRequestCenter.shared.open(environmentId: environmentId, id: requestId)
                    return
                }
                // The review's row names its week: Review opens on it (`weekNamed`), not on whatever week showed last.
                if case .review(let week)? = row.open { ReviewFeed.store.show(named: week) }
                navigator.open(route)
            } }
        )
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            ForEach(acts, id: \.label) { verb in
                Button(verb.label, systemImage: Self.glyph(verb.press)) { act(row, verb.press) }
                    .tint(.accentColor)
            }
        }
        .contextMenu {
            // The tick, then the row's own verbs (at most two), the swipe's same set: three at most on a Due row.
            if let tick { Button("Done", systemImage: "checkmark.circle") { act(row, tick) } }
            ForEach(acts, id: \.label) { verb in
                Button(verb.label, systemImage: Self.glyph(verb.press)) { act(row, verb.press) }
            }
        }
    }

    // MARK: - presses

    /// A verb is drawn only where it can be pressed: the key may (KeyMay), and LifeKit has the write. A LifeOS verb is
    /// asked of the host whose session read the row, the one its write and its Undo go through (`TodaySources.sessionOf`).
    private func drawn(_ act: TodayAct, _ row: TodayRow) -> Bool {
        switch act.press {
        case .done(let sector, _):
            return client(sector: sector)?.work.may(.tasksDone) == true
        case .tomorrow(let sector, _):
            // Written through LifeKit on that host's LifeOS token: the key may ask it for one.
            return lifeosClient(row, sector: sector)?.work.may(.lifeosJwt) == true
        case .nudge(let place, _):
            return model.registry.client(place.environmentId)?.work.may(.mailNudge) == true
        // The read mark goes through LifeKit's own write on the session that read the row (Messages' `chats:markRead`).
        case .markRead:
            if TodaySources.sessionOf(row) != nil { return lifeosClient(row, sector: nil)?.work.may(.lifeosJwt) == true }
            return model.registry.ordered.contains { $0.work.isOn && $0.work.may(.lifeosJwt) }
        // Resolve opens the clash, which reads; its own presses ask their own keys.
        case .resolve(let environmentId, _):
            return model.registry.client(environmentId) != nil
        // The project's page reads through the job's own LifeOS session, as its Projects view does.
        case .openProject(let sector, _):
            return client(sector: sector)?.work.may(.lifeosJwt) == true
        // Through LifeKit on the reading host's LifeOS token, as Mail's Waiting On dismisses.
        case .dismiss(let sector, _, _):
            return lifeosClient(row, sector: sector)?.work.may(.lifeosJwt) == true
        // Prepare is the meeting's page's own verb.
        case .prepare:
            return false
        }
    }

    private func act(_ row: TodayRow, _ press: TodayPress) {
        switch press {
        case .done(let sector, let taskId):
            leave(row)
            Task { await done(row, sector: sector, taskId: taskId) }
        case .tomorrow(let sector, let taskId):
            leave(row)
            Task { await tomorrow(row, sector: sector, taskId: taskId) }
        case .nudge(let place, let threadId):
            // One nudge a row at a time: a second press while the first starts its thread starts nothing.
            guard nudging.insert(row.key).inserted else { return }
            Task {
                await nudge(place, threadId: threadId)
                nudging.remove(row.key)
            }
        case .markRead(let chatId, let at):
            leave(row)
            Task { await markRead(row, chatId: chatId, at: at) }
        case .resolve(let environmentId, let clashId):
            ClashOpen.open(environmentId: environmentId, clashId: clashId, pose: pose, navigator: navigator)
        case .openProject(let sector, let projectId):
            // The job is looked up when he presses: a row kept from before a reopen opens in the job that holds it now.
            if let job = jobOf(sector) { TodayProjectOpen.open(job, projectId: projectId, navigator: navigator) }
        case .dismiss(_, let threadId, let since):
            leave(row)
            Task { await dismiss(row, threadId: threadId, since: since) }
        case .prepare:
            break
        }
    }

    /// The row leaves now, on the list's own motion.
    private func leave(_ row: TodayRow) {
        withAnimation(reduceMotion ? Motion.crossFade : Motion.rowLeave) { store.hide(row.key) }
    }

    private func comeBack(_ row: TodayRow) {
        withAnimation(Motion.rowAppear) { store.unhide(row.key) }
    }

    /// The tick: `work.tasks.done` on the job's host; Undo reopens it in LifeOS (`tasks:reopen`).
    private func done(_ row: TodayRow, sector: String, taskId: String) async {
        guard let client = client(sector: sector), let workspaceId = row.workspace?.workspaceId ?? jobOf(sector)?.workspaceId else { return comeBack(row) }
        do {
            if !TestHooks.lifeFixtures { _ = try await client.work.completeTask(taskId, workspaceId: workspaceId) }
            say(TodayUndo(line: "Done: \(row.title)", action: .reopen(row: row, sector: sector, taskId: taskId)))
        } catch {
            comeBack(row)
            say(TodayUndo(line: "Couldn’t mark it done", action: nil))
        }
    }

    /// Tomorrow: `tasks:snooze` to the next morning in his zone; Undo wakes it (`tasks:unsnooze`).
    private func tomorrow(_ row: TodayRow, sector: String, taskId: String) async {
        guard let life = TodayLife.store(for: row, model.registry.ordered) else { return stopped(row) }
        let until = Snooze.morning(after: .now, in: life.timeZone)
        do {
            _ = try await life.mutate("tasks:snooze", ["id": Self.json(taskId), "until": String(until.timeIntervalSince1970 * 1000)])
            say(TodayUndo(line: "Moved to tomorrow", action: .unsnooze(row: row, sector: sector, taskId: taskId)))
        } catch {
            comeBack(row)
            say(TodayUndo(line: "Couldn’t move it", action: nil))
        }
    }

    /// Dismiss: LifeOS's `mailWaits:dismiss` on the session that read the wait, fenced by the send the row showed
    /// (`since`), so a stale row changes no newer wait; Undo puts it back as LifeOS answered it was (`mailWaits:putBack`).
    private func dismiss(_ row: TodayRow, threadId: String, since: Double) async {
        // The proof's fixture day has no LifeOS behind its wait: it leaves, with nothing to put back.
        if TestHooks.lifeFixtures {
            say(TodayUndo(line: "Dismissed", action: nil))
            return
        }
        guard let life = TodayLife.store(for: row, model.registry.ordered) else { return stopped(row) }
        do {
            let before = try await life.mutate("mailWaits:dismiss", ["threadId": Self.json(threadId), "since": String(since)])
            let back: TodayUndo.Action? = if let state = before.objectValue?["state"]?.stringValue, let dueAt = before.objectValue?["dueAt"]?.numberValue {
                .putBack(row: row, threadId: threadId, since: since, state: state, dueAt: dueAt)
            } else {
                nil
            }
            say(TodayUndo(line: "Dismissed", action: back))
        } catch {
            comeBack(row)
            say(TodayUndo(line: "Couldn’t dismiss it", action: nil))
        }
    }

    /// Mark read: LifeOS's own mark (`chats:markRead`) through LifeKit on the session that reads the row's sector.
    private func markRead(_ row: TodayRow, chatId: String, at: Double) async {
        guard let life = TodayLife.store(for: row, model.registry.ordered) else { return stopped(row) }
        do {
            if !TestHooks.lifeFixtures { try await MessagesReads.markRead(life, chatId: chatId) }
            // How far he read it: a host behind with an older copy brings no row back.
            store.markedRead(chatId: chatId, at: at)
        } catch {
            comeBack(row)
            say(TodayUndo(line: "Couldn’t mark it read", action: nil))
        }
    }

    /// Nudge: the host starts a Work thread that drafts the follow-up; it opens, and nothing goes until he sends.
    private func nudge(_ place: TodayPlace, threadId: String) async {
        guard let client = model.registry.client(place.environmentId) else { return }
        do {
            let sessionId = try await client.work.nudge(threadId, workspaceId: place.workspaceId)
            navigator.open(.thread(environmentId: place.environmentId, sessionId: sessionId, seq: nil))
        } catch {
            say(TodayUndo(line: "Couldn’t start the nudge", action: nil))
        }
    }

    /// Undo: the task shows again only once LifeOS took it back; a refusal keeps it off and says so.
    private func press(undoing action: TodayUndo.Action, from id: UUID) {
        undos.ended(id)
        Task {
            // The same session the act went through: the one that read the row (`TodayLife.store(for:)`).
            let (row, write, args): (TodayRow, String, [String: String]) = switch action {
            case .reopen(let row, _, let taskId): (row, "tasks:reopen", ["id": Self.json(taskId)])
            case .unsnooze(let row, _, let taskId): (row, "tasks:unsnooze", ["id": Self.json(taskId)])
            case .putBack(let row, let threadId, let since, let state, let dueAt):
                (row, "mailWaits:putBack", ["threadId": Self.json(threadId), "since": String(since), "state": Self.json(state), "dueAt": String(dueAt)])
            }
            if TestHooks.lifeFixtures { return comeBack(row) }
            do {
                guard let life = TodayLife.store(for: row, model.registry.ordered) else {
                    // The session the act went through has gone: Undo tries no other, and says why.
                    let on = TodaySources.sessionOf(row).map { " on \(hostName($0.environmentId))" } ?? ""
                    say(TodayUndo(line: "Couldn’t undo: LifeOS\(on) is not connected", action: nil))
                    return
                }
                _ = try await life.mutate(write, args)
                comeBack(row)
            } catch {
                say(TodayUndo(line: "Couldn’t undo", action: nil))
            }
        }
    }

    private func unfold(_ key: String) {
        withAnimation(reduceMotion ? Motion.crossFade : Motion.expand) { store.unfold(key) }
    }

    /// The minute's words ("in 25 min", "Now") are said at once when Today comes on screen, then move once a
    /// minute, at the minute, while it is.
    private func minuteTicks() async {
        TickLedger.begin("today.minute"); defer { TickLedger.end("today.minute") }
        store.tick(now: Date().timeIntervalSince1970 * 1000)
        while !Task.isCancelled {
            let now = Date()
            let next = Calendar.current.nextDate(after: now, matching: DateComponents(second: 0), matchingPolicy: .nextTime) ?? now.addingTimeInterval(60)
            try? await Task.sleep(for: .seconds(next.timeIntervalSince(now)))
            guard !Task.isCancelled else { return }
            store.tick(now: Date().timeIntervalSince1970 * 1000)
        }
    }

    #if DEBUG
    /// `TC_TEST_ACTION=today-tick`: the first Due row's tick, pressed as soon as the fresh page has one (the m1
    /// proof), waiting for it rather than giving up on a page that painted its kept rows first (iw13 never ticked);
    /// `today.tick` notes the row it ticked, or that none came.
    private func proofTick() async {
        guard TestHooks.action == "today-tick" else { return }
        for _ in 0..<100 {
            if let row = TodayStore.rows(store.page).first(where: { TodaySources.tick($0) != nil && store.isFresh($0) }),
               let press = TodaySources.tick(row) {
                guard TestHooks.once("today-tick") else { return }
                act(row, press)
                LayoutProbe.note("today.tick", row.key)
                return
            }
            try? await Task.sleep(for: .milliseconds(200))
        }
        LayoutProbe.note("today.tick", "none")
    }
    #endif

    // MARK: - words and lookups

    private var jobs: [TodayWorkspace] { store.jobs }

    private func jobOf(_ sector: String) -> TodayWorkspace? { TodayJobs(jobs).of(sector) }

    private func client(sector: String) -> EnvironmentClient? {
        jobOf(sector).flatMap { model.registry.client($0.environmentId) }
    }

    /// The job a row is of, said before its title to VoiceOver.
    private func jobName(_ row: TodayRow) -> String? {
        row.job ?? row.sector.flatMap { jobOf($0)?.name }
    }

    /// The host whose LifeOS session read the row; a row with no supplier goes by its job's host.
    private func lifeosClient(_ row: TodayRow, sector: String?) -> EnvironmentClient? {
        if let session = TodaySources.sessionOf(row) { return model.registry.client(session.environmentId) }
        return sector.flatMap { client(sector: $0) }
    }

    /// The session that read the row has gone since (signed out, its job's session dropped): nothing was written, and
    /// the line says why instead of trying another session.
    private func stopped(_ row: TodayRow) {
        comeBack(row)
        // The host the session belongs to; a row with no supplier names none, since LifeOS never runs on the phone.
        let on = TodaySources.sessionOf(row).map { " on \(hostName($0.environmentId))" } ?? ""
        say(TodayUndo(line: "LifeOS\(on) is not connected, so nothing changed", action: nil))
    }

    /// An answer in the capsule, after the one it shows (`CapsuleQueue`).
    private func say(_ undo: TodayUndo) {
        undos.add(undo, undoable: undo.action != nil)
    }

    /// The locked Mac reached through the box that Today cannot read through (`KeyMay.lifeosLocked`).
    private var lockedName: String? {
        model.registry.ordered.first { $0.work.isOn && $0.work.linked && $0.work.key.lifeosLocked }?.environment.name
    }

    private func hostName(_ environmentId: String) -> String {
        model.registry.client(environmentId)?.environment.name ?? "A computer"
    }

    /// Every stop on the page in order, the sections' own lines between them, so the list is never "empty".
    static func ids(_ page: TodayModel.Page?) -> [String] {
        guard case .day(let blocks, let offline, let keys)? = page else { return [] }
        return keys + blocks.map(\.id) + offline.map { "offline:\($0)" }
    }

    /// Waiting on you's held items, in draw order: what the open Duo picks. A request opens its sheet, never the detail.
    static func held(_ page: TodayModel.Page?) -> [TodayRow] {
        TodayStore.rows(page).filter { row in
            // A row kept from an asleep host's disk is not picked: it would fail to read in the detail.
            guard row.section == TodaySources.held.id, row.route != nil, TodayFeed.store.isFresh(row) || TodayFeed.store.cached else { return false }
            if case .request? = row.open { return false }
            return true
        }
    }

    static func empty(_ page: TodayModel.Page?) -> PlaceEmpty {
        switch page {
        case .noJobs?: PlaceEmpty(title: "No Jobs Yet", line: "Link a Work workspace to LifeOS.")
        case .clear(let line)?: PlaceEmpty(title: "All Clear", line: line ?? "Nothing needs you today.")
        default: PlaceEmpty(title: "Today")
        }
    }

    /// A down session in the desktop's words (`lifeosDownWords`), its computer named.
    /// With no computer known, the desktop's host-less forms.
    static func downWords(_ down: TodayDown, host: String?) -> String {
        guard let host else {
            return switch down {
            case .signedOut: "Not signed in to LifeOS"
            case .unreachable, .unanswered: "LifeOS did not answer"
            case .refused: "LifeOS refused the sign-in"
            case .pairing: "The LifeOS sign-in waits for your approval"
            case .off: "Work is off"
            case .withheld: "This iPhone’s key can’t read LifeOS"
            case .locked: "Your Mac is locked"
            }
        }
        return switch down {
        case .signedOut: "Not signed in to LifeOS on \(host)"
        case .unreachable: "LifeOS did not answer \(host)"
        case .unanswered: "\(host) did not answer"
        case .refused: "LifeOS refused \(host)’s sign-in"
        case .pairing: "The LifeOS sign-in on \(host) waits for your approval"
        case .off: "Work is off on \(host)"
        case .withheld: "This iPhone’s key can’t read LifeOS through \(host)"
        case .locked: "\(host) is locked"
        }
    }

    /// Silence, LifeOS's or the host's: the one state another try can mend.
    static func silent(_ down: TodayDown) -> Bool { down == .unreachable || down == .unanswered }

    /// A host's failed read in one true line (the desktop's `hostFailureWords`): "did not answer" only for a wait
    /// that ran out; else Work's own words for the error, and where it has none, that the host could not read this.
    static func hostFailureWords(_ error: String, name: String) -> String {
        if error == TodayStore.timedOut { return "\(name) did not answer" }
        let words = WorkErrorWords.say(error, host: name)
        return words.isEmpty ? "\(name) could not read this" : words
    }

    /// A session on its way, its computer named: no press goes with it.
    static func connectingWords(_ host: String) -> String { "LifeOS is still connecting on \(host)" }

    static func glyph(_ press: TodayPress) -> String {
        switch press {
        case .done: "checkmark.circle"
        case .tomorrow: "sunrise"
        case .nudge: "arrowshape.turn.up.right"
        case .dismiss: "xmark"
        case .markRead: "envelope.open"
        case .prepare: "sparkles"
        case .resolve: "calendar.badge.exclamationmark"
        case .openProject: "folder"
        }
    }

    /// A string as the JSON a LifeOS mutation takes.
    static func json(_ text: String) -> String {
        (try? String(data: JSONEncoder().encode(text), encoding: .utf8)) ?? "\"\(text)\""
    }
}

extension TodayModel.Block {
    /// A block's identity in the list.
    var id: String {
        switch self {
        case .section(let s): "section:\(s.id)"
        case .lifeos, .connecting: "lifeos"
        case .refused: "refused"
        case .lost(let f): "lost:\(f.environmentId):\(f.down?.rawValue ?? (f.waits ? "connecting" : ""))"
        }
    }
}

/// What the undo capsule says, and what Undo takes back.
struct TodayUndo: Equatable {
    enum Action: Equatable {
        case reopen(row: TodayRow, sector: String, taskId: String)
        case unsnooze(row: TodayRow, sector: String, taskId: String)
        case putBack(row: TodayRow, threadId: String, since: Double, state: String, dueAt: Double)
    }

    let id = UUID()
    var line: String
    var action: Action?
}

// MARK: - the row

/// Today's row on the house grid: the lead in the mark slot (a task's tick, else the job's dot), the title and its
/// line, and the trailing fact with its live line under it. Late is said in the warning ink; a row that is over
/// is muted. VoiceOver reads the job first.
struct TodayRowView: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let row: TodayRow
    let job: String?
    let selected: Bool
    /// The tick's press, for a fresh task row a key may complete; nil draws the tick as a plain mark.
    let tick: (() -> Void)?
    /// Opens the row's thing; nil: the row is not a button.
    let open: (() -> Void)?

    var body: some View {
        Group {
            if let open {
                Button(action: open) { content }
                    .buttonStyle(.pressable)
            } else {
                content
            }
        }
        .listRowInsets(Layout.rowInsets)
        .placeSelected(selected)
        .rowInitProbe(work: row.key)
        .launchTodayRow(row)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
        .accessibilityActions {
            if let tick { Button("Done", action: tick) }
        }
        .accessibilityIdentifier("today-row")
    }

    /// At accessibility sizes the words wrap and the time goes under them, so two meetings stay told apart by name
    /// and place; the time keeps its own line rather than squeezing the title to a few letters.
    private var content: some View {
        let large = typeSize.isAccessibilitySize
        return HStack(alignment: large ? .firstTextBaseline : .center, spacing: Layout.rowGap) {
            lead
                .frame(width: Layout.glyphWidth + Layout.markWidth)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title)
                    .textStep(.title, tint: row.past ? Color(.secondaryLabel) : nil)
                    .lineLimit(large ? 3 : 1)
                if let detail = row.detail {
                    Text(detail)
                        .textStep(.meta, tint: row.detailLate ? Tint.destructiveText : nil)
                        // A fault's reason (a held send that needs him) wraps whole at accessibility sizes, as Today's own
                        // failure line does: its last words are often what to do (council 14, Sol 6).
                        .lineLimit(large ? (row.detailLate ? nil : 3) : 1)
                }
                if large { times(alignment: .leading) }
            }
            if !large {
                Spacer(minLength: Layout.rowGap)
                times(alignment: .trailing)
            }
        }
        .padding(.vertical, Layout.rowVertical)
        .frame(minHeight: Layout.rowHeight + 8)
        .contentShape(Rectangle())
    }

    /// The trailing fact and its live line: late in the warning ink, the live line in the label's ink.
    @ViewBuilder
    private func times(alignment: HorizontalAlignment) -> some View {
        if row.when != nil || row.whenLine != nil {
            VStack(alignment: alignment, spacing: 2) {
                if let when = row.when {
                    Text(when)
                        .textStep(.stamp, tint: row.late ? Tint.warningText : Color(.label))
                }
                if let line = row.whenLine {
                    Text(line)
                        .textStep(.stamp, weight: .medium, tint: Color(.label))
                }
            }
            .lineLimit(1)
        }
    }

    @ViewBuilder
    private var lead: some View {
        if case .tick? = row.lead {
            if let tick {
                Button(action: tick) {
                    Image(systemName: "circle")
                        .font(TextStep.title.font.weight(.light))
                        .imageScale(.large)
                        .foregroundStyle(.tertiary)
                        .frame(minWidth: Layout.rowHeight, minHeight: Layout.rowHeight)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.pressable)
                .accessibilityHidden(true)
            } else {
                Image(systemName: "circle")
                    .font(TextStep.title.font.weight(.light))
                    .imageScale(.large)
                    .foregroundStyle(.quaternary)
            }
        } else {
            SectorDot(sector: row.sector)
                .opacity(row.past ? 0.5 : 1)
        }
    }

    /// The job first, then what the row says, and late or over, which the ink alone tells the eye.
    private var label: String {
        [job, row.title, row.detail, row.when, row.late ? "late" : nil, row.past ? "over" : nil, row.whenLine].compactMap { $0 }.joined(separator: ", ")
    }
}

/// A muted line in a section's place: its empty words, a note, a failure with Retry, a host that is offline.
struct TodayLine: View {
    let words: String
    /// A second line under the words (what a wait leaves out).
    var note: String?
    var late = false
    /// A known wait: a spinner, and no press.
    var waits = false
    var retry: (() async -> Void)?
    @State private var reading = false
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        // At accessibility sizes the press goes under the words, so neither is cut (the capsule's rule).
        let large = typeSize.isAccessibilitySize
        let layout = large ? AnyLayout(VStackLayout(alignment: .leading, spacing: Layout.rowGap)) : AnyLayout(HStackLayout(spacing: Layout.rowGap))
        layout {
            VStack(alignment: .leading, spacing: 2) {
                Text(words)
                    .textStep(.meta, tint: late ? Tint.destructiveText : nil)
                if let note { Text(note).textStep(.meta) }
            }
            .lineLimit(large ? nil : 3)
            if !large { Spacer(minLength: Layout.rowGap) }
            if waits {
                ProgressView()
                    .accessibilityHidden(true)
            } else if let retry {
                if reading {
                    ProgressView()
                } else {
                    PillButton("Try Again") {
                        Task {
                            reading = true
                            await retry()
                            reading = false
                        }
                    }
                }
            }
        }
        .padding(.leading, Layout.glyphWidth + Layout.markWidth + Layout.rowGap)
        .padding(.vertical, Layout.rowVertical)
        .frame(minHeight: Layout.rowHeight)
        .listRowInsets(Layout.rowInsets)
        .accessibilityElement(children: .contain)
    }
}

/// "3 more", "2 earlier": a plain row on the titles' edge that opens the fold.
struct TodayFold: View {
    let words: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(words)
                .textStep(.meta, weight: .medium, tint: Color(.secondaryLabel))
                .padding(.leading, Layout.glyphWidth + Layout.markWidth + Layout.rowGap)
                .frame(maxWidth: .infinity, minHeight: Layout.rowHeight, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .listRowInsets(Layout.rowInsets)
        .accessibilityIdentifier("today-fold")
    }
}

/// A section that has not answered yet: three rows in its rows' shape, redacted.
struct TodayBones: View {
    let tick: Bool

    var body: some View {
        ForEach(0..<3, id: \.self) { _ in
            HStack(spacing: Layout.rowGap) {
                Image(systemName: tick ? "circle" : "circle.fill")
                    .font(.footnote)
                    .frame(width: Layout.glyphWidth + Layout.markWidth)
                VStack(alignment: .leading, spacing: 2) {
                    Text("A row of the day").textStep(.title)
                    Text("Its line under it").textStep(.meta)
                }
                Spacer(minLength: Layout.rowGap)
                Text("9:41 AM").textStep(.stamp)
            }
            .padding(.vertical, Layout.rowVertical)
            .frame(minHeight: Layout.rowHeight + 8)
            .listRowInsets(Layout.rowInsets)
        }
        .redacted(reason: .placeholder)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
