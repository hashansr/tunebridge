import Foundation
import AVFoundation

// MARK: - PEQ Filter Types
// Mirrors APO/AutoEQ filter type strings used by TuneBridge desktop.

enum PEQFilterType: String, Codable, CaseIterable {
    case peaking   = "PK"
    case lowShelf  = "LSC"
    case highShelf = "HSC"
    case lowPass   = "LPQ"
    case highPass  = "HPQ"
    case notch     = "NO"
    case allPass   = "AP"

    var avFilterType: AVAudioUnitEQFilterType {
        switch self {
        case .peaking:   return .parametric
        case .lowShelf:  return .lowShelf
        case .highShelf: return .highShelf
        case .lowPass:   return .lowPass
        case .highPass:  return .highPass
        case .notch:     return .bandStop
        case .allPass:   return .allPass
        }
    }

    var displayName: String {
        switch self {
        case .peaking:   return "Peak"
        case .lowShelf:  return "Low Shelf"
        case .highShelf: return "High Shelf"
        case .lowPass:   return "Low Pass"
        case .highPass:  return "High Pass"
        case .notch:     return "Notch"
        case .allPass:   return "All Pass"
        }
    }
}

// MARK: - PEQ Filter

struct PEQFilter: Codable, Identifiable, Hashable {
    var id = UUID().uuidString
    var type: PEQFilterType
    var frequency: Double   // Hz
    var gain: Double        // dB
    var q: Double

    // Convert Q to bandwidth in octaves for AVAudioUnitEQ.
    // Approximation: BW ≈ 1/Q, accurate enough for musical EQ values.
    var bandwidthOctaves: Double {
        guard q > 0 else { return 1.0 }
        return 1.0 / q
    }

    enum CodingKeys: String, CodingKey {
        case type, frequency = "fc", gain, q
    }
}

// MARK: - PEQ Profile
// Mirrors the shape stored in TuneBridge desktop's iems.json peq_profiles array.

struct PEQProfile: Identifiable, Codable, Hashable {
    let id: String
    var name: String
    var iemName: String     // which IEM this profile is for
    var preampDb: Double    // global gain offset (usually negative to prevent clipping)
    var filters: [PEQFilter]

    // Populated from raw_txt for display only — not stored
    var rawText: String?

    enum CodingKeys: String, CodingKey {
        case id, name, iemName = "iem_name", preampDb = "preamp_db", filters, rawText = "raw_txt"
    }

    // Total number of active (non-zero-gain) filters
    var activeFilterCount: Int {
        filters.filter { abs($0.gain) > 0.01 }.count
    }
}

// MARK: - IEM record
// Minimal shape needed to extract PEQ profiles from iems.json.

struct IEMRecord: Codable {
    let id: String
    var name: String
    var peqProfiles: [PEQProfile]

    enum CodingKeys: String, CodingKey {
        case id, name, peqProfiles = "peq_profiles"
    }
}

// MARK: - IEMs store

struct IEMsStore: Codable {
    var iems: [IEMRecord]
}
