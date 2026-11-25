import SwiftUI
import TempCodeClient
import TempCodeContract

#if DEBUG
/// The Files proof's walk (`TC_TEST_FILES`), and its actions on the folder it ends in (`TC_TEST_ACTION`):
/// `files-folder:<name>`, `files-document:<name>`, `files-upload` (a picture the app draws), `files-list` (rows again), `files-grid` (the
/// folder as icons), each through the
/// calls the sheet's presses make. Debug builds only.
@MainActor
enum FilesProof {
    /// Walks the first job shown by names: a place's name first ("@folder" the workspace's own folder, "From Mail"
    /// the mail lens), each folder opened as `Route.folder` in the sidebar column, a last file as `Route.filesFile`.
    static func walk(jobs: [FilesRoot.Job], registry: ClientRegistry, navigator: ShellNavigator) async {
        guard let path = TestHooks.files, let job = jobs.first, let client = registry.client(job.environmentId), TestHooks.once("files-walk") else { return }
        let files = client.work.files
        let workspaceId = job.workspaceId
        let names = path.split(separator: "/").map(String.init)
        guard let first = names.first, let places = await settled({ files.places[workspaceId]?.value }) else { return }
        let sections = FilesRules.sections(places)
        guard let place = first == "@folder" ? FilesRules.workspaceFolder(places) : (sections.lenses + sections.places + sections.mail + places.filter { $0.kind == .trash }).first(where: { $0.name == first || ($0.kind == .mail && first == "From Mail") }) else { return }
        var at = place.root
        var homeId = place.id
        let env = client.environment.id
        navigator.open(.folder(environmentId: env, workspaceId: workspaceId, placeId: place.id, at: at, title: place.kind == .mail ? "From Mail" : place.name))
        for name in names.dropFirst() {
            await files.list(workspaceId, at)
            guard let entry = files.listing(workspaceId, at)?.value?.entries.first(where: { $0.name == name }) else { return }
            homeId = entry.where?.place ?? homeId
            if let folder = entry.folder {
                at = folder
                navigator.open(.folder(environmentId: env, workspaceId: workspaceId, placeId: homeId, at: folder, title: name))
            } else {
                navigator.open(.filesFile(environmentId: env, workspaceId: workspaceId, placeId: homeId, entry: entry))
                return
            }
        }
        await act(files, workspaceId: workspaceId, at: at)
    }

    private static func act(_ files: FilesHost, workspaceId: String, at: FolderRef) async {
        guard let action = TestHooks.action, TestHooks.once("files-action") else { return }
        if action.hasPrefix("files-folder:") {
            _ = try? await files.make(workspaceId, in: at, kind: .folder, name: String(action.dropFirst("files-folder:".count)))
        } else if action.hasPrefix("files-document:") {
            _ = try? await files.make(workspaceId, in: at, kind: .document, name: String(action.dropFirst("files-document:".count)))
        } else if action == "files-upload", let png = picture() {
            try? await files.upload(workspaceId, into: at, .data(png, name: "Proof picture.png"))
        } else if action == "files-grid" {
            UserDefaults.standard.set(true, forKey: "files.grid")
        } else if action == "files-list" {
            // The folder as rows again, set in the app itself: a `defaults write` from outside can lose to the app's
            // own write of the grid when it was still running.
            UserDefaults.standard.set(false, forKey: "files.grid")
        }
    }

    /// A 600 × 400 picture in the app's own blue, as PNG bytes.
    private static func picture() -> Data? {
        UIGraphicsImageRenderer(size: CGSize(width: 600, height: 400)).image { context in
            UIColor.systemBlue.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 600, height: 400))
        }.pngData()
    }

    private static func settled<T>(_ read: () -> T?) async -> T? {
        for _ in 0 ..< 100 {
            if let value = read() { return value }
            try? await Task.sleep(for: .milliseconds(100))
        }
        return nil
    }
}
#endif
