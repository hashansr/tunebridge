import SwiftUI

// MARK: - SettingsView

struct SettingsView: View {

    @EnvironmentObject private var audio: AudioEngine
    @EnvironmentObject private var library: LibraryManager

    @AppStorage("tb_crossfade")       private var crossfadeDuration: Double = 0
    @AppStorage("tb_resume_on_launch") private var resumeOnLaunch: Bool = true

    var body: some View {
        ZStack {
            Color.tbBackground.ignoresSafeArea()

            List {
                // PEQ
                peqSection

                // Playback
                playbackSection

                // Library
                librarySection

                // About
                aboutSection
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
        }
        .navigationTitle("Settings")
        .tbNavigationBar()
    }

    // MARK: - PEQ Section

    private var peqSection: some View {
        Section {
            HStack {
                Label("Active PEQ", systemImage: "slider.horizontal.3")
                    .foregroundStyle(Color.tbTextPrimary)
                Spacer()
                Text(audio.activePEQProfile?.name ?? "None")
                    .foregroundStyle(Color.tbTextMuted)
                    .font(.system(size: 14))
            }
            .listRowBackground(Color.tbSurface1)

            if !library.peqProfiles.isEmpty {
                NavigationLink {
                    PEQProfilesView()
                        .environmentObject(audio)
                        .environmentObject(library)
                } label: {
                    Label("Manage PEQ Profiles", systemImage: "music.note.list")
                        .foregroundStyle(Color.tbTextPrimary)
                }
                .listRowBackground(Color.tbSurface1)
            }
        } header: {
            sectionHeader("Equaliser")
        }
    }

    // MARK: - Playback Section

    private var playbackSection: some View {
        Section {
            // Crossfade
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Label("Crossfade", systemImage: "waveform.path.ecg")
                        .foregroundStyle(Color.tbTextPrimary)
                    Spacer()
                    Text(crossfadeDuration == 0 ? "Off" : String(format: "%.0f s", crossfadeDuration))
                        .foregroundStyle(Color.tbTextMuted)
                        .font(.system(size: 14).monospacedDigit())
                }
                if crossfadeDuration > 0 {
                    Slider(value: $crossfadeDuration, in: 1...12, step: 1)
                        .tint(Color.tbAccent)
                }
            }
            .listRowBackground(Color.tbSurface1)

            Toggle(isOn: Binding(
                get: { crossfadeDuration > 0 },
                set: { crossfadeDuration = $0 ? 3 : 0 }
            )) {
                Label("Enable Crossfade", systemImage: "arrow.triangle.2.circlepath")
                    .foregroundStyle(Color.tbTextPrimary)
            }
            .tint(Color.tbAccent)
            .listRowBackground(Color.tbSurface1)

            Toggle(isOn: $resumeOnLaunch) {
                Label("Resume on Launch", systemImage: "play.circle")
                    .foregroundStyle(Color.tbTextPrimary)
            }
            .tint(Color.tbAccent)
            .listRowBackground(Color.tbSurface1)

        } header: {
            sectionHeader("Playback")
        }
    }

    // MARK: - Library section

    private var librarySection: some View {
        Section {
            HStack {
                Label("Tracks on Device", systemImage: "music.note")
                    .foregroundStyle(Color.tbTextPrimary)
                Spacer()
                Text("\(library.trackCount)")
                    .foregroundStyle(Color.tbTextMuted)
                    .font(.system(size: 14).monospacedDigit())
            }
            .listRowBackground(Color.tbSurface1)

            HStack {
                Label("Storage Used", systemImage: "internaldrive")
                    .foregroundStyle(Color.tbTextPrimary)
                Spacer()
                Text(formattedStorage)
                    .foregroundStyle(Color.tbTextMuted)
                    .font(.system(size: 14))
            }
            .listRowBackground(Color.tbSurface1)

            if let date = library.lastSyncDate {
                HStack {
                    Label("Last Synced", systemImage: "arrow.triangle.2.circlepath")
                        .foregroundStyle(Color.tbTextPrimary)
                    Spacer()
                    Text(date, style: .relative)
                        .foregroundStyle(Color.tbTextMuted)
                        .font(.system(size: 14))
                }
                .listRowBackground(Color.tbSurface1)
            }

        } header: {
            sectionHeader("Library")
        }
    }

    // MARK: - About section

    private var aboutSection: some View {
        Section {
            HStack {
                Label("Version", systemImage: "info.circle")
                    .foregroundStyle(Color.tbTextPrimary)
                Spacer()
                Text(appVersion)
                    .foregroundStyle(Color.tbTextMuted)
                    .font(.system(size: 14))
            }
            .listRowBackground(Color.tbSurface1)

            HStack {
                Label("TuneBridge Desktop", systemImage: "desktopcomputer")
                    .foregroundStyle(Color.tbTextPrimary)
                Spacer()
                Text("github.com/hashansr/tunebridge")
                    .foregroundStyle(Color.tbTextMuted)
                    .font(.system(size: 12))
                    .lineLimit(1)
            }
            .listRowBackground(Color.tbSurface1)

        } header: {
            sectionHeader("About")
        }
    }

    // MARK: - Helpers

    private func sectionHeader(_ title: String) -> some View {
        Text(title.uppercased())
            .font(.system(size: 11, weight: .semibold))
            .kerning(0.8)
            .foregroundStyle(Color.tbTextMuted)
    }

    private var formattedStorage: String {
        let formatter = ByteCountFormatter()
        formatter.allowedUnits = [.useGB, .useMB]
        formatter.countStyle = .file
        return formatter.string(fromByteCount: library.storageUsedBytes())
    }

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
    }
}

// MARK: - PEQ Profiles List

struct PEQProfilesView: View {
    @EnvironmentObject private var audio: AudioEngine
    @EnvironmentObject private var library: LibraryManager

    var body: some View {
        ZStack {
            Color.tbBackground.ignoresSafeArea()
            List {
                // None
                Button {
                    audio.applyPEQProfile(nil)
                } label: {
                    HStack {
                        Image(systemName: audio.activePEQProfile == nil ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(audio.activePEQProfile == nil ? Color.tbAccent : Color.tbTextMuted)
                        Text("No EQ")
                            .foregroundStyle(Color.tbTextPrimary)
                        Spacer()
                    }
                }
                .listRowBackground(Color.tbSurface1)

                let grouped = Dictionary(grouping: library.peqProfiles) { $0.iemName }
                ForEach(grouped.keys.sorted(), id: \.self) { iem in
                    Section {
                        ForEach(grouped[iem] ?? []) { profile in
                            Button {
                                audio.applyPEQProfile(profile)
                            } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: audio.activePEQProfile?.id == profile.id ? "checkmark.circle.fill" : "circle")
                                        .foregroundStyle(audio.activePEQProfile?.id == profile.id ? Color.tbAccent : Color.tbTextMuted)

                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(profile.name)
                                            .font(.system(size: 15))
                                            .foregroundStyle(Color.tbTextPrimary)
                                        Text("\(profile.filters.count) filters · Preamp \(String(format: "%+.1f", profile.preampDb)) dB")
                                            .font(.system(size: 12))
                                            .foregroundStyle(Color.tbTextMuted)
                                    }
                                    Spacer()
                                }
                            }
                            .listRowBackground(Color.tbSurface1)
                        }
                    } header: {
                        Text(iem)
                            .foregroundStyle(Color.tbTextSecondary)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
        }
        .navigationTitle("PEQ Profiles")
        .tbNavigationBar()
    }
}
