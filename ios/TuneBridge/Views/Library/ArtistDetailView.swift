import SwiftUI

// MARK: - ArtistDetailView
// Shows all albums for an artist in a grid, with a hero header.

struct ArtistDetailView: View {

    let artist: Artist

    @EnvironmentObject private var audio: AudioEngine
    @EnvironmentObject private var library: LibraryManager

    private let columns = [GridItem(.flexible()), GridItem(.flexible())]

    var body: some View {
        ZStack {
            Color.tbBackground.ignoresSafeArea()

            ScrollView {
                VStack(spacing: 0) {
                    hero
                    albumGrid
                }
            }
        }
        .navigationTitle(artist.name)
        .navigationBarTitleDisplayMode(.inline)
        .tbNavigationBar()
    }

    // MARK: - Hero

    private var hero: some View {
        VStack(spacing: 16) {
            ArtworkView(artworkKey: artist.artworkKey, size: 110, cornerRadius: 55)
                .shadow(color: Color.black.opacity(0.5), radius: 16)

            VStack(spacing: 6) {
                Text(artist.name)
                    .font(.system(size: 26, weight: .bold))
                    .foregroundStyle(Color.tbTextPrimary)
                    .multilineTextAlignment(.center)

                Text("\(artist.albums.count) albums · \(artist.trackCount) tracks")
                    .font(.system(size: 14))
                    .foregroundStyle(Color.tbTextSecondary)
            }

            // Play All button
            TBPrimaryButton("Play All", icon: "play.fill") {
                let allTracks = artist.albums.flatMap { $0.tracks }
                audio.playAll(allTracks)
            }
            .padding(.bottom, 8)
        }
        .padding(.top, 20)
        .padding(.horizontal, 24)
        .padding(.bottom, 16)
    }

    // MARK: - Album grid

    private var albumGrid: some View {
        LazyVGrid(columns: columns, spacing: 16) {
            ForEach(artist.albums) { album in
                NavigationLink(value: album) {
                    AlbumCard(album: album)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 120) // room for mini player
    }
}

// MARK: - Album Card

struct AlbumCard: View {
    let album: Album
    @EnvironmentObject private var audio: AudioEngine

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ArtworkView(artworkKey: album.artworkKey,
                        size: (UIScreen.main.bounds.width - 48) / 2,
                        cornerRadius: 12)
                .overlay(alignment: .bottomTrailing) {
                    Button {
                        audio.playAll(album.tracks)
                    } label: {
                        Circle()
                            .fill(LinearGradient.tbAccentGradient)
                            .frame(width: 36, height: 36)
                            .overlay(
                                Image(systemName: "play.fill")
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundStyle(Color.tbBackground)
                                    .offset(x: 1)
                            )
                            .shadow(color: Color.black.opacity(0.4), radius: 6)
                    }
                    .buttonStyle(.plain)
                    .padding(8)
                }

            VStack(alignment: .leading, spacing: 2) {
                Text(album.name)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.tbTextPrimary)
                    .lineLimit(2)

                HStack(spacing: 4) {
                    if let year = album.year {
                        Text("\(year)")
                            .font(.system(size: 12))
                            .foregroundStyle(Color.tbTextMuted)
                    }
                    Text("·")
                        .font(.system(size: 12))
                        .foregroundStyle(Color.tbTextMuted)
                    Text("\(album.tracks.count) tracks")
                        .font(.system(size: 12))
                        .foregroundStyle(Color.tbTextMuted)
                }
            }
        }
    }
}
