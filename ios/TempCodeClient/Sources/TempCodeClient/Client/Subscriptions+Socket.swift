import TempCodeContract

/// The socket as the subscription set's connection.
struct SocketSubscriptionWire: SubscriptionWire {
    let socket: TempCodeSocket

    func request<M: ContractMethod>(_ method: M.Type, _ params: M.Params) async throws -> M.Output {
        try await socket.request(method, params)
    }

    var isOpen: Bool {
        get async { await socket.isOpen }
    }
}
