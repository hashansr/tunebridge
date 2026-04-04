import Foundation

struct Playlist: Identifiable, Codable, Hashable {
    let id: String
    var name: String
    var trackIds: [String]  // ordered list of Track.id
    var createdAt: Double   // unix timestamp
    var updatedAt: Double

    // Populated by LibraryManager when resolving against local library
    var resolvedTracks: [Track] = []

    var trackCount: Int { trackIds.count }
    var duration: Double { resolvedTracks.reduce(0) { $0 + $1.duration } }

    var durationFormatted: String {
        let total = Int(duration)
        let hrs = total / 3600
        let mins = (total % 3600) / 60
        if hrs > 0 { return "\(hrs) hr \(mins) min" }
        return "\(mins) min"
    }

    // CodingKeys exclude resolvedTracks from JSON serialisation
    enum CodingKeys: String, CodingKey {
        case id, name, trackIds, createdAt, updatedAt
    }
}

// MARK: - Playlists store
// Top-level shape of playlists.json — matches desktop format exactly.

struct PlaylistsStore: Codable {
    var playlists: [Playlist]
}
