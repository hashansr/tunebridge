import SwiftUI

// MARK: - Reusable Components

// MARK: - TB Card
// Standard elevated card surface.

struct TBCard<Content: View>: View {
    let content: Content
    var padding: CGFloat = 16

    init(padding: CGFloat = 16, @ViewBuilder content: () -> Content) {
        self.content = content()
        self.padding = padding
    }

    var body: some View {
        content
            .padding(padding)
            .background(Color.tbSurface1)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.06), lineWidth: 1)
            )
    }
}

// MARK: - TB Primary Button

struct TBPrimaryButton: View {
    let title: String
    let icon: String?
    let action: () -> Void

    init(_ title: String, icon: String? = nil, action: @escaping () -> Void) {
        self.title = title
        self.icon = icon
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let icon { Image(systemName: icon).font(.system(size: 14, weight: .semibold)) }
                Text(title).font(.system(size: 14, weight: .semibold))
            }
            .foregroundStyle(Color.tbBackground)
            .padding(.horizontal, 18)
            .padding(.vertical, 10)
            .background(LinearGradient.tbAccentGradient)
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - TB Secondary Button

struct TBSecondaryButton: View {
    let title: String
    let icon: String?
    let action: () -> Void

    init(_ title: String, icon: String? = nil, action: @escaping () -> Void) {
        self.title = title
        self.icon = icon
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let icon { Image(systemName: icon).font(.system(size: 13, weight: .medium)) }
                Text(title).font(.system(size: 13, weight: .medium))
            }
            .foregroundStyle(Color.tbAccent)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(Color.tbAccentDim)
            .clipShape(Capsule())
            .overlay(Capsule().strokeBorder(Color.tbAccent.opacity(0.25), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - TB Overline label

struct TBOverline: View {
    let text: String

    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 10, weight: .semibold))
            .kerning(1.2)
            .foregroundStyle(Color.tbTextMuted)
    }
}

// MARK: - TB Section Title

struct TBSectionTitle: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 20, weight: .bold))
            .foregroundStyle(Color.tbTextPrimary)
    }
}

// MARK: - Artwork view
// Shows album art from the local artwork cache, with a music note placeholder.

struct ArtworkView: View {
    let artworkKey: String?
    var size: CGFloat = 56
    var cornerRadius: CGFloat = 8

    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } else {
                ZStack {
                    Color.tbSurface2
                    Image(systemName: "music.note")
                        .font(.system(size: size * 0.36))
                        .foregroundStyle(Color.tbTextMuted)
                }
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        .task(id: artworkKey) {
            guard let key = artworkKey else { return }
            image = await LibraryManager.shared.loadArtwork(key: key)
        }
    }
}

// MARK: - Track Row

struct TrackRow: View {
    let track: Track
    let index: Int?
    let isPlaying: Bool
    let onTap: () -> Void

    init(track: Track, index: Int? = nil, isPlaying: Bool = false, onTap: @escaping () -> Void) {
        self.track = track
        self.index = index
        self.isPlaying = isPlaying
        self.onTap = onTap
    }

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 12) {
                // Index / playing indicator
                ZStack {
                    if isPlaying {
                        Image(systemName: "waveform")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(Color.tbAccent)
                            .symbolEffect(.variableColor.iterative)
                    } else if let idx = index {
                        Text("\(idx)")
                            .font(.system(size: 13, weight: .regular).monospacedDigit())
                            .foregroundStyle(Color.tbTextMuted)
                    }
                }
                .frame(width: 24, alignment: .center)

                VStack(alignment: .leading, spacing: 2) {
                    Text(track.title)
                        .font(.system(size: 15, weight: isPlaying ? .semibold : .regular))
                        .foregroundStyle(isPlaying ? Color.tbAccent : Color.tbTextPrimary)
                        .lineLimit(1)

                    Text(track.artist)
                        .font(.system(size: 13))
                        .foregroundStyle(Color.tbTextSecondary)
                        .lineLimit(1)
                }

                Spacer()

                VStack(alignment: .trailing, spacing: 2) {
                    Text(track.durationFormatted)
                        .font(.system(size: 13).monospacedDigit())
                        .foregroundStyle(Color.tbTextMuted)

                    if track.isLossless {
                        Text(track.format)
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(Color.tbGreen.opacity(0.8))
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Color.tbGreen.opacity(0.12))
                            .clipShape(Capsule())
                    }
                }
            }
            .padding(.vertical, 8)
            .padding(.horizontal, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(isPlaying ? Color.tbAccent.opacity(0.06) : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

// MARK: - Lossless quality badge

struct QualityBadge: View {
    let label: String
    var color: Color = .tbGreen

    var body: some View {
        Text(label)
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.12))
            .clipShape(Capsule())
            .overlay(Capsule().strokeBorder(color.opacity(0.2), lineWidth: 0.5))
    }
}

// MARK: - Empty state

struct TBEmptyState: View {
    let icon: String
    let title: String
    let message: String
    var action: (label: String, handler: () -> Void)?

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: icon)
                .font(.system(size: 40, weight: .light))
                .foregroundStyle(Color.tbTextMuted)
                .padding(.bottom, 4)

            Text(title)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Color.tbTextPrimary)

            Text(message)
                .font(.system(size: 14))
                .foregroundStyle(Color.tbTextSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)

            if let action {
                TBSecondaryButton(action.label, action: action.handler)
                    .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.vertical, 60)
    }
}

// MARK: - View modifiers

struct TBNavigationBarStyle: ViewModifier {
    func body(content: Content) -> some View {
        content
            .toolbarBackground(Color.tbBackground, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
    }
}

extension View {
    func tbNavigationBar() -> some View {
        modifier(TBNavigationBarStyle())
    }
}
