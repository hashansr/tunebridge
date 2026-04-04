import SwiftUI

// MARK: - AlbumDetailView
// Full track listing for a single album with hero header.

struct AlbumDetailView: View {

    let album: Album
    @EnvironmentObject private var audio: AudioEngine

    var body: some View {
        ZStack {
            Color.tbBackground.ignoresSafeArea()
            ScrollView {
                VStack(spacing: 0) {
                    hero
                    trackList
                }
            }
        }
        .navigationTitle(album.name)
        .navigationBarTitleDisplayMode(.inline)
        .tbNavigationBar()
    }

    // MARK: - Hero

    private var hero: some View {
        VStack(spacing: 16) {
            ArtworkView(artworkKey: album.artworkKey, size: 200, cornerRadius: 16)
                .shadow(color: Color.black.opacity(0.5), radius: 20)

            VStack(spacing: 4) {
                Text(album.name)
                    .font(.system(size: 22, weight: .bold))
                    .foregroundStyle(Color.tbTextPrimary)
                    .multilineTextAlignment(.center)

                Text(album.artist)
                    .font(.system(size: 16))
                    .foregroundStyle(Color.tbAccent)

                HStack(spacing: 6) {
                    if let year = album.year {
                        Text("\(year)")
                            .font(.system(size: 13))
                            .foregroundStyle(Color.tbTextMuted)
                        Text("·").foregroundStyle(Color.tbTextMuted).font(.system(size: 13))
                    }
                    Text("\(album.tracks.count) tracks")
                        .font(.system(size: 13))
                        .foregroundStyle(Color.tbTextMuted)
                    Text("·").foregroundStyle(Color.tbTextMuted).font(.system(size: 13))
                    Text(album.durationFormatted)
                        .font(.system(size: 13))
                        .foregroundStyle(Color.tbTextMuted)
                }
            }

            TBPrimaryButton("Play Album", icon: "play.fill") {
                audio.playAll(album.tracks)
            }
            .padding(.bottom, 4)
        }
        .padding(.top, 20)
        .padding(.horizontal, 24)
        .padding(.bottom, 16)
    }

    // MARK: - Track list

    private var trackList: some View {
        VStack(spacing: 0) {
            Divider().background(Color.tbDivider)

            ForEach(Array(album.tracks.enumerated()), id: \.element.id) { idx, track in
                TrackRow(
                    track: track,
                    index: track.trackNumber ?? (idx + 1),
                    isPlaying: audio.currentTrack?.id == track.id
                ) {
                    audio.playAll(album.tracks, startingAt: idx)
                }
                .padding(.horizontal, 16)

                if idx < album.tracks.count - 1 {
                    Divider()
                        .background(Color.tbDivider)
                        .padding(.leading, 56)
                }
            }
        }
        .padding(.bottom, 120)
    }
}
