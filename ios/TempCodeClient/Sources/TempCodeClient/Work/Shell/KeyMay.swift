import TempCodeContract

/// What a key may press, judged as the host judges it (docs/agents/ios-client.md
/// "Outward presses on the phone"). One table of every Work, Away, video and
/// computer method the phone calls: the capability the host's door asks
/// (`capabilityRefusal` in src/shared/capabilities.ts), the literal word a
/// pillar's person check asks past the door (the Outbox's `mustBePerson`,
/// the rules pillar, mail's send), and how the method crosses a relayed lane
/// (src/shared/contract-relay.ts). A press is drawn only where this says yes,
/// so a key that may only read sees no press at all.
///
/// scripts/ios-keymay-fixture.test.ts writes Fixtures/keymay.json from the
/// host's own rule for every row here and every kind of key; KeyMayTests holds
/// this file to it. A row's source fence (a file others can open, a mail's
/// file) is the host's `can` list per place, not this table.
public struct KeyMay: Sendable, Hashable {
    /// How the socket reaches the host.
    public enum Lane: Sendable, Hashable {
        case direct
        /// Through the box's `/ws?host=` lane.
        case relayed
        /// Through the box, with the Mac's screen locked: a `screen` method is refused.
        case relayedLocked

        /// The lane of a host as the phone knows it now: relayed through the box, and whether the box last said
        /// the Mac's screen is locked (`RelayState.locked`).
        public static func of(relayed: Bool, locked: Bool) -> Lane {
            relayed ? (locked ? .relayedLocked : .relayed) : .direct
        }
    }

    public var caps: [Capability]
    /// The host refused the key (revoked or deleted): nothing is pressed.
    public var revoked: Bool
    public var lane: Lane

    public init(caps: [Capability], revoked: Bool = false, lane: Lane = .direct) {
        self.caps = caps
        self.revoked = revoked
        self.lane = lane
    }

    /// Why LifeOS cannot open through this host, in his words; nil when it can. A Mac reached through the box with its
    /// screen locked refuses the token on the lane, not by the key: that says the Mac is locked, and reads right again
    /// when it unlocks (council 17, Opus 3.1). A key without approve says the key can't.
    public func lifeosRefusal(hostName: String) -> String? {
        if self(.lifeosJwt) { return nil }
        if lifeosLocked { return "\(hostName) is locked." }
        return "This iPhone’s key can’t read LifeOS."
    }

    /// A Mac reached through the box with its screen locked, whose key would read LifeOS once it unlocks.
    public var lifeosLocked: Bool {
        !self(.lifeosJwt) && lane == .relayedLocked && KeyMay(caps: caps, revoked: revoked, lane: .relayed)(.lifeosJwt)
    }

    /// Whether the phone may draw a press of `method` for this key.
    public func callAsFunction(_ method: KeyMethod) -> Bool {
        guard !revoked else { return false }
        let rule = method.rule
        return door(rule) && (rule.word.map { caps.contains($0.capability) } ?? true) && crosses(rule.relay)
    }

    /// `capabilityRefusal`: a pending key reaches nothing here; a given
    /// computer's key never takes a credential or an admin method, and its
    /// admin counts for nothing; otherwise `allows`.
    private func door(_ rule: KeyRule) -> Bool {
        if caps.contains(.pending) { return false }
        if caps.contains(.device) {
            if rule.credential || rule.need == .admin { return false }
            return Self.allows(caps.filter { $0 != .admin }, rule.need)
        }
        return Self.allows(caps, rule.need)
    }

    /// `read` is implied; `admin` covers every need in this table. Approve never implies operate.
    private static func allows(_ caps: [Capability], _ need: KeyNeed) -> Bool {
        need == .read || caps.contains(need.capability) || caps.contains(.admin)
    }

    private func crosses(_ relay: KeyRelay) -> Bool {
        switch (lane, relay) {
        case (.direct, _), (_, .link), (_, .box), (.relayed, .screen): true
        case (.relayedLocked, .screen), (_, .never): false
        }
    }
}

/// The capability a method asks.
public enum KeyNeed: String, Sendable, Hashable {
    case read, operate, approve, admin

    var capability: Capability { Capability(rawValue: rawValue) }
}

/// How a method crosses a relayed lane (contract-relay.ts).
public enum KeyRelay: String, Sendable, Hashable {
    /// `RELAY_METHODS` 'link': forwarded while the host is reachable.
    case link
    /// `RELAY_METHODS` 'screen': refused while the Mac is locked.
    case screen
    /// The lane's box answers it itself (`video.open`, `video.close`; remote/relay.ts).
    case box
    /// Never on a lane (`RELAY_NOT_CARRIED`, or in no table): asked of the box's own socket.
    case never
}

public struct KeyRule: Sendable, Hashable {
    public var need: KeyNeed
    /// The word a pillar's person check wants on the key itself (`admin` does not stand in).
    public var word: KeyNeed?
    public var relay: KeyRelay
    /// Carries a credential: a given computer's key is refused it (`DEVICE_REFUSED`).
    public var credential: Bool

    public init(_ need: KeyNeed, word: KeyNeed? = nil, relay: KeyRelay = .link, credential: Bool = false) {
        self.need = need
        self.word = word
        self.relay = relay
        self.credential = credential
    }
}

/// Every method the phone's Work, Away, video and computer screens call. The
/// raw value is what the host sees; `?k=v` names a parameter that changes its answer.
public enum KeyMethod: String, CaseIterable, Sendable, Hashable {
    // the Outbox
    case outboxList = "work.outbox.list"
    case outboxGet = "work.outbox.get"
    case outboxResults = "work.outbox.results"
    case outboxGrants = "work.outbox.grants"
    case outboxRules = "work.outbox.rules"
    case outboxSend = "work.outbox.send"
    case outboxDiscard = "work.outbox.discard"
    case outboxEdit = "work.outbox.edit"
    case outboxUndo = "work.outbox.undo"
    case outboxGrant = "work.outbox.grant"
    case outboxUngrant = "work.outbox.ungrant"
    case outboxSetRules = "work.outbox.setRules"
    case outboxDecide = "work.outbox.decide"
    case outboxRequests = "work.outbox.requests"
    case outboxRequestGet = "work.outbox.request.get"
    case outboxRequestView = "work.outbox.request.view"
    case outboxDecline = "work.outbox.decline"
    case outboxSendNow = "work.outbox.sendNow"
    case outboxCancelSend = "work.outbox.cancelSend"
    case outboxUndoSend = "work.outbox.undoSend"
    case outboxAskAgain = "work.outbox.askAgain"
    // the switch, the workspace, Away
    case workGet = "work.get"
    case workSet = "work.set"
    case workspaceGet = "work.workspace.get"
    case workspaceSet = "work.workspace.set"
    case workspaceCreate = "workspace.create"
    case sessionCreate = "session.create"
    case sessionCreateAuto = "session.create?permission=auto"
    /// Ask about an item or a file in its own thread.
    case sessionSend = "session.send"
    case awayGet = "away.get"
    case awaySet = "away.set"
    // LifeOS, mail, capture, money
    case lifeosStatus = "work.lifeos.status"
    case lifeosJwt = "work.lifeos.jwt"
    case mailSend = "work.mail.send"
    // Mail as a place: a mail he timed moved, sent now (outward) or taken back; Waiting on's settings; the chat beside a mail
    case mailWaiting = "work.mail.waiting"
    case mailReschedule = "work.mail.reschedule"
    case mailSendNow = "work.mail.sendNow"
    case mailCancel = "work.mail.cancel"
    case mailChatAdopt = "work.mail.chat.adopt"
    case mailChatFind = "work.mail.chat.find"
    case captureState = "work.capture.state"
    case captureFile = "work.capture.file"
    case moneyState = "work.money.state"
    case moneyParse = "work.money.parse"
    case moneyReceive = "work.money.receive"
    // Today
    case tasksDone = "work.tasks.done"
    case mailNudge = "work.mail.nudge"
    case messagesUnanswered = "work.messages.unanswered"
    case moneyOwed = "work.money.owed"
    case prepUpcoming = "work.prep.upcoming"
    case reviewReady = "work.review.ready"
    case clashesList = "work.clashes.list"
    case clashesLeave = "work.clashes.leave"
    // Review: each host's part of a week, its kept weeks, a slipped row settled and taken back, the week seen
    case reviewWeek = "work.review.week"
    case reviewList = "work.review.list"
    case reviewSettle = "work.review.settle"
    case reviewUndo = "work.review.undo"
    case reviewSeen = "work.review.seen"
    // A job's Money: the span read, the jobs' sums, a waiting receipt filed or dropped and its picture, an open row paid
    case moneyRead = "work.money.read"
    case moneySums = "work.money.sums"
    case moneyAccept = "work.money.accept"
    case moneyDrop = "work.money.drop"
    case moneyPicture = "work.money.picture"
    case moneyPaid = "work.money.paid"
    // Messages: his reply through the host, its read-back by attempt key, a thread's copy-only drafts
    case messagesSend = "work.messages.send"
    case messagesAttempt = "work.messages.attempt"
    case messagesUndo = "work.messages.undo"
    case messagesRetry = "work.messages.retry"
    case messagesSearch = "work.messages.search"
    case messagesUnread = "work.messages.unread"
    case messagesDrafts = "work.messages.drafts"
    case messagesDropDraft = "work.messages.dropDraft"
    // A meeting's page: the facts, Prepare and Follow Up (each starts a Work thread that only drafts), his notes, the
    // tasks he ticks (filed in LifeOS, never sent); a clash: the drive, This Is Fine, his answer (it goes to other people)
    case prepPage = "work.prep.page"
    case prepBrief = "work.prep.brief"
    case prepNotes = "work.prep.notes"
    case prepFollowUp = "work.prep.followUp"
    case prepDecide = "work.prep.decide"
    case prepPeople = "work.prep.people"
    case clashesMiles = "work.clashes.miles"
    case clashesWaive = "work.clashes.waive"
    case clashesAnswer = "work.clashes.answer"
    // People: the forms a person answered
    case msformsByPerson = "work.msforms.byPerson"
    // house rules
    case rulesList = "work.rules.list"
    case rulesForDraft = "work.rules.forDraft"
    case rulesAdd = "work.rules.add"
    case rulesEdit = "work.rules.edit"
    case rulesRemove = "work.rules.remove"
    case rulesOrder = "work.rules.order"
    case rulesDecide = "work.rules.decide"
    // guest links
    case guestsList = "work.guests.list"
    case guestsCreate = "work.guests.create"
    case guestsRekey = "work.guests.rekey"
    case guestsRevoke = "work.guests.revoke"
    case guestsTicket = "work.guests.ticket"
    case guestsForItem = "work.guests.forItem"
    case guestsSetRole = "work.guests.setRole"
    case guestsAttempt = "work.guests.attempt"
    // the clicker: a running show, and his press on it
    case slidesShowState = "work.slides.show.state"
    case slidesShowPress = "work.slides.show.press"
    // the digest, routines
    case digestGet = "work.digest.get"
    case digestList = "work.digest.list"
    case digestSeen = "work.digest.seen"
    case digestSet = "work.digest.set"
    case routinesList = "work.routines.list"
    case routinesPause = "work.routines.pause"
    // a thread's items and the readers
    case canvasList = "work.canvas.list"
    case canvasOpen = "work.canvas.open"
    case canvasClose = "work.canvas.close"
    // a mail's file: fetched onto its host, read by range, kept in the workspace's folder (Save to Workspace)
    case canvasFetch = "work.canvas.fetch"
    case canvasRead = "work.canvas.read"
    case canvasKeep = "work.canvas.keep"
    // the composer's `@` in a Work thread (it reads his mail and tasks), and the Item segment's order
    case canvasMentions = "work.canvas.mentions"
    case canvasReorder = "work.canvas.reorder"
    case browserState = "work.browser.state"
    case browserDrive = "work.browser.drive"
    case dashboardsOpen = "work.dashboards.open"
    case docsOpen = "work.docs.open"
    case docsThreads = "work.docs.threads"
    case docsThread = "work.docs.thread"
    case historyBranches = "work.history.branches"
    case historyCompare = "work.history.compare"
    case historyVersions = "work.history.versions"
    case historyDecide = "work.history.decide"
    case sheetsOpen = "work.sheets.open"
    case sheetsReview = "work.sheets.review"
    case slidesOpen = "work.slides.open"
    case slidesRead = "work.slides.read"
    case slidesSlide = "work.slides.slide"
    case slidesReview = "work.slides.review"
    case pdfOpen = "work.pdf.open"
    case pdfRead = "work.pdf.read"
    case pdfFirst = "work.pdf.first"
    case mediaView = "work.media.view"
    case mediaTile = "work.media.tile"
    case mediaSegment = "work.media.segment"
    case mediaNote = "work.media.note"
    case formatsPreview = "work.formats.preview"
    case formatsPreviewRead = "work.formats.previewRead"
    case formsResponses = "work.forms.responses"
    case msformsList = "work.msforms.list"
    case meetingsGet = "work.meetings.get"
    // the reader (M3b): his highlights, notes and a form's fields on a PDF, an agent's values taken or dropped;
    // a recording read to play; a meeting's tasks filed in LifeOS or dropped (files, sends to no one); a version back
    case pdfMark = "work.pdf.mark"
    case pdfUnmark = "work.pdf.unmark"
    case pdfSetField = "work.pdf.setField"
    case pdfReview = "work.pdf.review"
    case meetingsRecording = "work.meetings.recording"
    case meetingsDecide = "work.meetings.decide"
    case historyRestore = "work.history.restore"
    case officeLiveAddress = "work.office.live.address"
    // the Files place
    case filesPlaces = "work.files.places"
    case filesList = "work.files.list"
    case filesSearch = "work.files.search"
    case filesThreads = "work.files.threads"
    case filesRead = "work.files.read"
    case filesPreview = "work.files.preview"
    case filesOpen = "work.files.open"
    case filesSeen = "work.files.seen"
    case filesStar = "work.files.star"
    case filesMake = "work.files.make"
    case filesRename = "work.files.rename"
    case filesTrash = "work.files.trash"
    case filesRestore = "work.files.restore"
    case filesUpload = "work.files.upload"
    case filesMove = "work.files.move"
    case filesCopy = "work.files.copy"
    case filesNames = "work.files.names"
    case filesSearches = "work.files.searches"
    case filesAcross = "work.files.across"
    case filesThumbs = "work.files.thumbs"
    case attachmentSettings = "attachment.settings"
    case attachmentBegin = "attachment.begin"
    case attachmentChunk = "attachment.chunk"
    case attachmentCommit = "attachment.commit"
    case attachmentAbort = "attachment.abort"
    // computers and live video
    case computerSessions = "computer.sessions"
    case computerStop = "computer.stop"
    case computerDrive = "computer.drive"
    case videoOpen = "video.open"
    case videoClose = "video.close"
    case videoPaste = "video.paste"
    case videoCopy = "video.copy"
    // Open on a computer: the host's window goes to a place this key can read
    case reveal = "work.reveal"
    // Search's Work scope: both speeds, and his mark for Recent (an answer holds what LifeOS holds)
    case searchQuery = "work.search.query"
    case searchOpened = "work.search.opened"
    // M5b, a job's small places: plays run with a short input; a routine run now and its last runs; a template made
    // in Files' New; a dashboard read again; our forms and Microsoft's (Close is operate, Reopen also asks approve on
    // the key itself: it starts a form taking answers again); Connections; the Windows VM woken and put to sleep
    case playsList = "work.routines.plays"
    case playStart = "work.routines.playStart"
    case routinesRuns = "work.routines.runs"
    case routinesRunNow = "work.routines.runNow"
    case templatesList = "work.templates.list"
    case templatesMake = "work.templates.make"
    case dashboardsRefresh = "work.dashboards.refresh"
    case formsList = "work.forms.list"
    case formsClose = "work.forms.close?open=false"
    case formsReopen = "work.forms.close?open=true"
    case msformsGet = "work.msforms.get"
    case msformsResponses = "work.msforms.responses"
    case msformsClose = "work.msforms.close?open=false"
    case msformsReopen = "work.msforms.close?open=true"
    case msformsSeen = "work.msforms.seen"
    case health = "work.health"
    case lapses = "work.lapses"
    case winvmState = "work.winvm.state"
    case winvmWake = "work.winvm.wake"
    case winvmSleep = "work.winvm.sleep"

    /// The method's row: the host's door, its person word, its relay.
    public var rule: KeyRule {
        switch self {
        case .outboxSend, .outboxDiscard, .outboxEdit, .outboxUndo,
             .outboxDecide, .outboxRequests, .outboxRequestGet, .outboxRequestView, .outboxDecline,
             .outboxSendNow, .outboxCancelSend, .outboxUndoSend, .outboxAskAgain,
             .rulesAdd, .rulesEdit, .rulesRemove, .rulesOrder, .rulesDecide,
             .mailSend, .mailReschedule, .mailSendNow, .mailCancel, .messagesSend, .messagesAttempt, .messagesUndo, .messagesRetry, .clashesAnswer:
            KeyRule(.approve, word: .approve)
        case .mailNudge, .mailChatAdopt, .messagesDropDraft:
            KeyRule(.operate, word: .operate)
        case .formsReopen, .msformsReopen:
            KeyRule(.operate, word: .approve)
        case .outboxGrant, .outboxUngrant, .outboxSetRules:
            KeyRule(.admin, word: .admin)
        case .workSet, .workspaceSet, .digestSet:
            KeyRule(.admin)
        case .guestsCreate, .guestsRekey, .guestsSetRole, .guestsAttempt, .sessionCreateAuto, .tasksDone, .prepDecide, .meetingsDecide:
            KeyRule(.approve)
        // Review's every call asks the person's own approve (review/settle.ts `mustBePerson`): admin does not stand in.
        case .reviewWeek, .reviewList, .reviewSettle, .reviewUndo, .reviewSeen:
            KeyRule(.approve, word: .approve)
        case .lifeosJwt:
            KeyRule(.approve, relay: .screen, credential: true)
        case .reveal, .searchQuery, .searchOpened, .canvasFetch, .canvasRead, .canvasMentions:
            KeyRule(.approve, relay: .screen)
        case .awaySet, .videoPaste, .videoCopy:
            KeyRule(.approve, relay: .never)
        case .videoOpen, .videoClose:
            KeyRule(.approve, relay: .box)
        case .computerDrive:
            KeyRule(.operate, relay: .never)
        case .awayGet:
            KeyRule(.read, relay: .never)
        case .filesMake, .filesRename, .filesTrash, .filesUpload, .filesMove, .filesCopy:
            KeyRule(.operate, relay: .screen)
        // The clicker's press asks operate itself (slides/clicker.ts `refuse`): admin does not stand in.
        case .slidesShowPress:
            KeyRule(.operate, word: .operate)
        // Put Back (and Delete's Undo) asks operate itself (files/handle.ts `admitRestore`): admin does not stand in.
        case .filesRestore:
            KeyRule(.operate, word: .operate, relay: .screen)
        case .filesRead, .filesPreview, .filesThumbs:
            KeyRule(.read, relay: .screen)
        case .workspaceCreate, .sessionCreate, .sessionSend, .captureFile, .moneyReceive,
             .guestsRevoke, .guestsTicket, .digestSeen, .routinesPause,
             .canvasOpen, .canvasClose, .canvasKeep, .canvasReorder, .browserDrive, .docsThread, .historyDecide,
             .sheetsReview, .slidesReview, .mediaNote, .formatsPreview,
             .filesOpen, .filesSeen, .filesStar,
             .attachmentBegin, .attachmentChunk, .attachmentCommit, .attachmentAbort,
             .computerStop, .prepBrief, .prepNotes, .prepFollowUp, .prepPeople, .clashesWaive,
             .pdfMark, .pdfUnmark, .pdfSetField, .pdfReview, .historyRestore,
             .moneyAccept, .moneyDrop, .moneyPaid,
             .playStart, .routinesRunNow, .templatesMake, .dashboardsRefresh, .formsClose, .msformsClose, .msformsSeen,
             .winvmWake, .winvmSleep:
            KeyRule(.operate)
        case .outboxList, .outboxGet, .outboxResults, .outboxGrants, .outboxRules,
             .workGet, .workspaceGet, .lifeosStatus, .captureState, .moneyState, .moneyParse,
             .messagesUnanswered, .messagesSearch, .messagesUnread, .messagesDrafts, .moneyOwed, .prepUpcoming, .reviewReady, .clashesList, .clashesLeave,
             .rulesList, .rulesForDraft, .guestsList, .guestsForItem, .slidesShowState, .digestGet, .digestList, .routinesList,
             .canvasList, .browserState, .dashboardsOpen, .docsOpen, .docsThreads,
             .historyBranches, .historyCompare, .historyVersions, .sheetsOpen, .slidesOpen,
             .slidesRead, .slidesSlide, .pdfOpen, .pdfRead, .pdfFirst, .mediaView, .mediaTile, .mediaSegment,
             .formatsPreviewRead, .formsResponses, .msformsList, .meetingsGet, .meetingsRecording, .officeLiveAddress,
             .filesPlaces, .filesList, .filesSearch, .filesThreads, .filesNames, .filesSearches, .filesAcross,
             .attachmentSettings, .computerSessions, .prepPage, .clashesMiles, .msformsByPerson, .mailWaiting, .mailChatFind,
             .moneyRead, .moneySums, .moneyPicture,
             .playsList, .routinesRuns, .templatesList, .formsList, .msformsGet, .msformsResponses, .health, .lapses, .winvmState:
            KeyRule(.read)
        }
    }
}
