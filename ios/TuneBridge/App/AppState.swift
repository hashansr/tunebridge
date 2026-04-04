import SwiftUI

// MARK: - AppState
// Global UI state that doesn't belong to any specific feature module.
// Injected as @EnvironmentObject from TuneBridgeApp.

@MainActor
final class AppState: ObservableObject {

    // MARK: Tab selection
    enum Tab: Int, Hashable {
        case library, playlists, sync, settings
    }
    @Published var selectedTab: Tab = .library

    // MARK: Now Playing sheet
    @Published var isNowPlayingPresented = false

    // MARK: Navigation paths (one per tab for deep link support)
    @Published var libraryPath   = NavigationPath()
    @Published var playlistsPath = NavigationPath()

    // MARK: Search
    @Published var librarySearchText  = ""
    @Published var playlistSearchText = ""

    // MARK: Onboarding
    @Published var hasCompletedOnboarding: Bool = {
        UserDefaults.standard.bool(forKey: "tb_onboarding_done")
    }()

    func completeOnboarding() {
        hasCompletedOnboarding = true
        UserDefaults.standard.set(true, forKey: "tb_onboarding_done")
    }
}
