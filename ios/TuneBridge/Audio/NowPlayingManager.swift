import MediaPlayer
import UIKit

// MARK: - NowPlayingManager
// Keeps the lock screen / Control Centre now-playing info current and wires up
// MPRemoteCommandCenter so hardware controls (AirPods, headphones, CarPlay) work.

final class NowPlayingManager {

    // Callbacks set by AudioEngine
    var onTogglePlay: (() -> Void)?
    var onNext: (() -> Void)?
    var onPrevious: (() -> Void)?
    var onSeek: ((Double) -> Void)?

    private let infoCenter = MPNowPlayingInfoCenter.default()
    private let commandCenter = MPRemoteCommandCenter.shared()

    init() {
        registerCommands()
    }

    // MARK: - Update now-playing metadata

    func update(track: Track, duration: Double) {
        var info: [String: Any] = [
            MPMediaItemPropertyTitle:                track.title,
            MPMediaItemPropertyArtist:               track.artist,
            MPMediaItemPropertyAlbumTitle:           track.album,
            MPMediaItemPropertyPlaybackDuration:     duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: 0.0,
            MPNowPlayingInfoPropertyPlaybackRate:    1.0,
            MPNowPlayingInfoPropertyMediaType:       MPNowPlayingInfoMediaType.audio.rawValue,
        ]

        if let year = track.year {
            info[MPMediaItemPropertyAlbumTrackNumber] = track.trackNumber ?? 0
            info[MPMediaItemPropertyYear] = year
        }

        // Load artwork asynchronously to avoid blocking
        Task {
            if let artworkKey = track.artworkKey,
               let image = await LibraryManager.shared.loadArtwork(key: artworkKey) {
                let artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                var updated = self.infoCenter.nowPlayingInfo ?? info
                updated[MPMediaItemPropertyArtwork] = artwork
                self.infoCenter.nowPlayingInfo = updated
            }
        }

        infoCenter.nowPlayingInfo = info
        infoCenter.playbackState = .playing
    }

    func updatePlaybackState(isPlaying: Bool, currentTime: Double) {
        var info = infoCenter.nowPlayingInfo ?? [:]
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = currentTime
        info[MPNowPlayingInfoPropertyPlaybackRate] = isPlaying ? 1.0 : 0.0
        infoCenter.nowPlayingInfo = info
        infoCenter.playbackState = isPlaying ? .playing : .paused
    }

    func updateElapsedTime(_ time: Double) {
        infoCenter.nowPlayingInfo?[MPNowPlayingInfoPropertyElapsedPlaybackTime] = time
    }

    func clearNowPlaying() {
        infoCenter.nowPlayingInfo = nil
        infoCenter.playbackState = .stopped
    }

    // MARK: - Remote commands

    private func registerCommands() {
        commandCenter.playCommand.addTarget { [weak self] _ in
            self?.onTogglePlay?(); return .success
        }
        commandCenter.pauseCommand.addTarget { [weak self] _ in
            self?.onTogglePlay?(); return .success
        }
        commandCenter.togglePlayPauseCommand.addTarget { [weak self] _ in
            self?.onTogglePlay?(); return .success
        }
        commandCenter.nextTrackCommand.addTarget { [weak self] _ in
            self?.onNext?(); return .success
        }
        commandCenter.previousTrackCommand.addTarget { [weak self] _ in
            self?.onPrevious?(); return .success
        }
        commandCenter.changePlaybackPositionCommand.addTarget { [weak self] event in
            if let e = event as? MPChangePlaybackPositionCommandEvent {
                self?.onSeek?(e.positionTime)
            }
            return .success
        }
    }
}
