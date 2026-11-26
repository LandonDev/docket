import SwiftUI
import TempCodeClient
import TempCodeContract

/// The app's one review store (the client package's `ReviewStore`): the week shown survives leaving the place, and
/// Today's row and a tell set the week they name before Review opens.
@MainActor
enum ReviewFeed {
    private static weak var registry: ClientRegistry?
    static let store = ReviewStore(
        link: { id in ReviewFeed.registry?.client(id)?.work },
        words: { error in (ActionError.wrap(error).message, false) }
    )

    /// Hands the store its hosts' socket; once a run.
    static func start(_ registry: ClientRegistry) {
        if self.registry == nil { self.registry = registry }
    }

    /// The hosts as the store reads them: Work on, linked, the key's leave to read the week, each host's jobs.
    static func inputs(_ registry: ClientRegistry) -> [ReviewHostInput] {
        registry.ordered.map { client in
            ReviewHostInput(
                id: client.environment.id,
                name: client.environment.name,
                platform: client.status.lastHello?.build?.platform,
                workOn: client.work.isOn,
                linked: client.work.linked,
                may: client.work.may(.reviewWeek),
                jobs: client.workspaces.filter { $0.kind == .work }.map { .init(workspaceId: $0.id, sector: $0.sector, name: $0.name) }
            )
        }
    }
}

/// Review, a place of the Work tab (docs/IOS-DESIGN.md "Work on the phone", ### Review): the week across every job.
/// Hours by job (the calendar measured, the desk "about"), what shipped, and what slipped, one row at a time with
/// the desktop's three presses. A row opens its thing in the detail. The words and the merge are the window's, by the
/// Swift port (`WeekReview`); nothing here sends anything to anyone.
struct ReviewScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(ShellNavigator.self) private var navigator
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var capsule: ReviewCapsule?
    @State private var unfolded: Set<String> = []
    @State private var pressing: String?
    @State private var done = 0

    private var store: ReviewStore { ReviewFeed.store }

    var body: some View {
        let view = store.view
        let merged = view.merged
        let lines = ReviewDesk.lines(view)
        let rows = merged.map { visible($0, gone: view.gone) } ?? []
        // Every row the page draws counts, the Hours rows first: the empty state is only for a week with none.
        let hourIds = merged.map { $0.jobs.map { "hours:\($0.key)" } } ?? []
        WorkPlaceScreen(
            place: .review,
            ids: hourIds + rows.map(\.key),
            loading: merged == nil && !view.settled,
            empty: PlaceEmpty(title: "No Week Yet", line: view.off.first ?? "No computer with Work on has answered."),
            refresh: { await store.load() },
            pick: merged.map { m in
                PlacePick(first: rows.map(\.key), rowOf: { route in rows.first { target(m, $0) == route }?.key }) { key in
                    if let row = rows.first(where: { $0.key == key }), let route = target(m, row) { navigator.open(route) }
                }
            }
        ) {
            if let merged {
                head(view, merged, lines)
                hours(view, merged, lines)
                shipped(merged)
                slipped(view, merged)
            }
        }
        .toolbar { ToolbarItem(placement: .primaryAction) { weekMenu(view) } }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            Group {
                if let capsule {
                    UndoCapsule(line: capsule.line, identifier: "review-undo", undo: capsule.press.map { press in { Task { await undo(press) } } })
                }
            }
            .transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: Motion.travel * 3)))
        }
        .animation(Motion.base, value: capsule?.id)
        .animation(reduceMotion ? nil : Motion.rowLeave, value: view.gone)
        .sensoryFeedback(.impact(weight: .light), trigger: done)
        .task(id: capsule?.id) {
            guard capsule != nil else { return }
            try? await Task.sleep(for: .seconds(FleetToastCenter.lingerSeconds))
            if !Task.isCancelled { capsule = nil }
        }
        // The week shown, the `work.review` push of any host, and the hosts as they stand (one linked again reads afresh).
        .task(id: "\(store.week.from)|\(reviewRev)|\(hostsKey)") {
            ReviewFeed.start(model.registry)
            store.update(hosts: ReviewFeed.inputs(model.registry))
            await store.load()
        }
        // He has seen the week once it has drawn: Today's row and the digest's line go.
        .onChange(of: merged != nil, initial: true) { _, drawn in if drawn { store.markSeen() } }
        .onChange(of: store.week) { _, _ in unfolded = [] }
        .accessibilityIdentifier("review")
    }

    private var hostsKey: String {
        model.registry.ordered.map { "\($0.environment.id):\($0.work.isOn):\($0.work.linked):\($0.workspaces.count)" }.joined(separator: "|")
    }

    private var reviewRev: Int { model.registry.ordered.reduce(0) { $0 + $1.work.reviewRev } }

    // MARK: - the head

    @ViewBuilder
    private func head(_ view: ReviewView, _ merged: WeekReview.Merged, _ lines: ReviewDesk.Lines) -> some View {
        Section {
            ReviewLine(words: WeekReview.madeWords(merged, now: store.now()))
            ForEach(view.off + lines.part, id: \.self) { ReviewLine(words: $0) }
            ForEach(Array(lines.over.enumerated()), id: \.element) { index, line in
                ReviewLine(words: line, tint: Tint.destructiveText, retry: index == 0 ? { await store.load() } : nil)
            }
            if lines.lastKnown { ReviewLine(words: "Slipped shows what was last known.") }
        }
    }

    // MARK: - hours

    @ViewBuilder
    private func hours(_ view: ReviewView, _ merged: WeekReview.Merged, _ lines: ReviewDesk.Lines) -> some View {
        Section {
            ForEach(merged.jobs, id: \.key) { job in
                let h = merged.hours.first { $0.job == job.key }
                ReviewHoursRow(
                    job: job,
                    total: h.flatMap(WeekReview.totalWords),
                    nothing: WeekReview.nothingWords(merged.known),
                    facts: h.map(WeekReview.factsOf),
                    // The calendar's figure only where it was counted, as the desktop's Hours row says it.
                    calendar: h.map { merged.known.calendarCounted && (merged.known.calendar || $0.calendarMs > 0) } ?? false,
                    compare: merged.compare.first { $0.job == job.key }?.words,
                    money: view.money[job.key]
                )
                .id("hours:\(job.key)")
            }
            ForEach(lines.hours, id: \.self) { ReviewLine(words: $0) }
        } header: {
            SectionHeader("Hours").listRowInsets(EdgeInsets())
        } footer: {
            Text(WeekReview.hoursNote).textStep(.meta).padding(.horizontal, Layout.textEdge)
        }
    }

    // MARK: - shipped

    @ViewBuilder
    private func shipped(_ merged: WeekReview.Merged) -> some View {
        Section {
            if merged.shipped.isEmpty {
                ReviewLine(words: merged.known.shipped ? "Nothing shipped" : "Not counted")
            }
            ForEach(merged.jobs, id: \.key) { job in
                let rows = merged.shipped.filter { $0.job == job.key }
                let open = unfolded.contains("shipped:\(job.key)")
                ForEach(open ? rows : Array(rows.prefix(WeekReview.shippedShown)), id: \.key) { row in
                    let words = WeekReview.shippedWords(row)
                    ReviewRowView(sector: job.sector, job: job.name, title: words.title,
                                  detail: [words.lead, words.tail].filter { !$0.isEmpty }.joined(separator: " ").trimmingCharacters(in: .whitespaces),
                                  open: ReviewDesk.target(merged, row).map { route in { navigator.open(route) } })
                }
                if !open, rows.count > WeekReview.shippedShown {
                    ReviewFold(words: "\(rows.count - WeekReview.shippedShown) more") { unfolded.insert("shipped:\(job.key)") }
                }
            }
        } header: {
            SectionHeader("Shipped").listRowInsets(EdgeInsets())
        }
    }

    // MARK: - slipped

    /// The open rows a press has not settled, in the page's order: each job's lead, then its older ones once unfolded.
    private func visible(_ merged: WeekReview.Merged, gone: Set<String>) -> [WeekReview.PlacedSlipped] {
        merged.jobs.flatMap { job in
            let split = WeekReview.splitOlder(merged.slipped.filter { $0.open && $0.job == job.key && !gone.contains($0.key) }, week: merged.week)
            return split.lead + (unfolded.contains("older:\(job.key)") ? split.older : [])
        }
    }

    @ViewBuilder
    private func slipped(_ view: ReviewView, _ merged: WeekReview.Merged) -> some View {
        let open = merged.slipped.filter { $0.open && !view.gone.contains($0.key) }
        let dealt = merged.slipped.filter { !$0.open }
        Section {
            if open.isEmpty {
                ReviewLine(words: merged.known.slipped ? "Nothing slipped" : view.settled ? "Not counted" : "Still reading")
            }
            ForEach(merged.jobs, id: \.key) { job in
                let split = WeekReview.splitOlder(open.filter { $0.job == job.key }, week: merged.week)
                ForEach(split.lead, id: \.key) { slippedRow(merged, job, $0) }
                if !split.older.isEmpty {
                    if unfolded.contains("older:\(job.key)") {
                        ForEach(split.older, id: \.key) { slippedRow(merged, job, $0) }
                    } else {
                        ReviewFold(words: "\(split.older.count) older") { unfolded.insert("older:\(job.key)") }
                    }
                }
            }
            if !dealt.isEmpty {
                if unfolded.contains("dealt") {
                    ForEach(dealt, id: \.key) { row in
                        ReviewRowView(sector: nil, job: nil, title: row.title, detail: nil, muted: true, open: nil)
                    }
                } else {
                    ReviewFold(words: "\(dealt.count) dealt with since") { unfolded.insert("dealt") }
                }
            }
        } header: {
            SectionHeader("Slipped").listRowInsets(EdgeInsets())
        }
    }

    private func slippedRow(_ merged: WeekReview.Merged, _ job: WeekReview.MergedJob, _ row: WeekReview.PlacedSlipped) -> some View {
        let kind = row.kind
        // A row whose source did not answer stands as last known: its presses wait.
        // Each way is drawn by the key of the host it goes to (a mail's Nudge may go through another linked host).
        let linked = { (id: String) in model.registry.client(id)?.work.linked == true }
        let hows: [WeekReview.SettleHow] = row.unchecked || kind == nil ? [] : WeekReview.SettleHow.allCases.filter { how in
            model.registry.client(ReviewDesk.settleHost(merged, row, how, linked: linked))?.work.may(.reviewSettle) == true
        }
        return ReviewRowView(
            sector: job.sector, job: job.name, title: row.title,
            detail: WeekReview.slippedDetail(row, week: merged.week, tz: merged.tz),
            busy: pressing == row.key,
            selected: navigator.detailRoot != nil && navigator.detailRoot == target(merged, row),
            open: target(merged, row).map { route in { navigator.open(route) } }
        )
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            if let kind, hows.contains(.now) {
                Button(WeekReview.settleWords(kind, .now)) { press(merged, row, .now) }.tint(Tint.success)
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if let kind, !hows.isEmpty {
                Button(WeekReview.settleWords(kind, .drop), role: .destructive) { press(merged, row, .drop) }
                Button(WeekReview.settleWords(kind, .later)) { press(merged, row, .later) }.tint(Tint.info)
            }
        }
        .contextMenu {
            if let kind {
                ForEach(hows, id: \.self) { how in
                    Button(WeekReview.settleWords(kind, how), role: how == .drop ? .destructive : nil) { press(merged, row, how) }
                }
            }
        }
        .accessibilityActions {
            if let kind {
                ForEach(hows, id: \.self) { how in Button(WeekReview.settleWords(kind, how)) { press(merged, row, how) } }
            }
        }
        .id(row.key)
    }

    private func target(_ merged: WeekReview.Merged, _ row: WeekReview.PlacedSlipped) -> Route? {
        ReviewDesk.target(merged, job: row.job, environmentId: row.environmentId, slipped: row.ref)
    }

    // MARK: - the week

    private func weekMenu(_ view: ReviewView) -> some View {
        let now = store.now()
        let this = WeekReview.weekOf(now, tz: view.tz)
        var weeks = [this, WeekReview.stepWeek(this, by: -1, tz: view.tz)]
        for week in store.kept where !weeks.contains(week) { weeks.append(week) }
        return Menu {
            Picker("Week", selection: Binding(get: { store.week }, set: { store.show($0) })) {
                ForEach(weeks, id: \.from) { Text(ReviewDesk.weekName($0, now: now, tz: view.tz)).tag($0) }
            }
            Section {
                Button("Previous Week", systemImage: "chevron.left") { store.step(by: -1) }
                Button("Next Week", systemImage: "chevron.right") { store.step(by: 1) }
                    .disabled(store.week.from >= this.from)
            }
        } label: {
            Text(ReviewDesk.weekName(view.week, now: now, tz: view.tz))
        }
        .accessibilityIdentifier("review-week")
    }

    // MARK: - presses

    private func press(_ merged: WeekReview.Merged, _ row: WeekReview.PlacedSlipped, _ how: WeekReview.SettleHow) {
        guard let kind = row.kind else { return }
        if case .open(let route) = ReviewDesk.press(merged, row, how) {
            navigator.open(route)
            return
        }
        pressing = row.key
        Task {
            defer { pressing = nil }
            do {
                let settled = try await store.settle(row, how: how)
                done += 1
                if let sessionId = settled.sessionId {
                    // A nudge drafts in its own thread: it opens, and nothing goes until he sends.
                    navigator.open(.thread(environmentId: settled.environmentId, sessionId: sessionId, seq: nil))
                } else {
                    capsule = ReviewCapsule(line: WeekReview.settledWords(kind, how), press: settled.undo == nil ? nil : settled)
                }
            } catch {
                capsule = ReviewCapsule(line: "That did not go through. \(ActionError.wrap(error).message)", press: nil)
            }
        }
    }

    private func undo(_ press: ReviewSettledPress) async {
        capsule = nil
        do {
            try await store.undo(press)
        } catch {
            capsule = ReviewCapsule(line: "Couldn’t undo", press: nil)
        }
    }
}

struct ReviewCapsule: Equatable {
    let line: String
    let press: ReviewSettledPress?
    let id = UUID()
}

/// A job's hours: its dot and name, the total trailing ("about 11 h"), the facts under it, the week before where it
/// says something, and Money's line for the week.
private struct ReviewHoursRow: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let job: WeekReview.MergedJob
    let total: String?
    let nothing: String
    let facts: WeekReview.Facts?
    let calendar: Bool
    let compare: String?
    let money: MoneyFigure?

    var body: some View {
        let large = typeSize.isAccessibilitySize
        HStack(alignment: .firstTextBaseline, spacing: Layout.rowGap) {
            SectorDot(sector: job.sector)
                .frame(width: Layout.glyphWidth + Layout.markWidth)
            VStack(alignment: .leading, spacing: 2) {
                Text(job.name).textStep(.title, weight: .medium).lineLimit(large ? 2 : 1)
                // At accessibility sizes the total goes under the name, whole, never cut beside it.
                if large, showsFigure { figure }
                ForEach(lines, id: \.self) { Text($0).textStep(.meta) }
            }
            if !large, showsFigure {
                Spacer(minLength: Layout.rowGap)
                figure.lineLimit(1)
            }
        }
        .padding(.vertical, Layout.rowVertical)
        .frame(minHeight: Layout.rowHeight + 8)
        .listRowInsets(Layout.rowInsets)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("review-hours")
    }

    /// No total beside a one-source line: that line is the row's figure.
    private var showsFigure: Bool { !(total != nil && hours?.oneFigure == true) }

    /// The total, or the muted word for none.
    private var figure: some View {
        Text(total ?? nothing)
            .textStep(total == nil ? .meta : .title, weight: total == nil ? .regular : .semibold, tint: total == nil ? Color(.secondaryLabel) : nil)
            .monospacedDigit()
    }

    private var hours: (line: String?, oneFigure: Bool)? { facts.map { WeekReview.hoursLine($0, calendar: calendar) } }

    private var lines: [String] {
        var out: [String] = []
        if total != nil, let line = hours?.line { out.append(line) }
        if let ran = facts?.ran { out.append("Threads ran \(ran)") }
        if let compare { out.append(compare) }
        if let money, money.in != 0 || money.out != 0 {
            out.append("Money \(MoneyPage.money(money.in)) in, \(MoneyPage.money(money.out)) out")
        }
        return out
    }
}

/// A shipped or slipped row: the job's dot in the mark slot, the thing's own title, one muted detail.
private struct ReviewRowView: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let sector: String?
    let job: String?
    let title: String
    let detail: String?
    var muted = false
    var busy = false
    var selected = false
    let open: (() -> Void)?

    var body: some View {
        Group {
            if let open {
                Button(action: open) { content }.buttonStyle(.pressable)
            } else {
                content
            }
        }
        .listRowInsets(Layout.rowInsets)
        .placeSelected(selected)
        .accessibilityElement(children: .combine)
        .accessibilityLabel([job, title, detail].compactMap { $0 }.joined(separator: ", "))
        .accessibilityIdentifier("review-row")
    }

    private var content: some View {
        HStack(spacing: Layout.rowGap) {
            Group {
                if busy {
                    ProgressView().controlSize(.small)
                } else if job != nil {
                    SectorDot(sector: sector)
                }
            }
            .frame(width: Layout.glyphWidth + Layout.markWidth)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).textStep(.title, tint: muted ? Color(.secondaryLabel) : nil).lineLimit(2)
                if let detail, !detail.isEmpty { Text(detail).textStep(.meta).lineLimit(typeSize.isAccessibilitySize ? 2 : 1) }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, Layout.rowVertical)
        .frame(minHeight: Layout.rowHeight + 8)
        .contentShape(Rectangle())
    }
}

/// One quiet line of the page; red with Retry for the first line that failed.
private struct ReviewLine: View {
    let words: String
    var tint: Color?
    var retry: (() async -> Void)?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Layout.rowGap) {
            Text(words).textStep(.meta, tint: tint)
            Spacer(minLength: 0)
            if let retry {
                PillButton("Try Again") { Task { await retry() } }
            }
        }
        .listRowInsets(Layout.rowInsets)
        .listRowSeparator(.hidden)
    }
}

/// "3 older", "2 more", "2 dealt with since": a press shows what is behind it.
private struct ReviewFold: View {
    let words: String
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            Text(words).textStep(.meta).frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, Layout.glyphWidth + Layout.markWidth + Layout.rowGap)
                .frame(minHeight: Layout.rowHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .listRowInsets(Layout.rowInsets)
        .accessibilityIdentifier("review-fold")
    }
}
