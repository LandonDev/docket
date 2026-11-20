import ComputerProtocol
import Foundation

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// The service's end of the bytes pipe (docs/computer-protocol.md §30): the host's fourth stdio entry, a
/// socket pair, file descriptor 3. Records go out whole, in the order given, on a writer of their own, so
/// a host slow to read holds up neither the capture nor the JSON writer; acks come in on a reader thread
/// of their own. A write that fails, the host closing its end, or a record that cannot be placed loses the
/// pipe for good: `onLost` is called once and every later write is dropped.
public final class VideoPipe: @unchecked Sendable {
    public let fd: Int32
    private let writer = DispatchQueue(label: "tc-computer.video.write")
    private let lock = NSLock()
    private var lost = false
    private var queued = 0
    private var onRecord: @Sendable (VideoRecord) -> Void = { _ in }
    private var onLost: @Sendable (String) -> Void = { _ in }

    public init(fd: Int32) {
        self.fd = fd
        #if canImport(Darwin)
        // a write after the host is gone fails with EPIPE rather than a signal, in a test runner too
        var on: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        #endif
    }

    /// Descriptor 3 when the host opened it as a socket or a pipe; nil when the service has no video.
    public static func inherited(fd: Int32 = Int32(ComputerDefaults.VideoStream.pipeFd)) -> VideoPipe? {
        isSocketOrPipe(fd) ? VideoPipe(fd: fd) : nil
    }

    public static func isSocketOrPipe(_ fd: Int32) -> Bool {
        guard fcntl(fd, F_GETFD) != -1 else { return false }
        var info = stat()
        guard fstat(fd, &info) == 0 else { return false }
        let kind = info.st_mode & S_IFMT
        return kind == S_IFSOCK || kind == S_IFIFO
    }

    /// Starts the reader thread; `onRecord` hears each record in order on it.
    public func start(onRecord: @escaping @Sendable (VideoRecord) -> Void, onLost: @escaping @Sendable (String) -> Void) {
        lock.locked {
            self.onRecord = onRecord
            self.onLost = onLost
        }
        let thread = Thread { [self] in readLoop() }
        thread.name = "tc-computer.video.read"
        thread.start()
    }

    public var isLost: Bool { lock.locked { lost } }

    /// Bytes handed to the writer and not yet written.
    public var backlog: Int { lock.locked { queued } }

    /// Writes one record whole after every record given before it.
    public func write(_ record: Data) {
        let open = lock.locked { () -> Bool in
            guard !lost else { return false }
            queued += record.count
            return true
        }
        guard open else { return }
        writer.async { [self] in
            defer { lock.locked { queued -= record.count } }
            guard !isLost else { return }
            do {
                try FileDescriptorSink(fd: fd).write(record)
            } catch {
                lose("a write to the bytes pipe failed: \(error)")
            }
        }
    }

    private func readLoop() {
        var reader = VideoRecordReader()
        var buffer = [UInt8](repeating: 0, count: 64 * 1_024)
        while !isLost {
            let count = read(fd, &buffer, buffer.count)
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else {
                lose(count == 0 ? "the host closed the bytes pipe" : "a read of the bytes pipe failed (errno \(errno))")
                return
            }
            let records: [VideoRecord]
            do {
                records = try reader.push(Data(buffer[0..<count]))
            } catch {
                lose("\(error)")
                return
            }
            let deliver = lock.locked { onRecord }
            for record in records { deliver(record) }
        }
    }

    private func lose(_ why: String) {
        let tell = lock.locked { () -> (@Sendable (String) -> Void)? in
            guard !lost else { return nil }
            lost = true
            return onLost
        }
        tell?(why)
    }
}
