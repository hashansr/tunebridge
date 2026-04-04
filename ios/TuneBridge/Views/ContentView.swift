import SwiftUI

// MARK: - ContentView
// Root view. Four-tab shell with a persistent MiniPlayer above the tab bar.

struct ContentView: View {

    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var audio: AudioEngine

    var body: some View {
        ZStack(alignment: .bottom) {
            TabView(selection: $appState.selectedTab) {
                LibraryTab()
                    .tabItem { Label("Library", systemImage: "music.note.list") }
                    .tag(AppState.Tab.library)

                PlaylistsTab()
                    .tabItem { Label("Playlists", systemImage: "music.note.tv") }
                    .tag(AppState.Tab.playlists)

                SyncView()
                    .tabItem { Label("Sync", systemImage: "arrow.triangle.2.circlepath") }
                    .tag(AppState.Tab.sync)

                SettingsView()
                    .tabItem { Label("Settings", systemImage: "gearshape") }
                    .tag(AppState.Tab.settings)
            }
            .tint(Color.tbAccent)

            // Mini player — sits above the tab bar, hidden when nothing is loaded
            if audio.currentTrack != nil {
                VStack(spacing: 0) {
                    MiniPlayerView()
                        .padding(.horizontal, 8)
                        .padding(.bottom, 2)
                    // Spacer that matches the tab bar height so content isn't hidden
                    Color.clear.frame(height: 49)
                }
            }
        }
        .background(Color.tbBackground)
        // Full-screen Now Playing sheet
        .sheet(isPresented: $appState.isNowPlayingPresented) {
            NowPlayingSheet()
                .environmentObject(appState)
                .environmentObject(audio)
        }
    }
}

// MARK: - Library Tab wrapper (NavigationStack)

private struct LibraryTab: View {
    @EnvironmentObject private var appState: AppState

    var body: some View {
        NavigationStack(path: $appState.libraryPath) {
            LibraryView()
                .navigationDestination(for: Artist.self) { ArtistDetailView(artist: $0) }
                .navigationDestination(for: Album.self)  { AlbumDetailView(album: $0) }
        }
        .tbNavigationBar()
    }
}

// MARK: - Playlists Tab wrapper (NavigationStack)

private struct PlaylistsTab: View {
    @EnvironmentObject private var appState: AppState

    var body: some View {
        NavigationStack(path: $appState.playlistsPath) {
            PlaylistsView()
                .navigationDestination(for: Playlist.self) { PlaylistDetailView(playlist: $0) }
        }
        .tbNavigationBar()
    }
}
