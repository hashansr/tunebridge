import Foundation
import UIKit

// MARK: - LibraryManager
// Single source of truth for the local music library on-device.
// Reads tracks from the synced library.json, resolves artwork from the
// artwork/ cache directory, and builds the Artist → Album → Track hierarchy.

@MainActor
final class LibraryManager: ObservableObject {

    static let shared = LibraryManager()

    // MARK: Published
    @Published var artists: [Artist] = []
    @Published var playlists: [Playlist] = []
    @Published var peqProfiles: [PEQProfile] = []
    @Published var isLoaded = false
    @Published var trackCount: Int = 0
    @Published var lastSyncDate: Date?

    // MARK: Flat lookup tables
    private var trackIndex: [String: Track] = [:]    // id → Track
    private var artworkCache: [String: UIImage] = [:] // artworkKey → UIImage

    // MARK: File system roots
    // All user data lives under the app's Documents directory.
    private let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!

    var musicRoot: URL    { docs.appendingPathComponent("Music") }
    var playlistsDir: URL { docs.appendingPathComponent("Playlists") }
    var artworkDir: URL   { docs.appendingPathComponent("Artwork") }
    var peqDir: URL       { docs.appendingPathComponent("PEQ") }
    var libraryFile: URL  { docs.appendingPathComponent("library.json") }
    var playlistsFile: URL { docs.appendingPathComponent("playlists.json") }
    var iemsFile: URL     { docs.appendingPathComponent("iems.json") }
    var syncMetaFile: URL { docs.appendingPathComponent("sync_meta.json") }

    private init() {
        createDirectoriesIfNeeded()
    }

    // MARK: - Setup

    private func createDirectoriesIfNeeded() {
        [musicRoot, playlistsDir, artworkDir, peqDir].forEach {
            try? FileManager.default.createDirectory(at: $0, withIntermediateDirectories: true)
        }
    }

    // MARK: - Load

    func load() async {
        async let tracks = loadTracks()
        async let pls    = loadPlaylists()
        async let peqs   = loadPEQProfiles()

        let (t, p, q) = await (tracks, pls, peqs)

        let index = Dictionary(uniqueKeysWithValues: t.map { ($0.id, $0) })
        let resolved = p.map { resolvePlaylist($0, index: index) }

        self.trackIndex   = index
        self.artists      = buildHierarchy(from: t)
        self.playlists    = resolved
        self.peqProfiles  = q
        self.trackCount   = t.count
        self.isLoaded     = true

        if let meta = loadSyncMeta() {
            self.lastSyncDate = Date(timeIntervalSince1970: meta.lastSyncAt)
        }
    }

    // MARK: - Track lookup

    func track(id: String) -> Track? { trackIndex[id] }

    func localURL(for track: Track) -> URL? {
        let url = musicRoot.appendingPathComponent(track.relativePath)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    func isDownloaded(_ track: Track) -> Bool {
        localURL(for: track) != nil
    }

    // MARK: - Artwork

    func loadArtwork(key: String) async -> UIImage? {
        if let cached = artworkCache[key] { return cached }

        let url = artworkDir.appendingPathComponent("\(key).jpg")
        guard FileManager.default.fileExists(atPath: url.path),
              let image = UIImage(contentsOfFile: url.path) else { return nil }

        artworkCache[key] = image
        return image
    }

    // MARK: - Storage stats

    func storageUsedBytes() -> Int64 {
        guard let enumerator = FileManager.default.enumerator(
            at: musicRoot,
            includingPropertiesForKeys: [.fileSizeKey],
            options: [.skipsHiddenFiles]
        ) else { return 0 }

        return enumerator.compactMap { $0 as? URL }
            .compactMap { try? $0.resourceValues(forKeys: [.fileSizeKey]).fileSize }
            .reduce(0) { $0 + Int64($1) }
    }

    // MARK: - Private loading helpers

    private func loadTracks() async -> [Track] {
        guard FileManager.default.fileExists(atPath: libraryFile.path) else { return [] }
        do {
            let data = try Data(contentsOf: libraryFile)
            let snap = try JSONDecoder().decode(LibrarySnapshot.self, from: data)
            return snap.tracks
        } catch {
            print("[LibraryManager] Could not load library.json: \(error)")
            return []
        }
    }

    private func loadPlaylists() async -> [Playlist] {
        guard FileManager.default.fileExists(atPath: playlistsFile.path) else { return [] }
        do {
            let data = try Data(contentsOf: playlistsFile)
            // playlists.json can be either {"playlists":[...]} or [...]
            if let store = try? JSONDecoder().decode(PlaylistsStore.self, from: data) {
                return store.playlists
            }
            return try JSONDecoder().decode([Playlist].self, from: data)
        } catch {
            print("[LibraryManager] Could not load playlists.json: \(error)")
            return []
        }
    }

    private func loadPEQProfiles() async -> [PEQProfile] {
        guard FileManager.default.fileExists(atPath: iemsFile.path) else { return [] }
        do {
            let data = try Data(contentsOf: iemsFile)
            let store = try JSONDecoder().decode(IEMsStore.self, from: data)
            // Flatten all profiles from all IEMs, tagging each with the IEM name
            return store.iems.flatMap { iem in
                iem.peqProfiles.map { profile in
                    var p = profile
                    if p.iemName.isEmpty { p.iemName = iem.name }
                    return p
                }
            }
        } catch {
            print("[LibraryManager] Could not load iems.json: \(error)")
            return []
        }
    }

    private func resolvePlaylist(_ playlist: Playlist, index: [String: Track]) -> Playlist {
        var p = playlist
        p.resolvedTracks = playlist.trackIds.compactMap { index[$0] }
        return p
    }

    private func buildHierarchy(from tracks: [Track]) -> [Artist] {
        // Group by album artist (fall back to artist)
        let byArtist = Dictionary(grouping: tracks) { $0.albumArtist.isEmpty ? $0.artist : $0.albumArtist }

        return byArtist
            .map { artistName, artistTracks -> Artist in
                let byAlbum = Dictionary(grouping: artistTracks) { $0.album }
                let albums = byAlbum
                    .map { albumName, albumTracks -> Album in
                        let sorted = albumTracks.sorted {
                            let d0 = $0.discNumber ?? 1, d1 = $1.discNumber ?? 1
                            if d0 != d1 { return d0 < d1 }
                            return ($0.trackNumber ?? 0) < ($1.trackNumber ?? 0)
                        }
                        return Album(
                            name: albumName,
                            artist: artistName,
                            tracks: sorted,
                            year: sorted.first?.year,
                            artworkKey: sorted.first?.artworkKey
                        )
                    }
                    .sorted { ($0.year ?? 0) > ($1.year ?? 0) }

                return Artist(
                    name: artistName,
                    albums: albums,
                    artworkKey: albums.first?.artworkKey
                )
            }
            .sorted { stripArticle($0.name) < stripArticle($1.name) }
    }

    // MARK: - Sync meta

    struct SyncMeta: Codable { var lastSyncAt: Double }

    func saveSyncMeta() {
        let meta = SyncMeta(lastSyncAt: Date().timeIntervalSince1970)
        if let data = try? JSONEncoder().encode(meta) {
            try? data.write(to: syncMetaFile)
        }
    }

    private func loadSyncMeta() -> SyncMeta? {
        guard let data = try? Data(contentsOf: syncMetaFile) else { return nil }
        return try? JSONDecoder().decode(SyncMeta.self, from: data)
    }

    // MARK: - Helpers

    private func stripArticle(_ name: String) -> String {
        let lower = name.lowercased()
        for prefix in ["the ", "a ", "an "] {
            if lower.hasPrefix(prefix) { return String(name.dropFirst(prefix.count)) }
        }
        return name
    }
}
