import SwiftUI
import TempCodeClient
import TempCodeContract

#if DEBUG
/// The Files proof's walk (`TC_TEST_FILES`), and its actions on the folder it ends in (`TC_TEST_ACTION`):
/// `files-folder:<name>`, `files-document:<name>`, `files-upload` (a picture the app draws), each through the
/// calls the sheet's presses make. Debug builds only.
@MainActor
enum FilesProof {
    static func walk(client: EnvironmentClient, workspace: WorkspaceMeta, navigator: ShellNavigator) async {
        guard let path = TestHooks.files, TestHooks.once("files-walk") else { return }
        let files = client.work.files
        let names = path.split(separator: "/").map(String.init)
        guard let first = names.first, let places = await settled({ files.places[workspace.id]?.value }) else { return }
        let sections = FilesRules.sections(places)
        guard let place = (sections.lenses + sections.places + sections.mail).first(where: { $0.name == first || ($0.kind == .mail && first == "From Mail") }) else { return }
        var at = place.root
        var homeId = place.id
        navigator.detailStack.append(FilesFolderRoute(environmentId: client.environment.id, workspaceId: workspace.id, placeId: place.id, at: at, title: place.name))
        for name in names.dropFirst() {
            await files.list(workspace.id, at)
            guard let entry = files.listing(workspace.id, at)?.value?.entries.first(where: { $0.name == name }) else { return }
            homeId = entry.where?.place ?? homeId
            if let folder = entry.folder {
                at = folder
                navigator.detailStack.append(FilesFolderRoute(environmentId: client.environment.id, workspaceId: workspace.id, placeId: homeId, at: folder, title: name))
            } else {
                navigator.detailStack.append(FileOpenRoute(environmentId: client.environment.id, workspaceId: workspace.id, placeId: homeId, entry: entry))
                return
            }
        }
        await act(files, workspaceId: workspace.id, at: at)
    }

    private static func act(_ files: FilesHost, workspaceId: String, at: FolderRef) async {
        guard let action = TestHooks.action, TestHooks.once("files-action") else { return }
        if action.hasPrefix("files-folder:") {
            _ = try? await files.make(workspaceId, in: at, kind: .folder, name: String(action.dropFirst("files-folder:".count)))
        } else if action.hasPrefix("files-document:") {
            _ = try? await files.make(workspaceId, in: at, kind: .document, name: String(action.dropFirst("files-document:".count)))
        } else if action == "files-upload", let png = picture() {
            try? await files.upload(workspaceId, into: at, .data(png, name: "Proof picture.png"))
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
