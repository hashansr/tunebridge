import SwiftUI

// MARK: - MiniPlayerView
// Compact persistent player bar that sits above the tab bar.
// Tapping opens the full NowPlayingSheet.

struct MiniPlayerView: View {

    @EnvironmentObject private var audio: AudioEngine
    @EnvironmentObject private var appState: AppState

    var body: some View {
        HStack(spacing: 12) {
            // Artwork
            ArtworkView(artworkKey: audio.currentTrack?.artworkKey, size: 44, cornerRadius: 8)

            // Track info
            VStack(alignment: .leading, spacing: 2) {
                Text(audio.currentTrack?.title ?? "")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color.tbTextPrimary)
                    .lineLimit(1)

                Text(audio.currentTrack?.artist ?? "")
                    .font(.system(size: 12))
                    .foregroundStyle(Color.tbTextSecondary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            // Controls
            HStack(spacing: 16) {
                Button { audio.togglePlayPause() } label: {
                    Image(systemName: audio.isPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: 20, weight: .medium))
                        .foregroundStyle(Color.tbTextPrimary)
                        .frame(width: 32, height: 32)
                }
                .buttonStyle(.plain)

                Button { audio.skipNext() } label: {
                    Image(systemName: "forward.fill")
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(Color.tbTextSecondary)
                        .frame(width: 32, height: 32)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(
            ZStack {
                Color.tbSurface1
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                // Progress fill as subtle background tint
                GeometryReader { geo in
                    let progress = audio.duration > 0 ? audio.currentTime / audio.duration : 0
                    Color.tbAccent.opacity(0.08)
                        .frame(width: geo.size.width * progress)
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
            }
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Color.white.opacity(0.07), lineWidth: 1)
        )
        .shadow(color: Color.black.opacity(0.4), radius: 12, y: 4)
        .onTapGesture { appState.isNowPlayingPresented = true }
        .contentShape(Rectangle())
    }
}
