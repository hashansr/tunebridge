import SwiftUI

// MARK: - LibraryView
// Root of the Library tab. Shows all artists with artwork, A–Z index.

struct LibraryView: View {

    @EnvironmentObject private var library: LibraryManager
    @EnvironmentObject private var appState: AppState

    @State private var searchText = ""

    private var filteredArtists: [Artist] {
        guard !searchText.isEmpty else { return library.artists }
        return library.artists.filter {
            $0.name.localizedCaseInsensitiveContains(searchText)
        }
    }

    var body: some View {
        ZStack {
            Color.tbBackground.ignoresSafeArea()

            if !library.isLoaded {
                loadingView
            } else if library.artists.isEmpty {
                TBEmptyState(
                    icon: "music.note.list",
                    title: "No music yet",
                    message: "Sync your library from TuneBridge on your Mac to get started.",
                    action: ("Go to Sync", { appState.selectedTab = .sync })
                )
            } else {
                artistList
            }
        }
        .navigationTitle("Library")
        .searchable(text: $searchText, prompt: "Artists, albums…")
        .tbNavigationBar()
    }

    // MARK: - Artist list

    private var artistList: some View {
        List {
            // Stats header
            if searchText.isEmpty {
                statsRow
                    .listRowBackground(Color.tbBackground)
                    .listRowSeparator(.hidden)
            }

            ForEach(filteredArtists) { artist in
                NavigationLink(value: artist) {
                    ArtistRow(artist: artist)
                }
                .listRowBackground(Color.tbBackground)
                .listRowSeparatorTint(Color.tbDivider)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
    }

    private var statsRow: some View {
        HStack(spacing: 16) {
            statPill(
                value: "\(library.artists.count)",
                label: library.artists.count == 1 ? "Artist" : "Artists"
            )
            statPill(
                value: "\(library.trackCount)",
                label: library.trackCount == 1 ? "Track" : "Tracks"
            )
            if let date = library.lastSyncDate {
                Spacer()
                Text("Synced \(date, style: .relative) ago")
                    .font(.system(size: 11))
                    .foregroundStyle(Color.tbTextMuted)
            }
        }
        .padding(.vertical, 4)
    }

    private func statPill(value: String, label: String) -> some View {
        HStack(spacing: 4) {
            Text(value)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color.tbAccent)
            Text(label)
                .font(.system(size: 13))
                .foregroundStyle(Color.tbTextMuted)
        }
    }

    private var loadingView: some View {
        VStack(spacing: 16) {
            ProgressView()
                .tint(Color.tbAccent)
                .scaleEffect(1.4)
            Text("Loading library…")
                .font(.system(size: 14))
                .foregroundStyle(Color.tbTextMuted)
        }
    }
}

// MARK: - Artist Row

private struct ArtistRow: View {
    let artist: Artist

    var body: some View {
        HStack(spacing: 14) {
            ArtworkView(artworkKey: artist.artworkKey, size: 52, cornerRadius: 26) // circular
            VStack(alignment: .leading, spacing: 3) {
                Text(artist.name)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Color.tbTextPrimary)
                Text("\(artist.albums.count) \(artist.albums.count == 1 ? "album" : "albums") · \(artist.trackCount) tracks")
                    .font(.system(size: 13))
                    .foregroundStyle(Color.tbTextSecondary)
            }
        }
        .padding(.vertical, 4)
    }
}
