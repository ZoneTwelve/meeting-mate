import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreGraphics
import AppKit
import Darwin

var eventFile = FileHandle.standardOutput

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
    eventFile.write(data + Data([10]))
}

enum CaptureError: Error, CustomStringConvertible {
    case message(String)
    var description: String { switch self { case .message(let value): return value } }
}

// One process owns one recording. The parent keeps stdin open; EOF or SIGTERM
// finalizes the file, including when the monitor crashes or is restarted.
@available(macOS 15.0, *)
final class Recorder: NSObject, SCRecordingOutputDelegate, SCStreamDelegate, @unchecked Sendable {
    var stream: SCStream?
    var output: SCRecordingOutput?
    private let lock = NSLock()
    private var stopping = false
    var signalSources: [DispatchSourceSignal] = []
    var progressTimer: DispatchSourceTimer?

    func recordingOutputDidStartRecording(_ recordingOutput: SCRecordingOutput) {
        emit(["event": "started"])
    }
    func recordingOutputDidFinishRecording(_ recordingOutput: SCRecordingOutput) {
        emit(["event": "finished", "bytes": recordingOutput.recordedFileSize,
              "seconds": recordingOutput.recordedDuration.seconds.isFinite ? recordingOutput.recordedDuration.seconds : 0])
        exit(0)
    }
    func recordingOutput(_ recordingOutput: SCRecordingOutput, didFailWithError error: Error) {
        emit(["event": "error", "message": error.localizedDescription])
        exit(1)
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        emit(["event": "error", "message": error.localizedDescription])
        stop()
    }
    func stop() {
        lock.lock()
        if stopping { lock.unlock(); return }
        stopping = true
        lock.unlock()
        Task {
            do { try await stream?.stopCapture() }
            catch { emit(["event": "error", "message": error.localizedDescription]); exit(1) }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 10) {
            emit(["event": "error", "message": "Timed out finalizing recording"])
            exit(1)
        }
    }

    @MainActor
    func start(pid: Int32, title: String, destination: String, seconds: Double, parent: Int32?, stopFile: String?) async throws {
        guard CGPreflightScreenCaptureAccess() else {
            throw CaptureError.message("Screen & System Audio Recording permission is required for Meeting Mate Recorder")
        }
        guard !FileManager.default.fileExists(atPath: destination) else {
            throw CaptureError.message("Refusing to overwrite existing recording")
        }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        let matches = content.windows.filter {
            $0.owningApplication?.processID == pid && ($0.title ?? "").contains(title) && $0.frame.width > 100
        }
        guard matches.count == 1, let window = matches.first else {
            throw CaptureError.message("Expected one Chrome window matching '\(title)', found \(matches.count)")
        }
        let config = SCStreamConfiguration()
        let ratio = min(1.0, 1440.0 / max(window.frame.width, 1))
        config.width = max(2, Int(window.frame.width * ratio) / 2 * 2)
        config.height = max(2, Int(window.frame.height * ratio) / 2 * 2)
        config.minimumFrameInterval = CMTime(value: 1, timescale: 15)
        config.queueDepth = 6
        config.capturesAudio = true
        config.sampleRate = 48000
        config.channelCount = 2
        config.captureMicrophone = false
        config.excludesCurrentProcessAudio = true
        config.showsCursor = false
        let recording = SCRecordingOutputConfiguration()
        recording.outputURL = URL(fileURLWithPath: destination)
        recording.videoCodecType = .h264
        recording.outputFileType = .mp4
        let output = SCRecordingOutput(configuration: recording, delegate: self)
        let stream = SCStream(filter: SCContentFilter(desktopIndependentWindow: window), configuration: config, delegate: self)
        self.output = output
        self.stream = stream
        try stream.addRecordingOutput(output)
        for value in [SIGINT, SIGTERM] {
            signal(value, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: value, queue: .global())
            source.setEventHandler { [weak self] in self?.stop() }
            source.resume()
            signalSources.append(source)
        }
        if parent == nil {
            DispatchQueue.global().async { [weak self] in
                while let data = try? FileHandle.standardInput.read(upToCount: 1024), !data.isEmpty {}
                self?.stop()
            }
        }
        try await stream.startCapture()
        let timer = DispatchSource.makeTimerSource(queue: .global())
        timer.schedule(deadline: .now() + 2, repeating: 2)
        timer.setEventHandler { [weak self] in
            if let parent = parent, kill(parent, 0) != 0 && errno == ESRCH { self?.stop(); return }
            if let stopFile = stopFile, FileManager.default.fileExists(atPath: stopFile) { self?.stop(); return }
            emit(["event": "progress", "bytes": output.recordedFileSize,
                  "seconds": output.recordedDuration.seconds.isFinite ? output.recordedDuration.seconds : 0])
        }
        timer.resume()
        progressTimer = timer
        if seconds > 0 { DispatchQueue.global().asyncAfter(deadline: .now() + seconds) { [weak self] in self?.stop() } }
    }
}

@main
struct Main {
    @MainActor
    static func main() async {
        let args = Array(CommandLine.arguments.dropFirst())
        func value(_ name: String) -> String? {
            guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
            return args[index + 1]
        }
        if let eventPath = value("--events") {
            guard FileManager.default.createFile(atPath: eventPath, contents: nil, attributes: [.posixPermissions: 0o600]),
                  let handle = FileHandle(forWritingAtPath: eventPath) else { exit(1) }
            eventFile = handle
        }
        if args.contains("--permission-check") { emit(["permission": CGPreflightScreenCaptureAccess()]); return }
        if args.contains("--request-permission") { emit(["permission": CGRequestScreenCaptureAccess()]); return }
        guard #available(macOS 15.0, *) else { emit(["event": "error", "message": "macOS 15+ is required"]); exit(1) }
        // Establish the AppKit/WindowServer connection before constructing an
        // SCContentFilter. CLI async-main otherwise races ReplayKit's lazy
        // NSApplication initialization and can abort in SLSGetDisplaysWithRect.
        _ = NSApplication.shared
        guard let pidText = value("--pid"), let pid = Int32(pidText), let title = value("--title"),
              !title.isEmpty, let file = value("--output") else {
            emit(["event": "error", "message": "Usage: --pid PID --title WINDOW_TITLE --output FILE [--seconds N]"])
            exit(1)
        }
        let recorder = Recorder()
        do {
            emit(["event": "process", "pid": getpid()])
            try await recorder.start(pid: pid, title: title, destination: file, seconds: Double(value("--seconds") ?? "0") ?? 0,
                                     parent: value("--parent-pid").flatMap { Int32($0) }, stopFile: value("--stop-file"))
            // Keep the recorder and its delegates alive while framework callbacks run.
            while true { try await Task.sleep(for: .seconds(1)); _ = recorder.stream }
        } catch { emit(["event": "error", "message": String(describing: error)]); exit(1) }
    }
}
