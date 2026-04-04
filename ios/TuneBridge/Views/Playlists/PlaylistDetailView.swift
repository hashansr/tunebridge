import SwiftUI

// MARK: - PlaylistDetailView

struct PlaylistDetailView: View {

    let playlist: Playlist
    @EnvironmentObject private var audio: AudioEngine
    @State private var searchText = ""

    private var tracks: [Track] { playlist.resolvedTracks }

    private var filteredTracks: [Track] {
        guard !searchText.isEmpty else { return tracks }
        return tracks.filter {
            $0.title.localizedCaseInsensitiveContains(searchText) ||
            $0.artist.localizedCaseInsensitiveContains(searchText) ||
            $0.album.localizedCaseInsensitiveContains(searchText)
        }
    }

    var body: some View {
        ZStack {
            Color.tbBackground.ignoresSafeArea()
            ScrollView {
                VStack(spacing: 0) {
                    hero
                    if tracks.isEmpty {
                        TBEmptyState(
                            icon: "music.note",
                            title: "No tracks available",
                            message: "Some tracks in this playlist may not be synced to this device."
                        )
                        .padding(.top, 20)
                    } else {
                        trackList
                    }
                }
            }
        }
        .navigationTitle(playlist.name)
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $searchText, prompt: "Filter tracks…")
        .tbNavigationBar()
    }

    // MARK: - Hero

    private var hero: some View {
        HStack(spacing: 20) {
            // Artwork
            ArtworkView(
                artworkKey: tracks.first?.artworkKey,
                size: 100,
                cornerRadius: 14
            )
            .shadow(color: Color.black.opacity(0.4), radius: 12)

            VStack(alignment: .leading, spacing: 6) {
                Text(playlist.name)
                    .font(.system(size: 20, weight: .bold))
                    .foregroundStyle(Color.tbTextPrimary)
                    .lineLimit(2)

                Text("\(tracks.count) tracks · \(playlist.durationFormatted)")
                    .font(.system(size: 13))
                    .foregroundStyle(Color.tbTextSecondary)

                Spacer()

                HStack(spacing: 10) {
                    TBPrimaryButton("Play", icon: "play.fill") {
                        audio.playAll(tracks)
                    }

                    TBSecondaryButton("Shuffle", icon: "shuffle") {
                        audio.shuffleEnabled = true
                        let shuffled = tracks.shuffled()
                        audio.playAll(shuffled)
                    }
                }
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 20)
    }

    // MARK: - Track list

    private var trackList: some View {
        VStack(spacing: 0) {
            Divider().background(Color.tbDivider).padding(.horizontal, 16)

            ForEach(Array(filteredTracks.enumerated()), id: \.element.id) { idx, track in
                let globalIdx = tracks.firstIndex(where: { $0.id == track.id }) ?? idx

                TrackRow(
                    track: track,
                    index: idx + 1,
                    isPlaying: audio.currentTrack?.id == track.id
                ) {
                    audio.playAll(tracks, startingAt: globalIdx)
                }
                .padding(.horizontal, 16)

                if idx < filteredTracks.count - 1 {
                    Divider()
                        .background(Color.tbDivider)
                        .padding(.leading, 56)
                }
            }
        }
        .padding(.bottom, 120)
    }
}
