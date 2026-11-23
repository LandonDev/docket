import TempCodeContract

/// The socket as the Files store's connection.
struct SocketFilesWire: FilesWire {
    let socket: TempCodeSocket

    func request<M: ContractMethod>(_ method: M.Type, _ params: M.Params) async throws -> M.Output {
        try await socket.request(method, params)
    }
}
