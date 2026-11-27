import LifeKit
import LifeKitUI
import SwiftUI
import TempCodeClient
import TempCodeContract

/// A person's page, in the detail (docs/IOS-DESIGN.md "Work on the phone", ### People): who they are, then what is
/// open with them in the job, each section only when it has something: Mail, Coming Up, Asked for by Them, Waiting on
/// Them, Shared with Them, Past Meetings, Answered. LifeOS's `people:page` on the job's own session, asked about the
/// host's guest links named for them; the forms they answered from the host (`work.msforms.byPerson`). The bar holds
/// Write (Mail's own composer, its send held as every send) and New Thread (a Work thread with their chip).
struct PersonScreen: View {
    @Environment(AppModel.self) private var model
    let environmentId: String
    let workspaceId: String
    let personId: String

    var body: some View {
        if let client = model.registry.client(environmentId),
           let host = MessagesReads.host(environmentId: environmentId, workspaceId: workspaceId, registry: model.registry),
           let sector = host.sector?.rawValue {
            PersonPageView(client: client, host: host, workspaceId: workspaceId, sector: sector, personId: personId)
                .id("\(environmentId)|\(workspaceId)|\(personId)")
        } else {
            ContentUnavailableView("Person Not Here", systemImage: WorkPlace.people.glyph, description: Text("Their job’s computer is not paired with this iPhone."))
                .navigationBarTitleDisplayMode(.inline)
        }
    }
}

private struct PersonPageView: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(ShellNavigator.self) private var navigator
    @Bindable var host: WorkLifeHost
    let client: EnvironmentClient
    let workspaceId: String
    let sector: String
    let personId: String
    /// The host's guest links, read once and again on their push; nil until the first answer (the page never waits
    /// for them).
    @State private var links: [GuestLinkRow]?
    @State private var answered: [MsFormAnswered] = []
    /// The page as it last answered, and the name it gave: shown while the page is asked again with that name's
    /// guest links, so the page lands once and never blanks.
    @State private var shown: PersonPage?
    @State private var knownName: String?

    /// What the page can say before it has a page.
    enum Waiting: Equatable { case loading, unavailable(String), failed, missing }

    init(client: EnvironmentClient, host: WorkLifeHost, workspaceId: String, sector: String, personId: String) {
        self.client = client
        _host = Bindable(host)
        self.workspaceId = workspaceId
        self.sector = sector
        self.personId = personId
    }

    var body: some View {
        let store = host.store
        let directory = store.map { PeopleReads.directory($0, sector: sector) }
        // The directory names the person when it holds them; else the page's own answer does. The page is asked as
        // soon as the guest links are known, never waiting on the directory (which reads only the first thousand).
        let name = Self.name(directory, personId: personId) ?? knownName
        let mine = name.map { PeopleRules.links(links ?? [], name: $0, now: Date().timeIntervalSince1970 * 1000) } ?? []
        // Asked as soon as LifeOS is up, with the guest links known so far (none until the host lists them): the links
        // join the next ask, and the page shown stays meanwhile.
        let query = store.map { PeopleReads.page($0, personId: personId, sector: sector, shared: mine) }
        let answer = Self.answer(query, personId: personId)
        let read = answer ?? nil
        let missing = answer.map { $0 == nil } == true
        // LifeOS saying it holds no such person (merged, deleted) closes the kept page: "Can’t Find This Person".
        let page = PeopleRules.shownPage(answer: answer, kept: shown)
        let stale = PeopleRules.refreshLine(kept: page != nil, failing: Self.failing(query))
        content(page: page, waiting: Self.waiting(phase: host.phase, query: query), stale: stale, links: mine, retry: {
            if host.store == nil { Task { await host.prepare() } } else { query?.retryNow() }
        })
            // Write's Send counts its five seconds here too: this page draws no Mail capsule, so TempCode's own shows
            // the wait with Undo (a stopped or refused send is the sticky toast, `MailPresses.tell`).
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if let counting = MailPresses.shared.counting(on: host.scene) {
                    UndoCapsule(line: counting.line, identifier: "mail-undo") { MailPresses.shared.takeBack(counting) }
                        .transition(.opacity)
                }
            }
            .animation(Motion.base, value: MailPresses.shared.counting(on: host.scene)?.id)
            // This page offers its scene's Undo while shown; away from it, the tab's foot does (`ElsewhereUndo`).
            .task(id: host.scene.map { ObjectIdentifier($0) }) { if let scene = host.scene { await MailPresses.shared.pageShown(scene) } }
            .onChange(of: read) { _, now in
                guard let now else { return }
                shown = now
                knownName = now.person.name
            }
            // Gone from LifeOS: the next ask (new guest links) never brings the old page back while it is asked.
            .onChange(of: missing) { _, missing in
                if missing { shown = nil }
            }
            .navigationTitle(missing ? WorkPlace.people.title : page?.person.name ?? name ?? WorkPlace.people.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if let page {
                    ToolbarItemGroup(placement: .primaryAction) { verbs(page.person) }
                }
            }
            .holdingChats(store, keys: [directory?.key, query?.key].compactMap { $0 })
            .sheet(item: $host.sheet) { presented in
                if let store = host.store, let scene = host.scene {
                    LifeSheetView(presented.sheet)
                        .sheetPage(facing: presented.side, size: presented.sheet.size)
                        .lifeChrome(store: store, scene: scene)
                }
            }
            .sheet(item: $host.starting) { chip in StartThreadSheet(host: host, chip: chip) }
            .onChange(of: host.started) {
                guard let session = host.started else { return }
                host.started = nil
                navigator.open(.thread(environmentId: client.environment.id, sessionId: session.id, seq: nil))
            }
            .task(id: ObjectIdentifier(host)) { await host.prepare() } // a fresh session from a parent redraw is asked for too
            .onAppear { ShownLifeHost.shared.host = host }
            .task(id: client.work.guestsRev) { await readLinks() }
            .task(id: page?.person.emails) { await readAnswered(page?.person.emails ?? []) }
            .accessibilityIdentifier("person")
    }

    @ViewBuilder private func content(page: PersonPage?, waiting: Waiting, stale: String?, links: [GuestLinkRow], retry: @escaping () -> Void) -> some View {
        if let page {
            List {
                // A read that failed over the page on screen: the last read stays under it, said once, with Try Again.
                if let stale {
                    Section { FailedRead(words: stale, retry: { retry() }, identifier: "person-failed", tint: Tint.destructiveText) }
                }
                Section {
                    // Each address and number on its own line, never hyphenated inside an address (a wrapped one is:
                    // "dana@cos-micgames"). At accessibility sizes it shrinks to fit whole, to half its size; past that,
                    // or at any size, a long one keeps its two ends and gives up its middle.
                    let reach = page.person.emails + page.person.phones
                    if !reach.isEmpty {
                        VStack(alignment: .leading, spacing: 2) {
                            ForEach(reach, id: \.self) { way in
                                Text(way).textStep(.meta).lineLimit(1).truncationMode(.middle)
                                    .minimumScaleFactor(typeSize.isAccessibilitySize ? 0.5 : 1)
                            }
                        }
                        .textSelection(.enabled)
                        .accessibilityElement(children: .combine)
                    }
                    let notes = page.person.notes.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !notes.isEmpty { Text(notes).textStep(.title) }
                }
                let sections = PeopleRules.sections(page, links: links, answered: answered)
                ForEach(sections, id: \.self) { section in
                    Section(section.title) { rows(section, page: page, links: links) }
                }
                if sections.isEmpty {
                    Section { Text("Nothing is open with \(page.person.name) here.").textStep(.meta) }
                }
            }
            .listStyle(.insetGrouped)
        } else {
            switch waiting {
            case .loading:
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            case .missing:
                ContentUnavailableView("Can’t Find This Person", systemImage: WorkPlace.people.glyph)
            case .unavailable(let why):
                ContentUnavailableView {
                    Label("Can’t Reach LifeOS", systemImage: WorkPlace.people.glyph)
                } description: {
                    Text(why)
                } actions: {
                    // Try Again only for silence: a sign-in, a connect or an ended access asks nothing again (the shared rule).
                    if host.down?.isSilence == true { Button("Try Again", action: retry) }
                }
            case .failed:
                ContentUnavailableView {
                    Label("Can’t Read This Person", systemImage: WorkPlace.people.glyph)
                } actions: {
                    Button("Try Again", action: retry)
                }
            }
        }
    }

    @ViewBuilder private func rows(_ section: PeopleRules.Section, page: PersonPage, links: [GuestLinkRow]) -> some View {
        switch section {
        case .mail:
            ForEach(page.mail) { mail in
                LineRow(title: mail.subject.isEmpty ? "(no subject)" : mail.subject, line: mail.snippet, trail: TimeFormat.stamp(Int(mail.lastMessageAt)), strong: mail.unread) {
                    host.open(.thread(id: mail.id))
                    navigator.open(.workView(environmentId: client.environment.id, workspaceId: workspaceId, view: "mail"))
                }
            }
        case .coming, .recent:
            ForEach(section == .coming ? page.coming : page.recent) { event in
                LineRow(title: event.title, line: event.location, trail: TimeFormat.stamp(Int(event.startsAt))) {
                    navigator.open(.prep(environmentId: client.environment.id, workspaceId: workspaceId, eventId: event.id))
                }
            }
        case .asked, .waiting:
            ForEach(page.tasks.filter { $0.relation == section.rawValue }) { task in
                LineRow(title: task.title, line: nil, trail: task.dueAt.map { TimeFormat.stamp(Int($0)) }) {
                    host.present(.task(id: task.id), facing: .trailing)
                }
            }
        case .shared:
            ForEach(page.shared, id: \.id) { item in
                let link = links.first { $0.source.id == item.id }
                LineRow(title: item.title, line: link.map { PeopleRules.linkWords($0, calendar: .current) }, trail: nil, open: nil)
            }
        case .answered:
            ForEach(answered, id: \.formId) { form in
                LineRow(title: form.title, line: nil, trail: form.at.map { TimeFormat.stamp(Int($0)) }) {
                    navigator.open(.workView(environmentId: client.environment.id, workspaceId: workspaceId, view: "forms"))
                }
            }
        }
    }

    @ViewBuilder private func verbs(_ person: PersonPage.Person) -> some View {
        if let address = person.emails.first, client.work.may(.lifeosJwt) {
            Button("Write", systemImage: "square.and.pencil") { host.present(.compose(.new(to: [address])), facing: .trailing) }
                .accessibilityIdentifier("person-write")
        }
        if client.work.may(.sessionCreate) {
            Button("New Thread", systemImage: "plus.bubble") {
                host.startThread(about: ChipWords.lifeos(.person, table: .people, id: person.id, label: person.name), in: workspaceId)
            }
            .accessibilityIdentifier("person-thread")
        }
    }

    private func readLinks() async {
        #if DEBUG
        if PeopleFixtures.on { links = []; return }
        #endif
        // A host that cannot list its links asks LifeOS about none: the page still lands.
        links = (try? await client.work.guestLinks()) ?? links ?? []
    }

    private func readAnswered(_ emails: [String]) async {
        #if DEBUG
        if PeopleFixtures.on { answered = emails.isEmpty ? [] : PeopleFixtures.answered; return }
        #endif
        guard !emails.isEmpty, client.work.may(.msformsByPerson) else { return }
        if let rows = try? await client.work.formsAnswered(workspaceId: workspaceId, emails: emails) { answered = PeopleRules.answered(rows) }
    }

    static func name(_ directory: LiveQuery<[DirectoryPerson]>?, personId: String) -> String? {
        #if DEBUG
        if PeopleFixtures.on { return PeopleFixtures.people.first { $0.id == personId }?.name }
        #endif
        return directory?.value?.first { $0.id == personId }?.name
    }

    /// Before a page: LifeOS out of reach (the host's own words, as the list says them), a read that failed, LifeOS
    /// answering that it holds no such person (merged, deleted), else still loading.
    static func waiting(phase: WorkLifeHost.Phase, query: LiveQuery<PersonPage?>?) -> Waiting {
        #if DEBUG
        if PeopleFixtures.on { return .loading }
        #endif
        if case .unavailable(let why) = phase { return .unavailable(why) }
        guard let query else { return .loading }
        if query.hasFailed { return .failed }
        if case .some(.none) = query.value { return .missing }
        return .loading
    }

    /// The page's query is failing, whether or not it holds an answer: a kept answer, or the page shown from the ask
    /// before (new guest links), says nothing of it. The next answer clears it.
    static func failing(_ query: LiveQuery<PersonPage?>?) -> Bool {
        #if DEBUG
        if PeopleFixtures.on { return false }
        #endif
        return query?.failure != nil
    }

    /// LifeOS's answer: nil while it is asked, `.some(nil)` for a person it does not hold (`PeopleRules.shownPage`).
    static func answer(_ query: LiveQuery<PersonPage?>?, personId: String) -> PersonPage?? {
        #if DEBUG
        if PeopleFixtures.on { return PeopleFixtures.page(personId).map(Optional.some) }
        #endif
        return query?.value
    }
}

/// A row of a page's section: a title, one muted line, a trailing stamp; a button when it opens something.
struct LineRow: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let title: String
    let line: String?
    let trail: String?
    var strong = false
    let open: (() -> Void)?

    var body: some View {
        if let open {
            Button(action: open) { label }
                .buttonStyle(.pressable)
        } else {
            label
        }
    }

    private var label: some View {
        HStack(alignment: .firstTextBaseline, spacing: Layout.rowGap) {
            VStack(alignment: .leading, spacing: 2) {
                // At accessibility sizes the words wrap further, so a long subject is read whole.
                Text(title).textStep(.title, weight: strong ? .semibold : .regular).lineLimit(typeSize.isAccessibilitySize ? 4 : 2)
                if let line, !line.isEmpty { Text(line).textStep(.meta).lineLimit(typeSize.isAccessibilitySize ? 4 : 2) }
            }
            Spacer(minLength: Layout.rowGap)
            if let trail { Text(trail).textStep(.stamp).lineLimit(1) }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
