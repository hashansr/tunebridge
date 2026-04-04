import Foundation
import Network

// MARK: - Sync Protocol
//
// The Mac-side TuneBridge discovers the iOS app via Bonjour (_tunebridge._tcp)
// and pushes files over a simple HTTP-like protocol on port 7891.
//
// Protocol:
//   POST /sync/file
//     Headers:
//       X-TB-Path:        relative path under music root  (e.g. "Artist/Album/01 Track.flac")
//       X-TB-Type:        "music" | "playlist" | "artwork" | "peq" | "library" | "iems"
//       Content-Length:   byte count of body
//     Body: raw file bytes
//
//   GET /sync/status
//     Response: JSON { version, trackCount, lastSyncAt, files: [{path, size, mtime}] }
//     Used by Mac to compute delta (only push files that changed or are missing).
//
//   POST /sync/done
//     Signals the iOS app to reload its library after a batch transfer.

// MARK: - Sync Progress

struct SyncProgress {
    var totalFiles: Int = 0
    var completedFiles: Int = 0
    var currentFile: String = ""
    var bytesReceived: Int64 = 0
    var totalBytes: Int64 = 0
    var errors: [String] = []

    var percentComplete: Double {
        guard totalFiles > 0 else { return 0 }
        return Double(completedFiles) / Double(totalFiles)
    }
}

// MARK: - Sync Server

@MainActor
final class SyncServer: ObservableObject {

    static let shared = SyncServer()

    @Published var isRunning = false
    @Published var progress = SyncProgress()
    @Published var lastError: String?

    private var listener: NWListener?
    private let port: NWEndpoint.Port = 7891
    private let serviceType = "_tunebridge._tcp"
    private var activeConnections: [NWConnection] = []

    private init() {}

    // MARK: - Lifecycle

    func start() throws {
        guard !isRunning else { return }

        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true

        listener = try NWListener(using: params, on: port)

        // Advertise via Bonjour so TuneBridge on Mac can discover us
        listener?.service = NWListener.Service(type: serviceType)

        listener?.stateUpdateHandler = { [weak self] state in
            DispatchQueue.main.async {
                switch state {
                case .ready:   self?.isRunning = true
                case .failed:  self?.isRunning = false
                case .cancelled: self?.isRunning = false
                default: break
                }
            }
        }

        listener?.newConnectionHandler = { [weak self] connection in
            self?.handleConnection(connection)
        }

        listener?.start(queue: .global(qos: .userInitiated))
    }

    func stop() {
        listener?.cancel()
        activeConnections.forEach { $0.cancel() }
        activeConnections = []
        isRunning = false
    }

    // MARK: - Connection handling

    private func handleConnection(_ connection: NWConnection) {
        connection.start(queue: .global(qos: .userInitiated))
        activeConnections.append(connection)
        receiveRequest(connection)
    }

    private func receiveRequest(_ connection: NWConnection) {
        // Read up to 64KB for headers; large bodies are streamed
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self else { return }

            if let error = error {
                print("[SyncServer] Connection error: \(error)")
                connection.cancel()
                return
            }

            guard let data = data, !data.isEmpty else {
                if isComplete { connection.cancel() }
                return
            }

            self.parseAndDispatch(data: data, connection: connection)
        }
    }

    private func parseAndDispatch(data: Data, connection: NWConnection) {
        guard let headerSection = String(data: data, encoding: .utf8) else {
            sendResponse(connection, status: 400, body: "Bad Request")
            return
        }

        let lines = headerSection.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else {
            sendResponse(connection, status: 400, body: "Bad Request")
            return
        }

        let parts = requestLine.components(separatedBy: " ")
        guard parts.count >= 2 else {
            sendResponse(connection, status: 400, body: "Bad Request")
            return
        }

        let method = parts[0]
        let path   = parts[1]

        // Parse headers
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colonIdx = line.firstIndex(of: ":") else { continue }
            let key   = String(line[line.startIndex..<colonIdx]).trimmingCharacters(in: .whitespaces)
            let value = String(line[line.index(after: colonIdx)...]).trimmingCharacters(in: .whitespaces)
            headers[key] = value
        }

        // Find body start (after \r\n\r\n)
        let headerDelimiter = "\r\n\r\n".data(using: .utf8)!
        var bodyData = Data()
        if let range = data.range(of: headerDelimiter) {
            bodyData = data[range.upperBound...]
        }

        switch (method, path) {
        case ("GET", "/sync/status"):
            handleStatusRequest(connection)
        case ("POST", "/sync/file"):
            handleFileUpload(headers: headers, body: bodyData, connection: connection)
        case ("POST", "/sync/done"):
            handleSyncDone(connection)
        default:
            sendResponse(connection, status: 404, body: "Not Found")
        }
    }

    // MARK: - Handlers

    private func handleStatusRequest(_ connection: NWConnection) {
        Task { @MainActor in
            let lib = LibraryManager.shared
            var files: [[String: Any]] = []

            // Return all files currently on device so Mac can compute delta
            let musicRoot = lib.musicRoot
            if let enumerator = FileManager.default.enumerator(
                at: musicRoot,
                includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey],
                options: [.skipsHiddenFiles]
            ) {
                for case let url as URL in enumerator {
                    guard !url.hasDirectoryPath else { continue }
                    let rel = url.path.replacingOccurrences(of: musicRoot.path + "/", with: "")
                    let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
                    let mtime = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)
                                    .flatMap { $0.timeIntervalSince1970 } ?? 0
                    files.append(["path": rel, "size": size, "mtime": mtime])
                }
            }

            let status: [String: Any] = [
                "version": 1,
                "trackCount": lib.trackCount,
                "lastSyncAt": lib.lastSyncDate?.timeIntervalSince1970 ?? 0,
                "files": files
            ]

            if let json = try? JSONSerialization.data(withJSONObject: status) {
                self.sendResponse(connection, status: 200, body: String(data: json, encoding: .utf8) ?? "{}")
            }
        }
    }

    private func handleFileUpload(headers: [String: String], body: Data, connection: NWConnection) {
        guard let relativePath = headers["X-TB-Path"],
              let typeStr = headers["X-TB-Type"] else {
            sendResponse(connection, status: 400, body: "Missing X-TB-Path or X-TB-Type")
            return
        }

        let contentLength = Int(headers["Content-Length"] ?? "0") ?? 0
        let lib = LibraryManager.shared

        Task { @MainActor in
            let destURL: URL
            switch typeStr {
            case "music":
                destURL = lib.musicRoot.appendingPathComponent(relativePath)
            case "playlist":
                destURL = lib.playlistsDir.appendingPathComponent(relativePath)
            case "artwork":
                destURL = lib.artworkDir.appendingPathComponent(relativePath)
            case "peq":
                destURL = lib.peqDir.appendingPathComponent(relativePath)
            case "library":
                destURL = lib.libraryFile
            case "iems":
                destURL = lib.iemsFile
            default:
                self.sendResponse(connection, status: 400, body: "Unknown file type: \(typeStr)")
                return
            }

            // Create parent directory if needed
            try? FileManager.default.createDirectory(
                at: destURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )

            if body.count >= contentLength && contentLength > 0 {
                // Full file arrived in one chunk
                do {
                    try body.prefix(contentLength).write(to: destURL, options: .atomic)
                    self.progress.completedFiles += 1
                    self.progress.currentFile = relativePath
                    self.progress.bytesReceived += Int64(contentLength)
                    self.sendResponse(connection, status: 200, body: "OK")
                } catch {
                    self.sendResponse(connection, status: 500, body: "Write failed: \(error)")
                }
            } else {
                // Stream large file body — receive remaining chunks
                self.receiveFileBody(
                    connection: connection,
                    destination: destURL,
                    initialChunk: body,
                    remaining: contentLength - body.count,
                    relativePath: relativePath
                )
            }
        }
    }

    private func receiveFileBody(
        connection: NWConnection,
        destination: URL,
        initialChunk: Data,
        remaining: Int,
        relativePath: String
    ) {
        // Write in a streaming fashion using a FileHandle
        FileManager.default.createFile(atPath: destination.path, contents: initialChunk)
        guard let handle = try? FileHandle(forWritingTo: destination) else {
            sendResponse(connection, status: 500, body: "Could not open file for writing")
            return
        }
        handle.seekToEndOfFile()

        var bytesLeft = remaining

        func receiveNext() {
            guard bytesLeft > 0 else {
                try? handle.close()
                DispatchQueue.main.async {
                    self.progress.completedFiles += 1
                    self.progress.currentFile = relativePath
                }
                self.sendResponse(connection, status: 200, body: "OK")
                return
            }

            let chunkSize = min(bytesLeft, 65536)
            connection.receive(minimumIncompleteLength: 1, maximumLength: chunkSize) { data, _, _, error in
                if let error = error {
                    print("[SyncServer] Stream error: \(error)")
                    try? handle.close()
                    connection.cancel()
                    return
                }
                if let chunk = data, !chunk.isEmpty {
                    handle.write(chunk)
                    bytesLeft -= chunk.count
                    DispatchQueue.main.async {
                        self.progress.bytesReceived += Int64(chunk.count)
                    }
                }
                receiveNext()
            }
        }

        receiveNext()
    }

    private func handleSyncDone(_ connection: NWConnection) {
        sendResponse(connection, status: 200, body: "OK")
        Task { @MainActor in
            LibraryManager.shared.saveSyncMeta()
            await LibraryManager.shared.load()
            self.progress = SyncProgress()
        }
    }

    // MARK: - Response helpers

    private func sendResponse(_ connection: NWConnection, status: Int, body: String) {
        let statusText = status == 200 ? "OK" : status == 400 ? "Bad Request" : status == 404 ? "Not Found" : "Internal Server Error"
        let bodyData = body.data(using: .utf8) ?? Data()
        let header = "HTTP/1.1 \(status) \(statusText)\r\nContent-Length: \(bodyData.count)\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n"
        var response = header.data(using: .utf8)!
        response.append(bodyData)

        connection.send(content: response, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }
}
