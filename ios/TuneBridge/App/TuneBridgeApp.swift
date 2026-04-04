import SwiftUI

@main
struct TuneBridgeApp: App {

    @StateObject private var appState     = AppState()
    @StateObject private var audioEngine  = AudioEngine()
    @StateObject private var libraryMgr   = LibraryManager.shared
    @StateObject private var syncManager  = SyncManager.shared

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(appState)
                .environmentObject(audioEngine)
                .environmentObject(libraryMgr)
                .environmentObject(syncManager)
                .preferredColorScheme(.dark)
                .task {
                    // Load library on launch
                    await libraryMgr.load()
                    // Start sync server so Mac can push files whenever on same WiFi
                    syncManager.startListening()
                }
        }
    }
}
