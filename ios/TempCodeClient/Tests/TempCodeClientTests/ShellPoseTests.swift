import Foundation
import Testing
@testable import TempCodeClient

/// The layout rule on the iPhone Duo's four metrics, a Max phone and an iPad-class window.
@Suite struct ShellPoseTests {
    @Test func `unfolded landscape tiles the sidebar beside the detail`() {
        #expect(ShellPose.of(horizontal: .regular, vertical: .regular, size: CGSize(width: 951, height: 669)) == .split(sidebar: .tiled))
    }

    @Test func `unfolded portrait overlays the sidebar behind the system toggle`() {
        #expect(ShellPose.of(horizontal: .regular, vertical: .regular, size: CGSize(width: 669, height: 951)) == .split(sidebar: .overlay))
    }

    @Test func `folded portrait is the stack`() {
        #expect(ShellPose.of(horizontal: .compact, vertical: .regular, size: CGSize(width: 466, height: 678)) == .stack(short: false))
    }

    @Test func `folded landscape is the short stack`() {
        #expect(ShellPose.of(horizontal: .compact, vertical: .compact, size: CGSize(width: 678, height: 466)) == .stack(short: true))
    }

    @Test func `a Max phone is the stack upright and the split on its side, as its size classes say`() {
        #expect(ShellPose.of(horizontal: .compact, vertical: .regular, size: CGSize(width: 440, height: 956)) == .stack(short: false))
        // A Max phone on its side reads regular × compact: the width decides, as it does for NavigationSplitView.
        #expect(ShellPose.of(horizontal: .regular, vertical: .compact, size: CGSize(width: 956, height: 440)) == .split(sidebar: .tiled))
    }

    @Test func `a Pro phone on its side is the short stack`() {
        #expect(ShellPose.of(horizontal: .compact, vertical: .compact, size: CGSize(width: 874, height: 402)) == .stack(short: true))
    }

    @Test func `a regular square window tiles`() {
        #expect(ShellPose.of(horizontal: .regular, vertical: .regular, size: CGSize(width: 800, height: 800)) == .split(sidebar: .tiled))
    }

    @Test func `no size class yet reads as the stack`() {
        #expect(ShellPose.of(horizontal: nil, vertical: nil, size: .zero) == .stack(short: false))
    }

    @Test func `titles are inline only on the short stack`() {
        #expect(ShellPose.stack(short: true).titleDisplay == .inline)
        #expect(ShellPose.stack(short: false).titleDisplay == .large)
        #expect(ShellPose.split(sidebar: .tiled).titleDisplay == .large)
        #expect(ShellPose.split(sidebar: .overlay).titleDisplay == .large)
    }

    @Test func `isSplit, isStack and isOverlay`() {
        #expect(ShellPose.split(sidebar: .tiled).isSplit)
        #expect(!ShellPose.split(sidebar: .tiled).isStack)
        #expect(ShellPose.stack(short: false).isStack)
        #expect(ShellPose.split(sidebar: .overlay).isOverlay)
        #expect(!ShellPose.split(sidebar: .tiled).isOverlay)
    }
}

@Suite struct SidebarMemoryTests {
    @Test("a fold's own writes of the split's visibility are not the person's toggle") func aFoldsOwnWritesAreNotThePersons() {
        let tiled = ShellPose.split(sidebar: .tiled)
        // Collapsing: the split writes `.all` with the pose already a stack.
        #expect(!ShellPose.keepsVisibilityWrite(pose: .stack(short: false), sincePoseChange: 0.03))
        #expect(!ShellPose.keepsVisibilityWrite(pose: .stack(short: false), sincePoseChange: 30))
        // Expanding: `.detailOnly` then `.all` within 40 ms of the split.
        #expect(!ShellPose.keepsVisibilityWrite(pose: tiled, sincePoseChange: 0.004))
        #expect(!ShellPose.keepsVisibilityWrite(pose: tiled, sincePoseChange: 0.041))
        // The person's toggle, once the pose has held.
        #expect(ShellPose.keepsVisibilityWrite(pose: tiled, sincePoseChange: 0.5))
        #expect(ShellPose.keepsVisibilityWrite(pose: .split(sidebar: .overlay), sincePoseChange: 12))
    }

    @Test("a split left hiding what the shell shows is asked to read again, in a split only") func aStraySplitIsAskedAgain() {
        // The Work tab built in the overlay pose wrote `.detailOnly`, dropped; the shell shows its sidebar.
        #expect(ShellPose.splitStrays(pose: .split(sidebar: .overlay), splitShows: false, shows: true))
        #expect(!ShellPose.splitStrays(pose: .split(sidebar: .overlay), splitShows: true, shows: true))
        // A stack has no column to show; a split that wrote nothing has nothing to undo.
        #expect(!ShellPose.splitStrays(pose: .stack(short: false), splitShows: false, shows: true))
        #expect(!ShellPose.splitStrays(pose: .split(sidebar: .tiled), splitShows: nil, shows: true))
    }

    @Test("a held write applies only if the pose holds after it") func aHeldWriteAppliesOnlyIfThePoseHolds() {
        let tiled = ShellPose.split(sidebar: .tiled)
        let t0 = Date(timeIntervalSinceReferenceDate: 1000)
        let write = HeldVisibilityWrite(shown: false, pose: tiled, at: t0)
        #expect(write.due == t0.addingTimeInterval(ShellPose.foldSettle))
        // His press: the pose last changed long before it and holds after it.
        #expect(write.applies(pose: tiled, poseChangedAt: t0.addingTimeInterval(-30)))
        // The fold race: the split writes `.detailOnly` 30 ms before the root sees the stack.
        #expect(!write.applies(pose: .stack(short: false), poseChangedAt: t0.addingTimeInterval(0.03)))
        // Folded and back inside the hold: the pose matches again, but it changed after the write.
        #expect(!write.applies(pose: tiled, poseChangedAt: t0.addingTimeInterval(0.2)))
        // Tiled to overlay (turned) inside the hold.
        #expect(!write.applies(pose: .split(sidebar: .overlay), poseChangedAt: t0.addingTimeInterval(0.1)))
    }
}

@Suite struct SidebarColumnTests {
    @Test("the sidebar asks for 260, never past 320; half open it follows the fold") func theSidebarAsksFor260() {
        #expect(SidebarColumn.of(halfOpen: false, foldX: 475) == SidebarColumn(min: 260, ideal: 260, max: 320))
        #expect(SidebarColumn.of(halfOpen: true, foldX: 475) == SidebarColumn(min: 260, ideal: 475, max: 475))
        #expect(SidebarColumn.of(halfOpen: true, foldX: 200) == SidebarColumn(min: 260, ideal: 260, max: 320))
    }

    @Test("the unfolded Duo's detail as measured: 547 pt beside the 320 pt sidebar iOS keeps and the 84 pt tab rail, the pager; 680 and up, two panes") func theUnfoldedDuoDetail() {
        let detail: CGFloat = 951 - 320 - 84
        #expect(detail == 547)
        #expect(ThreadPose.mode(segments: 2, regularWidth: true, width: detail) == .pager)
        #expect(ThreadPose.mode(segments: 2, regularWidth: true, width: 951 - 84) == .twoPane)
        let columns = ThreadPose.columns(width: 951 - 84, hairline: 1, division: nil)
        #expect(columns.chat >= ThreadPose.minChat)
        #expect(ReadingMeasure.columnFrame(width: detail) == detail)
    }

    // MARK: - a tab built in each Duo pose (iw12: Work's list missing in unfolded-portrait and tabletop)

    /// The Duo's poses as the window reads them (IOS-DESIGN "Work in every pose"), and what each shows of a list.
    static let duoPoses: [(name: String, horizontal: SizeClass, vertical: SizeClass, size: CGSize, pose: ShellPose)] = [
        ("folded", .compact, .regular, CGSize(width: 466, height: 678), .stack(short: false)),
        ("folded-landscape", .compact, .compact, CGSize(width: 678, height: 466), .stack(short: true)),
        ("unfolded", .regular, .regular, CGSize(width: 951, height: 669), .split(sidebar: .tiled)),
        ("half-open", .regular, .regular, CGSize(width: 951, height: 669), .split(sidebar: .tiled)),
        ("unfolded-portrait", .regular, .regular, CGSize(width: 669, height: 951), .split(sidebar: .overlay)),
        ("tabletop", .regular, .regular, CGSize(width: 669, height: 951), .split(sidebar: .overlay)),
    ]

    @Test(arguments: duoPoses.map(\.name))
    func `a tab built in a pose hides no list of its own: its write is the split's, and a stray split is answered back`(_ name: String) throws {
        let p = try #require(Self.duoPoses.first { $0.name == name })
        let pose = ShellPose.of(horizontal: p.horizontal, vertical: p.vertical, size: p.size)
        #expect(pose == p.pose)
        // The tab is built (or picked) long after the pose settled, and its split writes `.detailOnly` as it appears,
        // before it is on screen or within the settle: never his toggle, in any pose.
        #expect(!ShellPose.keepsVisibilityWrite(pose: pose, sincePoseChange: 30, sinceShown: 0))
        #expect(!ShellPose.keepsVisibilityWrite(pose: pose, sincePoseChange: 30, sinceShown: 0.2))
        // The shell still shows the list (his toggle, `shown`), so the binding answers the split's own value for one
        // turn, then the shell's: the change the split needs to draw the list again. A stack has no such column.
        var answer = SplitAnswer()
        let strays = answer.strayed(pose: pose, splitShows: false, shows: true)
        #expect(strays == pose.isSplit)
        #expect(answer.answer(shows: true) == !pose.isSplit)
        answer.settle()
        #expect(answer.answer(shows: true))
        // Once the split has been on screen past the settle, his press in a split is kept, as before.
        #expect(ShellPose.keepsVisibilityWrite(pose: pose, sincePoseChange: 30, sinceShown: ShellPose.foldSettle) == pose.isSplit)
    }

    @Test func `a split that shows what the shell shows is never answered back`() {
        var answer = SplitAnswer()
        let same = answer.strayed(pose: .split(sidebar: .overlay), splitShows: true, shows: true)
        let unknown = answer.strayed(pose: .split(sidebar: .overlay), splitShows: nil, shows: true)
        #expect(!same && !unknown)
        #expect(answer.answer(shows: false) == false)
    }

    // MARK: - his press on the sidebar button right after the tab appears (council 11, Sol 3)

    @Test(arguments: duoPoses.map(\.name))
    func `his press on the sidebar button is his at once, and the startup's stray check never undoes it`(_ name: String) throws {
        let p = try #require(Self.duoPoses.first { $0.name == name })
        let pose = p.pose
        // A tenth of a second after Work appears: the binding's write at that moment is the split's own, the
        // button's press is his, in a split; a stack has no sidebar button.
        #expect(!ShellPose.isHisToggle(.binding, pose: pose, sincePoseChange: 30, sinceShown: 0.1))
        #expect(ShellPose.isHisToggle(.button, pose: pose, sincePoseChange: 30, sinceShown: 0.1) == pose.isSplit)
        #expect(ShellPose.isHisToggle(.button, pose: pose, sincePoseChange: 0.01, sinceShown: 0) == pose.isSplit)
        guard pose.isSplit else { return }
        // The split wrote `.detailOnly` as it was built (dropped), the shell showed the list, and a stray check is
        // waiting. He presses Hide: the binding answers his value, and the check, once the window settles, finds the
        // split agreeing with it, so nothing puts the list back.
        var answer = SplitAnswer()
        answer.pressed()
        let hidden = false
        #expect(answer.answer(shows: hidden) == hidden)
        let undoesHide = answer.strayed(pose: pose, splitShows: hidden, shows: hidden)
        #expect(!undoesHide)
        // He presses Show instead, and the split's own build write (`.detailOnly`) lands after his press: the check
        // answers the split's value for one turn, then his, so the list he asked for comes back.
        var late = SplitAnswer()
        late.pressed()
        let strays = late.strayed(pose: pose, splitShows: false, shows: true)
        #expect(strays)
        #expect(late.answer(shows: true) == false)
        late.settle()
        #expect(late.answer(shows: true))
    }

    // MARK: - where the shell's sidebar button stands (council 12, Opus 2.1)

    @Test(arguments: duoPoses.map(\.name))
    func `the sidebar button stands in one column's bar, on the side the system's toggle used`(_ name: String) throws {
        let pose = try #require(Self.duoPoses.first { $0.name == name }).pose
        let shownSidebar = SidebarButtonPlace.shows(in: .sidebar, pose: pose, sidebarShown: true)
        let shownDetail = SidebarButtonPlace.shows(in: .detail, pose: pose, sidebarShown: true)
        let hiddenSidebar = SidebarButtonPlace.shows(in: .sidebar, pose: pose, sidebarShown: false)
        let hiddenDetail = SidebarButtonPlace.shows(in: .detail, pose: pose, sidebarShown: false)
        // A stack has no sidebar button; a split has it in the sidebar's bar while it shows, the detail's while not
        // (the overlay keeps the detail's too, under the overlay).
        #expect(shownSidebar == pose.isSplit)
        #expect(shownDetail == pose.isOverlay)
        #expect(!hiddenSidebar)
        #expect(hiddenDetail == pose.isSplit)
        #expect(SidebarButtonPlace.edge(of: .sidebar) == .trailing)
        #expect(SidebarButtonPlace.edge(of: .detail) == .leading)
    }
}
