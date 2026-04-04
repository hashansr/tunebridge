import Foundation

// MARK: - Track

struct Track: Identifiable, Codable, Hashable {
    let id: String          // MD5 of relativePath — matches desktop TuneBridge IDs
    var title: String
    var artist: String
    var albumArtist: String
    var album: String
    var year: Int?
    var genre: String?
    var trackNumber: Int?
    var discNumber: Int?
    var duration: Double    // seconds
    var relativePath: String // relative to music root, e.g. "Artist/Album/01 Track.flac"
    var format: String      // "FLAC", "MP3", etc.
    var sampleRate: Int?
    var bitDepth: Int?
    var bitrate: Int?       // kbps
    var artworkKey: String? // MD5(artist+album) — matches desktop artwork cache key

    // Computed
    var durationFormatted: String {
        let mins = Int(duration) / 60
        let secs = Int(duration) % 60
        return String(format: "%d:%02d", mins, secs)
    }

    var isLossless: Bool {
        ["FLAC", "ALAC", "WAV", "AIFF"].contains(format.uppercased())
    }

    var qualityLabel: String {
        if let bd = bitDepth, let sr = sampleRate {
            let khz = sr / 1000
            return "\(bd)-bit · \(khz) kHz · \(format)"
        }
        if let kbps = bitrate {
            return "\(kbps) kbps · \(format)"
        }
        return format
    }
}

// MARK: - Artist

struct Artist: Identifiable, Hashable {
    var id: String { name }
    let name: String
    var albums: [Album]
    var artworkKey: String?

    var trackCount: Int { albums.reduce(0) { $0 + $1.tracks.count } }
}

// MARK: - Album

struct Album: Identifiable, Hashable {
    var id: String { "\(artist)/\(name)" }
    let name: String
    let artist: String      // album artist (for sorting/grouping)
    var tracks: [Track]
    var year: Int?
    var artworkKey: String?

    var duration: Double { tracks.reduce(0) { $0 + $1.duration } }

    var durationFormatted: String {
        let total = Int(duration)
        let hrs = total / 3600
        let mins = (total % 3600) / 60
        if hrs > 0 { return "\(hrs) hr \(mins) min" }
        return "\(mins) min"
    }
}

// MARK: - Library Snapshot
// Mirrors the structure of desktop TuneBridge's library.json for easy delta sync.

struct LibrarySnapshot: Codable {
    var tracks: [Track]
    var scannedAt: Double   // unix timestamp
    var version: Int = 1
}
