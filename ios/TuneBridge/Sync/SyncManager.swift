import Foundation
import Network

// MARK: - Sync State

enum SyncState: Equatable {
    case idle
    case waitingForServer   // Bonjour searching
    case receiving          // files arriving
    case reloading          // library reload after transfer
    case done(fileCount: Int)
    case error(String)
}

// MARK: - SyncManager
// Coordinates Bonjour discovery and exposes sync state to the UI.
// The actual file receiving is handled by SyncServer; SyncManager is
// the UI-facing coordinator that starts/stops the server and tracks state.

@MainActor
final class SyncManager: ObservableObject {

    static let shared = SyncManager()

    @Published var state: SyncState = .idle
    @Published var isServerRunning = false
    @Published var discoveredMacName: String?

    private let server = SyncServer.shared
    private var browser: NWBrowser?

    private init() {}

    // MARK: - Start / Stop

    func startListening() {
        guard !isServerRunning else { return }
        do {
            try server.start()
            isServerRunning = true
            state = .waitingForServer
            startBrowsingForMac()
        } catch {
            state = .error("Could not start sync server: \(error.localizedDescription)")
        }
    }

    func stopListening() {
        server.stop()
        browser?.cancel()
        isServerRunning = false
        state = .idle
        discoveredMacName = nil
    }

    // MARK: - Bonjour browsing (discover TuneBridge Mac)
    // TuneBridge on Mac advertises _tunebridge-mac._tcp when the Sync pane is open.
    // This lets the iOS app show "Mac found: MacBook Pro" in the UI as confirmation.

    private func startBrowsingForMac() {
        let descriptor = NWBrowser.Descriptor.bonjourWithTXTRecord(type: "_tunebridge-mac._tcp", domain: "local.")
        browser = NWBrowser(for: descriptor, using: .tcp)

        browser?.browseResultsChangedHandler = { [weak self] results, _ in
            DispatchQueue.main.async {
                if let first = results.first,
                   case let .service(name, _, _, _) = first.endpoint {
                    self?.discoveredMacName = name
                } else {
                    self?.discoveredMacName = nil
                }
            }
        }

        browser?.start(queue: .global(qos: .utility))
    }

    // MARK: - Sync progress forwarding from SyncServer

    var progress: SyncProgress { server.progress }
}
