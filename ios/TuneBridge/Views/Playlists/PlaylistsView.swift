import SwiftUI

// MARK: - PlaylistsView

struct PlaylistsView: View {

    @EnvironmentObject private var library: LibraryManager
    @EnvironmentObject private var appState: AppState
    @State private var searchText = ""

    private var filtered: [Playlist] {
        guard !searchText.isEmpty else { return library.playlists }
        return library.playlists.filter { $0.name.localizedCaseInsensitiveContains(searchText) }
    }

    var body: some View {
        ZStack {
            Color.tbBackground.ignoresSafeArea()

            if library.playlists.isEmpty {
                TBEmptyState(
                    icon: "music.note.tv",
                    title: "No playlists yet",
                    message: "Create playlists in TuneBridge on your Mac and sync them here.",
                    action: ("Go to Sync", { appState.selectedTab = .sync })
                )
            } else {
                playlistGrid
            }
        }
        .navigationTitle("Playlists")
        .searchable(text: $searchText, prompt: "Search playlists…")
        .tbNavigationBar()
    }

    private var playlistGrid: some View {
        let columns = [GridItem(.flexible()), GridItem(.flexible())]

        return ScrollView {
            LazyVGrid(columns: columns, spacing: 16) {
                ForEach(filtered) { playlist in
                    NavigationLink(value: playlist) {
                        PlaylistCard(playlist: playlist)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(16)
            .padding(.bottom, 120)
        }
    }
}

// MARK: - Playlist Card

private struct PlaylistCard: View {
    let playlist: Playlist

    private var artworkKeys: [String] {
        Array(Set(playlist.resolvedTracks.compactMap { $0.artworkKey })).prefix(4).map { $0 }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Mosaic or single artwork
            mosaicCover
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.06), lineWidth: 1)
                )

            VStack(alignment: .leading, spacing: 3) {
                Text(playlist.name)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color.tbTextPrimary)
                    .lineLimit(2)

                Text("\(playlist.trackCount) \(playlist.trackCount == 1 ? "track" : "tracks")")
                    .font(.system(size: 12))
                    .foregroundStyle(Color.tbTextMuted)
            }
        }
    }

    @ViewBuilder
    private var mosaicCover: some View {
        let size = (UIScreen.main.bounds.width - 48) / 2

        if artworkKeys.count >= 4 {
            let half = size / 2
            LazyVGrid(columns: [GridItem(.fixed(half)), GridItem(.fixed(half))], spacing: 0) {
                ForEach(artworkKeys.prefix(4), id: \.self) { key in
                    ArtworkView(artworkKey: key, size: half, cornerRadius: 0)
                }
            }
            .frame(width: size, height: size)
        } else {
            ArtworkView(artworkKey: artworkKeys.first, size: size, cornerRadius: 12)
        }
    }
}
