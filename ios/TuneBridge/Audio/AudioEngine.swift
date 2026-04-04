import AVFoundation
import Combine

// MARK: - Repeat Mode

enum RepeatMode: String, CaseIterable {
    case off, all, one

    var systemImageName: String {
        switch self {
        case .off:  return "repeat"
        case .all:  return "repeat"
        case .one:  return "repeat.1"
        }
    }
}

// MARK: - Audio Engine
// Core playback engine. Handles FLAC/lossless file playback, real-time PEQ via
// AVAudioUnitEQ, queue management, shuffle, and repeat. Notifies NowPlayingManager
// so lock screen controls and remote commands stay in sync.

final class AudioEngine: ObservableObject {

    // MARK: Published state (all mutations must happen on main thread)
    @Published var isPlaying = false
    @Published var currentTrack: Track?
    @Published var currentTime: Double = 0
    @Published var duration: Double = 0
    @Published var activePEQProfile: PEQProfile?
    @Published var volume: Float = 1.0 { didSet { applyVolume() } }
    @Published var queue: [Track] = []
    @Published var queueIndex: Int = -1
    @Published var shuffleEnabled = false
    @Published var repeatMode: RepeatMode = .off
    @Published var isLoading = false
    @Published var error: String?

    // MARK: AVAudio graph
    private let engine = AVAudioEngine()
    private let playerNode = AVAudioPlayerNode()
    // 16 bands covers any real-world PEQ profile; APO profiles rarely exceed 10 filters.
    private let eqNode = AVAudioUnitEQ(numberOfBands: 16)
    private var currentFile: AVAudioFile?

    // MARK: Queue state
    private var shuffledOrder: [Int] = []
    private var positionInShuffle: Int = 0

    // MARK: Observers
    private var progressTimer: Timer?
    let nowPlaying = NowPlayingManager()

    // MARK: - Init

    init() {
        setupAudioSession()
        buildAudioGraph()
        setupRemoteCommands()
    }

    // MARK: - Audio graph

    private func buildAudioGraph() {
        engine.attach(playerNode)
        engine.attach(eqNode)

        // playerNode → eqNode → mainMixer → output
        engine.connect(playerNode, to: eqNode, format: nil)
        engine.connect(eqNode, to: engine.mainMixerNode, format: nil)

        // Bypass all EQ bands until a profile is applied
        for band in eqNode.bands { band.bypass = true }
    }

    private func setupAudioSession() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default,
                                    options: [.allowBluetooth, .allowBluetoothA2DP])
            try session.setActive(true)

            NotificationCenter.default.addObserver(
                self, selector: #selector(handleAudioInterruption),
                name: AVAudioSession.interruptionNotification, object: session)

            NotificationCenter.default.addObserver(
                self, selector: #selector(handleRouteChange),
                name: AVAudioSession.routeChangeNotification, object: session)
        } catch {
            print("[AudioEngine] Audio session setup failed: \(error)")
        }
    }

    // MARK: - Playback

    func play(track: Track) {
        guard let url = LibraryManager.shared.localURL(for: track) else {
            DispatchQueue.main.async { self.error = "File not found: \(track.relativePath)" }
            return
        }

        stopProgressTimer()
        playerNode.stop()
        currentFile = nil

        DispatchQueue.main.async { self.isLoading = true }

        do {
            if !engine.isRunning {
                try engine.start()
            }

            let file = try AVAudioFile(forReading: url)
            currentFile = file

            let fileDuration = Double(file.length) / file.processingFormat.sampleRate

            DispatchQueue.main.async {
                self.currentTrack = track
                self.duration = fileDuration
                self.currentTime = 0
                self.isLoading = false
                self.error = nil
            }

            playerNode.scheduleFile(file, at: nil) { [weak self] in
                self?.handleTrackFinished()
            }

            playerNode.play()

            DispatchQueue.main.async {
                self.isPlaying = true
                self.startProgressTimer()
                self.nowPlaying.update(track: track, duration: fileDuration)
            }

        } catch {
            DispatchQueue.main.async {
                self.isLoading = false
                self.error = "Could not load audio: \(error.localizedDescription)"
            }
        }
    }

    func togglePlayPause() {
        if isPlaying {
            playerNode.pause()
            isPlaying = false
            stopProgressTimer()
        } else {
            guard currentTrack != nil else { return }
            do {
                if !engine.isRunning { try engine.start() }
            } catch {
                self.error = "Could not restart audio engine"
                return
            }
            playerNode.play()
            isPlaying = true
            startProgressTimer()
        }
        nowPlaying.updatePlaybackState(isPlaying: isPlaying, currentTime: currentTime)
    }

    func seek(to time: Double) {
        guard let file = currentFile else { return }

        let sampleRate = file.processingFormat.sampleRate
        let totalFrames = AVAudioFrameCount(file.length)
        let clampedTime = min(max(time, 0), duration - 0.1)
        let seekFrame = AVAudioFramePosition(clampedTime * sampleRate)
        let remaining = AVAudioFrameCount(Int64(totalFrames) - seekFrame)

        guard remaining > 0 else { return }

        let wasPlaying = isPlaying
        playerNode.stop()

        playerNode.scheduleSegment(
            file, startingFrame: seekFrame, frameCount: remaining, at: nil
        ) { [weak self] in
            self?.handleTrackFinished()
        }

        if wasPlaying { playerNode.play() }

        DispatchQueue.main.async {
            self.currentTime = clampedTime
            self.nowPlaying.updatePlaybackState(isPlaying: wasPlaying, currentTime: clampedTime)
        }
    }

    // MARK: - Queue management

    func playAll(_ tracks: [Track], startingAt index: Int = 0) {
        queue = tracks
        queueIndex = index
        if shuffleEnabled { buildShuffleOrder(pinning: index) }
        play(track: tracks[index])
    }

    func skipNext() {
        guard !queue.isEmpty else { return }

        switch repeatMode {
        case .one:
            if let t = currentTrack { play(track: t) }
            return
        default: break
        }

        let next = nextIndex()
        if let n = next {
            queueIndex = n
            play(track: queue[n])
        } else if repeatMode == .all {
            let wrap = shuffleEnabled ? shuffledOrder.first ?? 0 : 0
            queueIndex = wrap
            play(track: queue[wrap])
        }
    }

    func skipPrevious() {
        if currentTime > 3 { seek(to: 0); return }

        let prev = previousIndex()
        if let p = prev {
            queueIndex = p
            play(track: queue[p])
        } else {
            seek(to: 0)
        }
    }

    func toggleShuffle() {
        shuffleEnabled.toggle()
        if shuffleEnabled, queueIndex >= 0 {
            buildShuffleOrder(pinning: queueIndex)
        }
    }

    func cycleRepeat() {
        switch repeatMode {
        case .off: repeatMode = .all
        case .all: repeatMode = .one
        case .one: repeatMode = .off
        }
    }

    // MARK: - PEQ

    func applyPEQProfile(_ profile: PEQProfile?) {
        activePEQProfile = profile

        // Reset all bands
        for band in eqNode.bands {
            band.bypass = true
            band.gain = 0
        }

        guard let profile = profile else {
            engine.mainMixerNode.outputVolume = volume
            return
        }

        // Apply preamp: convert dB → linear scale
        let preampLinear = pow(10.0, Float(profile.preampDb) / 20.0)
        engine.mainMixerNode.outputVolume = preampLinear * volume

        // Apply each filter (max 16 bands)
        for (i, filter) in profile.filters.prefix(eqNode.bands.count).enumerated() {
            let band = eqNode.bands[i]
            band.filterType = filter.type.avFilterType
            band.frequency = Float(filter.frequency)
            band.gain = Float(filter.gain)
            band.bandwidth = Float(max(filter.bandwidthOctaves, 0.05))
            band.bypass = false
        }
    }

    func clearPEQ() {
        applyPEQProfile(nil)
    }

    // MARK: - Private helpers

    private func handleTrackFinished() {
        DispatchQueue.main.async {
            if self.repeatMode == .one {
                if let t = self.currentTrack { self.play(track: t) }
                return
            }
            self.skipNext()
        }
    }

    private func nextIndex() -> Int? {
        guard !queue.isEmpty else { return nil }
        if shuffleEnabled {
            guard let pos = shuffledOrder.firstIndex(of: queueIndex), pos + 1 < shuffledOrder.count else { return nil }
            return shuffledOrder[pos + 1]
        }
        let n = queueIndex + 1
        return n < queue.count ? n : nil
    }

    private func previousIndex() -> Int? {
        guard !queue.isEmpty else { return nil }
        if shuffleEnabled {
            guard let pos = shuffledOrder.firstIndex(of: queueIndex), pos > 0 else { return nil }
            return shuffledOrder[pos - 1]
        }
        return queueIndex > 0 ? queueIndex - 1 : nil
    }

    private func buildShuffleOrder(pinning current: Int) {
        var rest = Array(0..<queue.count).filter { $0 != current }
        rest.shuffle()
        shuffledOrder = [current] + rest
        positionInShuffle = 0
    }

    private func applyVolume() {
        let preamp = activePEQProfile.map { pow(10.0, Float($0.preampDb) / 20.0) } ?? 1.0
        engine.mainMixerNode.outputVolume = preamp * volume
    }

    private func startProgressTimer() {
        progressTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            self?.pollCurrentTime()
        }
    }

    private func stopProgressTimer() {
        progressTimer?.invalidate()
        progressTimer = nil
    }

    private func pollCurrentTime() {
        guard
            let nodeTime = playerNode.lastRenderTime,
            let playerTime = playerNode.playerTime(forNodeTime: nodeTime),
            let file = currentFile
        else { return }

        let rate = file.processingFormat.sampleRate
        let t = Double(playerTime.sampleTime) / rate
        currentTime = max(0, min(t, duration))
        nowPlaying.updateElapsedTime(currentTime)
    }

    // MARK: - Audio session events

    @objc private func handleAudioInterruption(notification: Notification) {
        guard let typeValue = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else { return }
        switch type {
        case .began:
            DispatchQueue.main.async { self.isPlaying = false }
            stopProgressTimer()
        case .ended:
            let optionsValue = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)
            if options.contains(.shouldResume) { togglePlayPause() }
        @unknown default: break
        }
    }

    @objc private func handleRouteChange(notification: Notification) {
        guard let reasonValue = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue) else { return }
        // Pause on headphone unplug — standard iOS behaviour
        if reason == .oldDeviceUnavailable {
            DispatchQueue.main.async {
                if self.isPlaying { self.togglePlayPause() }
            }
        }
    }

    private func setupRemoteCommands() {
        nowPlaying.onTogglePlay = { [weak self] in
            DispatchQueue.main.async { self?.togglePlayPause() }
        }
        nowPlaying.onNext = { [weak self] in
            DispatchQueue.main.async { self?.skipNext() }
        }
        nowPlaying.onPrevious = { [weak self] in
            DispatchQueue.main.async { self?.skipPrevious() }
        }
        nowPlaying.onSeek = { [weak self] time in
            DispatchQueue.main.async { self?.seek(to: time) }
        }
    }
}
