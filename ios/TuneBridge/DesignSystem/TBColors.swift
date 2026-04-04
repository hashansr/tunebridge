import SwiftUI

// MARK: - TuneBridge Design System — Colours
// Mirrors the "Luminous Depth / Obsidian" palette used by the web app.

extension Color {

    // MARK: Surfaces (dark-to-light depth stack)
    static let tbBackground  = Color(hex: "#131313") // deepest — app background
    static let tbSurface1    = Color(hex: "#1c1b1b") // cards, sheets
    static let tbSurface2    = Color(hex: "#2a2a2a") // hover states, inner panels
    static let tbSurface3    = Color(hex: "#353534") // active / pressed

    // MARK: Accent system
    static let tbAccent      = Color(hex: "#adc6ff") // primary blue
    static let tbAccentDim   = Color(hex: "#adc6ff").opacity(0.18)
    static let tbPink        = Color(hex: "#ffb3b5") // secondary / danger
    static let tbGreen       = Color(hex: "#53e16f") // tertiary / success

    // MARK: Text
    static let tbTextPrimary  = Color(hex: "#f0f0f0")
    static let tbTextSecondary = Color(hex: "#a0a0a0")
    static let tbTextMuted    = Color(hex: "#666666")

    // MARK: Misc
    static let tbDivider      = Color.white.opacity(0.06)
    static let tbGlow         = Color(hex: "#adc6ff").opacity(0.12)
}

// MARK: - Hex initialiser

extension Color {
    init(hex: String) {
        let hex = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var int: UInt64 = 0
        Scanner(string: hex).scanHexInt64(&int)
        let a, r, g, b: UInt64
        switch hex.count {
        case 3:
            (a, r, g, b) = (255, (int >> 8) * 17, (int >> 4 & 0xF) * 17, (int & 0xF) * 17)
        case 6:
            (a, r, g, b) = (255, int >> 16, int >> 8 & 0xFF, int & 0xFF)
        case 8:
            (a, r, g, b) = (int >> 24, int >> 16 & 0xFF, int >> 8 & 0xFF, int & 0xFF)
        default:
            (a, r, g, b) = (255, 0, 0, 0)
        }
        self.init(
            .sRGB,
            red: Double(r) / 255,
            green: Double(g) / 255,
            blue: Double(b) / 255,
            opacity: Double(a) / 255
        )
    }
}

// MARK: - Gradient helpers

extension LinearGradient {
    static var tbAccentGradient: LinearGradient {
        LinearGradient(
            colors: [Color(hex: "#adc6ff"), Color(hex: "#7ba4ff")],
            startPoint: .topLeading, endPoint: .bottomTrailing
        )
    }

    static var tbSurfaceGradient: LinearGradient {
        LinearGradient(
            colors: [Color(hex: "#1e1e1e"), Color(hex: "#191919")],
            startPoint: .top, endPoint: .bottom
        )
    }
}
