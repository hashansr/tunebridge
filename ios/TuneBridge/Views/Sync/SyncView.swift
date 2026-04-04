import SwiftUI

// MARK: - SyncView
// Shows sync server status, discovered Mac, and transfer progress.

struct SyncView: View {

    @EnvironmentObject private var syncManager: SyncManager
    @EnvironmentObject private var library: LibraryManager
    @State private var showStorageDetail = false

    var body: some View {
        ZStack {
            Color.tbBackground.ignoresSafeArea()

            ScrollView {
                VStack(spacing: 20) {
                    header
                    serverCard
                    if syncManager.isServerRunning { macDiscoveryCard }
                    progressCard
                    storageCard
                    instructionsCard
                }
                .padding(16)
                .padding(.bottom, 120)
            }
        }
        .navigationTitle("Sync")
        .tbNavigationBar()
    }

    // MARK: - Cards

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            TBSectionTitle(text: "Mac Sync")
            Text("Keep this tab open on the same WiFi network as your Mac.")
                .font(.system(size: 14))
                .foregroundStyle(Color.tbTextSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 4)
    }

    private var serverCard: some View {
        TBCard {
            VStack(spacing: 16) {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        TBOverline(text: "Receiver")
                        Text(syncManager.isServerRunning ? "Ready to receive" : "Server offline")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(syncManager.isServerRunning ? Color.tbGreen : Color.tbPink)
                    }

                    Spacer()

                    Circle()
                        .fill(syncManager.isServerRunning ? Color.tbGreen : Color.tbTextMuted)
                        .frame(width: 10, height: 10)
                        .shadow(color: syncManager.isServerRunning ? Color.tbGreen.opacity(0.5) : .clear, radius: 4)
                }

                if syncManager.isServerRunning {
                    Text("Advertising as "TuneBridge" on local network · Port 7891")
                        .font(.system(size: 12))
                        .foregroundStyle(Color.tbTextMuted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                Divider().background(Color.tbDivider)

                HStack {
                    if syncManager.isServerRunning {
                        TBSecondaryButton("Stop", icon: "stop.fill") {
                            syncManager.stopListening()
                        }
                    } else {
                        TBPrimaryButton("Start Receiver", icon: "antenna.radiowaves.left.and.right") {
                            syncManager.startListening()
                        }
                    }
                    Spacer()

                    if let last = library.lastSyncDate {
                        VStack(alignment: .trailing, spacing: 2) {
                            TBOverline(text: "Last Sync")
                            Text(last, style: .relative)
                                .font(.system(size: 12))
                                .foregroundStyle(Color.tbTextSecondary)
                            + Text(" ago")
                                .font(.system(size: 12))
                                .foregroundStyle(Color.tbTextSecondary)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var macDiscoveryCard: some View {
        TBCard {
            HStack(spacing: 14) {
                Image(systemName: syncManager.discoveredMacName != nil ? "desktopcomputer" : "magnifyingglass")
                    .font(.system(size: 24))
                    .foregroundStyle(syncManager.discoveredMacName != nil ? Color.tbAccent : Color.tbTextMuted)
                    .frame(width: 32)

                VStack(alignment: .leading, spacing: 4) {
                    TBOverline(text: "TuneBridge on Mac")
                    if let name = syncManager.discoveredMacName {
                        Text(name)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Color.tbTextPrimary)
                        Text("Open Sync in TuneBridge on Mac and select this iPhone.")
                            .font(.system(size: 12))
                            .foregroundStyle(Color.tbTextSecondary)
                    } else {
                        Text("Searching…")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Color.tbTextSecondary)
                        Text("Make sure TuneBridge is open on your Mac and on the same WiFi.")
                            .font(.system(size: 12))
                            .foregroundStyle(Color.tbTextMuted)
                    }
                }

                Spacer()

                if syncManager.discoveredMacName != nil {
                    Circle()
                        .fill(Color.tbGreen)
                        .frame(width: 8, height: 8)
                        .shadow(color: Color.tbGreen.opacity(0.5), radius: 3)
                }
            }
        }
    }

    @ViewBuilder
    private var progressCard: some View {
        let progress = syncManager.progress
        if progress.totalFiles > 0 || progress.completedFiles > 0 {
            TBCard {
                VStack(spacing: 12) {
                    HStack {
                        TBOverline(text: "Transfer")
                        Spacer()
                        Text("\(progress.completedFiles) / \(progress.totalFiles)")
                            .font(.system(size: 13, weight: .semibold).monospacedDigit())
                            .foregroundStyle(Color.tbTextSecondary)
                    }

                    // Progress bar
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule()
                                .fill(Color.tbSurface2)
                                .frame(height: 6)
                            Capsule()
                                .fill(LinearGradient.tbAccentGradient)
                                .frame(width: geo.size.width * CGFloat(progress.percentComplete), height: 6)
                                .animation(.easeOut(duration: 0.3), value: progress.percentComplete)
                        }
                    }
                    .frame(height: 6)

                    if !progress.currentFile.isEmpty {
                        Text(progress.currentFile)
                            .font(.system(size: 12))
                            .foregroundStyle(Color.tbTextMuted)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
    }

    private var storageCard: some View {
        TBCard {
            HStack {
                VStack(alignment: .leading, spacing: 6) {
                    TBOverline(text: "Storage")
                    Text(formattedStorageUsed)
                        .font(.system(size: 22, weight: .bold))
                        .foregroundStyle(Color.tbTextPrimary)
                    Text("used by TuneBridge")
                        .font(.system(size: 13))
                        .foregroundStyle(Color.tbTextMuted)
                }
                Spacer()

                VStack(alignment: .trailing, spacing: 4) {
                    Text("\(library.trackCount)")
                        .font(.system(size: 22, weight: .bold))
                        .foregroundStyle(Color.tbAccent)
                    Text("tracks on device")
                        .font(.system(size: 13))
                        .foregroundStyle(Color.tbTextMuted)
                }
            }
        }
    }

    private var instructionsCard: some View {
        TBCard {
            VStack(alignment: .leading, spacing: 12) {
                TBOverline(text: "How to Sync")

                VStack(alignment: .leading, spacing: 8) {
                    step(number: "1", text: "Open TuneBridge on your Mac")
                    step(number: "2", text: "Go to Sync → iOS Device")
                    step(number: "3", text: "Select this iPhone and choose what to sync")
                    step(number: "4", text: "Keep this tab open until the transfer is complete")
                }
            }
        }
    }

    private func step(number: String, text: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(number)
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(Color.tbBackground)
                .frame(width: 20, height: 20)
                .background(Color.tbAccent)
                .clipShape(Circle())

            Text(text)
                .font(.system(size: 14))
                .foregroundStyle(Color.tbTextSecondary)
        }
    }

    // MARK: - Helpers

    private var formattedStorageUsed: String {
        let bytes = library.storageUsedBytes()
        let formatter = ByteCountFormatter()
        formatter.allowedUnits = [.useGB, .useMB]
        formatter.countStyle = .file
        return formatter.string(fromByteCount: bytes)
    }
}
