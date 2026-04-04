import SwiftUI

// MARK: - NowPlayingSheet
// Full-screen now-playing view. Presented as a sheet from ContentView.
// Artwork · Track info · Seek bar · Transport · PEQ toggle · Queue

struct NowPlayingSheet: View {

    @EnvironmentObject private var audio: AudioEngine
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var library: LibraryManager

    @State private var showPEQPicker = false
    @State private var showQueue     = false
    @State private var dragValue: Double? = nil

    var body: some View {
        ZStack {
            Color.tbBackground.ignoresSafeArea()

            VStack(spacing: 0) {
                // Handle + dismiss
                handle

                ScrollView(.vertical, showsIndicators: false) {
                    VStack(spacing: 28) {
                        // Artwork
                        artworkSection
                        // Track info + controls
                        infoSection
                        // Seek bar
                        seekSection
                        // Transport
                        transportSection
                        // Secondary controls
                        secondarySection
                    }
                    .padding(.horizontal, 24)
                    .padding(.bottom, 32)
                }
            }

            // PEQ picker overlay
            if showPEQPicker {
                PEQPickerOverlay(isPresented: $showPEQPicker)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .sheet(isPresented: $showQueue) {
            QueueSheet()
                .environmentObject(audio)
        }
    }

    // MARK: - Subviews

    private var handle: some View {
        HStack {
            Button { appState.isNowPlayingPresented = false } label: {
                Image(systemName: "chevron.down")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(Color.tbTextSecondary)
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)

            Spacer()

            Text("Now Playing")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Color.tbTextSecondary)

            Spacer()

            Button { showQueue.toggle() } label: {
                Image(systemName: "list.bullet")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(Color.tbTextSecondary)
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
    }

    private var artworkSection: some View {
        ArtworkView(
            artworkKey: audio.currentTrack?.artworkKey,
            size: min(UIScreen.main.bounds.width - 48, 360),
            cornerRadius: 20
        )
        .shadow(color: Color.black.opacity(0.5), radius: 24, y: 8)
        .scaleEffect(audio.isPlaying ? 1.0 : 0.92)
        .animation(.spring(response: 0.5, dampingFraction: 0.7), value: audio.isPlaying)
        .padding(.top, 8)
    }

    private var infoSection: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                Text(audio.currentTrack?.title ?? "–")
                    .font(.system(size: 22, weight: .bold))
                    .foregroundStyle(Color.tbTextPrimary)
                    .lineLimit(1)

                Text(audio.currentTrack?.artist ?? "–")
                    .font(.system(size: 16))
                    .foregroundStyle(Color.tbTextSecondary)
                    .lineLimit(1)

                if let track = audio.currentTrack, !track.qualityLabel.isEmpty {
                    Text(track.qualityLabel)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(Color.tbGreen.opacity(0.9))
                        .padding(.top, 2)
                }
            }
            Spacer()
        }
    }

    private var seekSection: some View {
        VStack(spacing: 4) {
            // Custom seek slider
            GeometryReader { geo in
                let progress = audio.duration > 0
                    ? (dragValue ?? audio.currentTime) / audio.duration
                    : 0.0

                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Color.tbSurface2)
                        .frame(height: 4)

                    Capsule()
                        .fill(LinearGradient.tbAccentGradient)
                        .frame(width: geo.size.width * CGFloat(progress), height: 4)
                }
                .frame(height: 20)
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { value in
                            let pct = max(0, min(1, value.location.x / geo.size.width))
                            dragValue = pct * audio.duration
                        }
                        .onEnded { value in
                            if let t = dragValue { audio.seek(to: t) }
                            dragValue = nil
                        }
                )
            }
            .frame(height: 20)

            HStack {
                Text(formatTime(dragValue ?? audio.currentTime))
                    .font(.system(size: 12).monospacedDigit())
                    .foregroundStyle(Color.tbTextMuted)
                Spacer()
                Text(formatTime(audio.duration))
                    .font(.system(size: 12).monospacedDigit())
                    .foregroundStyle(Color.tbTextMuted)
            }
        }
    }

    private var transportSection: some View {
        HStack(spacing: 0) {
            // Shuffle
            Button { audio.toggleShuffle() } label: {
                Image(systemName: "shuffle")
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(audio.shuffleEnabled ? Color.tbAccent : Color.tbTextMuted)
                    .frame(maxWidth: .infinity)
            }

            // Previous
            Button { audio.skipPrevious() } label: {
                Image(systemName: "backward.fill")
                    .font(.system(size: 28, weight: .medium))
                    .foregroundStyle(Color.tbTextPrimary)
                    .frame(maxWidth: .infinity)
            }

            // Play / Pause
            Button { audio.togglePlayPause() } label: {
                ZStack {
                    Circle()
                        .fill(LinearGradient.tbAccentGradient)
                        .frame(width: 68, height: 68)
                    Image(systemName: audio.isPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: 28, weight: .semibold))
                        .foregroundStyle(Color.tbBackground)
                        .offset(x: audio.isPlaying ? 0 : 2)
                }
                .frame(maxWidth: .infinity)
            }
            .scaleEffect(audio.isLoading ? 0.95 : 1.0)

            // Next
            Button { audio.skipNext() } label: {
                Image(systemName: "forward.fill")
                    .font(.system(size: 28, weight: .medium))
                    .foregroundStyle(Color.tbTextPrimary)
                    .frame(maxWidth: .infinity)
            }

            // Repeat
            Button { audio.cycleRepeat() } label: {
                Image(systemName: audio.repeatMode.systemImageName)
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(audio.repeatMode != .off ? Color.tbAccent : Color.tbTextMuted)
                    .overlay(alignment: .topTrailing) {
                        if audio.repeatMode == .one {
                            Text("1")
                                .font(.system(size: 8, weight: .bold))
                                .foregroundStyle(Color.tbAccent)
                                .offset(x: 6, y: -4)
                        }
                    }
                    .frame(maxWidth: .infinity)
            }
        }
        .buttonStyle(.plain)
        .frame(height: 72)
    }

    private var secondarySection: some View {
        HStack(spacing: 12) {
            // PEQ
            Button { withAnimation(.spring()) { showPEQPicker.toggle() } } label: {
                HStack(spacing: 6) {
                    Image(systemName: "slider.horizontal.3")
                        .font(.system(size: 13, weight: .medium))
                    Text(audio.activePEQProfile?.iemName ?? "No PEQ")
                        .font(.system(size: 13, weight: .medium))
                        .lineLimit(1)
                }
                .foregroundStyle(audio.activePEQProfile != nil ? Color.tbAccent : Color.tbTextMuted)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(audio.activePEQProfile != nil ? Color.tbAccentDim : Color.tbSurface2)
                .clipShape(Capsule())
                .overlay(
                    Capsule().strokeBorder(
                        audio.activePEQProfile != nil ? Color.tbAccent.opacity(0.3) : Color.white.opacity(0.06),
                        lineWidth: 1
                    )
                )
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity)

            // Volume (system)
            VolumeSliderView()
                .frame(maxWidth: .infinity)
        }
    }

    // MARK: - Helpers

    private func formatTime(_ seconds: Double) -> String {
        let s = Int(seconds)
        return String(format: "%d:%02d", s / 60, s % 60)
    }
}

// MARK: - PEQ Picker Overlay

private struct PEQPickerOverlay: View {
    @Binding var isPresented: Bool
    @EnvironmentObject private var audio: AudioEngine
    @EnvironmentObject private var library: LibraryManager

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            VStack(spacing: 0) {
                // Handle
                RoundedRectangle(cornerRadius: 2)
                    .fill(Color.tbTextMuted)
                    .frame(width: 36, height: 4)
                    .padding(.top, 12)
                    .padding(.bottom, 8)

                Text("PEQ Profile")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Color.tbTextPrimary)
                    .padding(.bottom, 12)

                Divider().background(Color.tbDivider)

                ScrollView {
                    VStack(spacing: 0) {
                        // "None" option
                        peqRow(profile: nil)
                        Divider().background(Color.tbDivider)

                        // Group by IEM name
                        let grouped = Dictionary(grouping: library.peqProfiles) { $0.iemName }
                        ForEach(grouped.keys.sorted(), id: \.self) { iem in
                            Section {
                                ForEach(grouped[iem] ?? []) { profile in
                                    peqRow(profile: profile)
                                    Divider().background(Color.tbDivider)
                                }
                            } header: {
                                Text(iem.uppercased())
                                    .font(.system(size: 10, weight: .semibold))
                                    .kerning(1.2)
                                    .foregroundStyle(Color.tbTextMuted)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.horizontal, 20)
                                    .padding(.vertical, 8)
                                    .background(Color.tbSurface1)
                            }
                        }
                    }
                }
                .frame(maxHeight: 360)
            }
            .background(Color.tbSurface1)
            .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.07), lineWidth: 1)
            )
            .padding(.horizontal, 8)
            .padding(.bottom, 8)
        }
        .background(Color.black.opacity(0.4).ignoresSafeArea().onTapGesture { isPresented = false })
    }

    private func peqRow(profile: PEQProfile?) -> some View {
        let isActive = audio.activePEQProfile?.id == profile?.id

        return Button {
            audio.applyPEQProfile(profile)
            isPresented = false
        } label: {
            HStack(spacing: 14) {
                Image(systemName: isActive ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 18))
                    .foregroundStyle(isActive ? Color.tbAccent : Color.tbTextMuted)

                VStack(alignment: .leading, spacing: 2) {
                    Text(profile?.name ?? "No EQ")
                        .font(.system(size: 15, weight: isActive ? .semibold : .regular))
                        .foregroundStyle(isActive ? Color.tbAccent : Color.tbTextPrimary)

                    if let p = profile {
                        Text("\(p.filters.count) filters · Preamp \(String(format: "%+.1f", p.preampDb)) dB")
                            .font(.system(size: 12))
                            .foregroundStyle(Color.tbTextMuted)
                    }
                }

                Spacer()
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Queue Sheet

private struct QueueSheet: View {
    @EnvironmentObject private var audio: AudioEngine
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ZStack {
                Color.tbBackground.ignoresSafeArea()

                if audio.queue.isEmpty {
                    TBEmptyState(
                        icon: "music.note.list",
                        title: "Queue is empty",
                        message: "Play a track or playlist to build your queue."
                    )
                } else {
                    List {
                        ForEach(Array(audio.queue.enumerated()), id: \.element.id) { idx, track in
                            TrackRow(
                                track: track,
                                index: idx + 1,
                                isPlaying: idx == audio.queueIndex
                            ) {
                                audio.playAll(audio.queue, startingAt: idx)
                            }
                            .listRowBackground(Color.tbBackground)
                            .listRowSeparatorTint(Color.tbDivider)
                        }
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                }
            }
            .navigationTitle("Queue")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(Color.tbAccent)
                }
            }
            .tbNavigationBar()
        }
    }
}

// MARK: - Volume Slider (uses MPVolumeView wrapper)

private struct VolumeSliderView: UIViewRepresentable {
    func makeUIView(context: Context) -> some UIView {
        // MPVolumeView provides the system volume slider
        // For now, return a placeholder — full implementation requires MediaPlayer import
        let view = UIView()
        view.backgroundColor = .clear
        return view
    }
    func updateUIView(_ uiView: UIViewType, context: Context) {}
}
