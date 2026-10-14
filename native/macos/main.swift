// meeting-tap — streams system audio output as raw PCM (s16le, mono, 16 kHz) on stdout.
// Status and errors are JSON lines on stderr. Exits when stdin closes (i.e. when Obsidian goes away).
//
// macOS 14.4+: Core Audio process tap on all processes + private aggregate device.

import AVFoundation
import CoreAudio
import Darwin
import Foundation

let OUT_RATE: Double = 16000

func emit(_ obj: [String: Any]) {
	guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
	FileHandle.standardError.write(data)
	FileHandle.standardError.write("\n".data(using: .utf8)!)
}

func fail(_ message: String, _ status: OSStatus = 0) -> Never {
	emit(["event": "error", "message": message, "status": Int(status)])
	exit(1)
}

// ─── Responsibility disclaim ───
// When launched by Obsidian, macOS attributes the audio-capture permission to Obsidian, which
// lacks the usage description. Re-spawning ourselves "disclaimed" makes this binary its own
// responsible process, so the TCC prompt (and the embedded Info.plist) are ours.
func respawnDisclaimed() -> Never? {
	if ProcessInfo.processInfo.environment["MEETING_TAP_CHILD"] != nil { return nil }
	typealias Disclaim = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32
	guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim") else {
		return nil
	}
	let disclaim = unsafeBitCast(sym, to: Disclaim.self)
	var attr: posix_spawnattr_t?
	posix_spawnattr_init(&attr)
	_ = disclaim(&attr, 1)
	let path = CommandLine.arguments[0]
	let resolved = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
	var argv: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) } + [nil]
	var env = ProcessInfo.processInfo.environment
	env["MEETING_TAP_CHILD"] = "1"
	var envp: [UnsafeMutablePointer<CChar>?] = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
	var pid: pid_t = 0
	let rc = posix_spawn(&pid, resolved, nil, &attr, &argv, &envp)
	if rc != 0 { return nil }
	// Forward termination to the child.
	for sig in [SIGTERM, SIGINT, SIGHUP] {
		signal(sig, SIG_IGN)
		let src = DispatchSource.makeSignalSource(signal: sig)
		src.setEventHandler { kill(pid, SIGTERM) }
		src.resume()
		_ = Unmanaged.passRetained(src)
	}
	DispatchQueue.global().async {
		var status: Int32 = 0
		waitpid(pid, &status, 0)
		exit((status >> 8) & 0xff)
	}
	dispatchMain()
}

// ─── Core Audio helpers ───
func getProp<T>(_ obj: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T) -> (OSStatus, T) {
	var addr = AudioObjectPropertyAddress(
		mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
	var value = initial
	var size = UInt32(MemoryLayout<T>.size)
	let st = withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, $0) }
	return (st, value)
}

func defaultOutputUID() -> String {
	let (st, dev) = getProp(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultOutputDevice, AudioObjectID(0))
	if st != noErr { fail("No default output device", st) }
	var addr = AudioObjectPropertyAddress(
		mSelector: kAudioDevicePropertyDeviceUID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
	var uid: Unmanaged<CFString>?
	var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
	let st2 = AudioObjectGetPropertyData(dev, &addr, 0, nil, &size, &uid)
	if st2 != noErr || uid == nil { fail("Cannot read output device UID", st2) }
	return uid!.takeRetainedValue() as String
}

// ─── Decode mode: `--decode <file>` streams any audio file as s16le 16 kHz mono ───
func decodeFile(_ path: String) -> Never {
	signal(SIGPIPE, SIG_IGN)
	let url = URL(fileURLWithPath: path)
	let file: AVAudioFile
	do {
		file = try AVAudioFile(forReading: url)
	} catch {
		// QuickTime containers (Voice Memos `.qta`, `.mov`) are not audio files for AVAudioFile.
		decodeAsset(url)
	}
	guard let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: OUT_RATE, channels: 1, interleaved: true),
		let converter = AVAudioConverter(from: file.processingFormat, to: outFormat)
	else { fail("Unsupported audio format") }
	converter.downmix = true
	let total = file.length
	emit(["event": "started", "sampleRate": Int(OUT_RATE), "channels": 1, "format": "s16le",
		"sourceRate": file.processingFormat.sampleRate, "sourceChannels": Int(file.processingFormat.channelCount),
		"frames": Int(total)])
	let inCap: AVAudioFrameCount = 65536
	guard let inBuf = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: inCap) else { fail("Out of memory") }
	let outCap = AVAudioFrameCount(Double(inCap) * OUT_RATE / file.processingFormat.sampleRate) + 4096
	let stdout = FileHandle.standardOutput
	var eof = false
	var readError: Error?
	var lastReport = 0.0
	while !eof {
		guard let outBuf = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: outCap) else { fail("Out of memory") }
		var convError: NSError?
		let status = converter.convert(to: outBuf, error: &convError) { _, outStatus in
			if eof { outStatus.pointee = .endOfStream; return nil }
			do {
				inBuf.frameLength = 0
				try file.read(into: inBuf, frameCount: inCap)
			} catch {
				// -39 (eofErr): some decoders throw on the last partial read instead of returning short.
				if (error as NSError).code != -39 { readError = error }
				eof = true
				if inBuf.frameLength == 0 {
					outStatus.pointee = .endOfStream
					return nil
				}
				outStatus.pointee = .haveData
				return inBuf
			}
			if inBuf.frameLength == 0 {
				eof = true
				outStatus.pointee = .endOfStream
				return nil
			}
			outStatus.pointee = .haveData
			return inBuf
		}
		if let e = readError { fail("Cannot read the file: \(e.localizedDescription)") }
		if status == .error { fail("Cannot convert the audio: \(convError?.localizedDescription ?? "?")") }
		if outBuf.frameLength > 0, let data = outBuf.int16ChannelData {
			stdout.write(Data(bytes: data[0], count: Int(outBuf.frameLength) * 2))
		}
		let ratio = total > 0 ? Double(file.framePosition) / Double(total) : 1
		if ratio - lastReport >= 0.02 || eof {
			lastReport = ratio
			emit(["event": "progress", "ratio": min(1, ratio)])
		}
		if status == .endOfStream { break }
	}
	emit(["event": "done"])
	exit(0)
}

/// Fallback for containers AVAudioFile can't open: AVAssetReader mixes every audio track to s16le 16 kHz mono.
func decodeAsset(_ url: URL) -> Never {
	let asset = AVURLAsset(url: url)
	let sem = DispatchSemaphore(value: 0)
	var tracks: [AVAssetTrack] = []
	var duration = 0.0
	Task {
		tracks = (try? await asset.loadTracks(withMediaType: .audio)) ?? []
		duration = (try? await asset.load(.duration).seconds) ?? 0
		sem.signal()
	}
	sem.wait()
	guard !tracks.isEmpty else { fail("No audio track in the file") }
	let reader: AVAssetReader
	do { reader = try AVAssetReader(asset: asset) } catch { fail("Cannot open the audio file: \(error.localizedDescription)") }
	let output = AVAssetReaderAudioMixOutput(audioTracks: tracks, audioSettings: [
		AVFormatIDKey: kAudioFormatLinearPCM,
		AVSampleRateKey: OUT_RATE,
		AVNumberOfChannelsKey: 1,
		AVLinearPCMBitDepthKey: 16,
		AVLinearPCMIsFloatKey: false,
		AVLinearPCMIsBigEndianKey: false,
		AVLinearPCMIsNonInterleaved: false,
	])
	guard reader.canAdd(output) else { fail("Unsupported audio format") }
	reader.add(output)
	guard reader.startReading() else { fail("Cannot read the file: \(reader.error?.localizedDescription ?? "?")") }
	emit(["event": "started", "sampleRate": Int(OUT_RATE), "channels": 1, "format": "s16le", "frames": Int(duration * OUT_RATE)])
	let stdout = FileHandle.standardOutput
	var written = 0.0
	var lastReport = 0.0
	while let sample = output.copyNextSampleBuffer() {
		guard let block = CMSampleBufferGetDataBuffer(sample) else { continue }
		let length = CMBlockBufferGetDataLength(block)
		var data = Data(count: length)
		data.withUnsafeMutableBytes { _ = CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: $0.baseAddress!) }
		stdout.write(data)
		written += Double(length / 2) / OUT_RATE
		let ratio = duration > 0 ? min(1, written / duration) : 0
		if ratio - lastReport >= 0.02 {
			lastReport = ratio
			emit(["event": "progress", "ratio": ratio])
		}
	}
	if reader.status == .failed { fail("Cannot read the file: \(reader.error?.localizedDescription ?? "?")") }
	emit(["event": "progress", "ratio": 1])
	emit(["event": "done"])
	exit(0)
}

// ─── Main ───
if CommandLine.arguments.contains("--version") {
	print("meeting-tap 0.1.0")
	exit(0)
}
if let i = CommandLine.arguments.firstIndex(of: "--decode"), i + 1 < CommandLine.arguments.count {
	decodeFile(CommandLine.arguments[i + 1])
}
respawnDisclaimed()

guard #available(macOS 14.4, *) else { fail("macOS 14.4 or later is required for system audio capture") }

let tapDesc = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
tapDesc.uuid = UUID()
tapDesc.name = "Muesli tap"
tapDesc.isPrivate = true
tapDesc.muteBehavior = .unmuted

var tapID = AudioObjectID(kAudioObjectUnknown)
var st = AudioHardwareCreateProcessTap(tapDesc, &tapID)
if st != noErr { fail("Cannot create process tap (permission denied?)", st) }

let outputUID = defaultOutputUID()
let aggDesc: [String: Any] = [
	kAudioAggregateDeviceNameKey: "Muesli capture",
	kAudioAggregateDeviceUIDKey: UUID().uuidString,
	kAudioAggregateDeviceMainSubDeviceKey: outputUID,
	kAudioAggregateDeviceIsPrivateKey: true,
	kAudioAggregateDeviceIsStackedKey: false,
	kAudioAggregateDeviceTapAutoStartKey: true,
	kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
	kAudioAggregateDeviceTapListKey: [
		[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: tapDesc.uuid.uuidString]
	],
]
var aggID = AudioObjectID(kAudioObjectUnknown)
st = AudioHardwareCreateAggregateDevice(aggDesc as CFDictionary, &aggID)
if st != noErr { fail("Cannot create aggregate device", st) }

func cleanup() {
	AudioHardwareDestroyAggregateDevice(aggID)
	AudioHardwareDestroyProcessTap(tapID)
}

let (fst, asbd) = getProp(tapID, kAudioTapPropertyFormat, AudioStreamBasicDescription())
if fst != noErr { cleanup(); fail("Cannot read tap format", fst) }
if asbd.mFormatID != kAudioFormatLinearPCM || asbd.mFormatFlags & kAudioFormatFlagIsFloat == 0 || asbd.mBitsPerChannel != 32 {
	cleanup(); fail("Unsupported tap format")
}
// The tap's advertised format can disagree with the rate the output device actually runs at
// (e.g. 48 kHz advertised, 44.1 kHz delivered); the aggregate device's nominal rate is the truth.
let (rst, deviceRate) = getProp(aggID, kAudioDevicePropertyNominalSampleRate, Float64(0))
var srcRate = rst == noErr && deviceRate > 0 ? deviceRate : asbd.mSampleRate
let channels = Int(max(1, asbd.mChannelsPerFrame))
let nonInterleaved = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0

// Downmix + decimate by averaging over each output period (stateful across callbacks, so no
// sample is ever dropped or duplicated). Plenty for speech at 16 kHz.
let ratio = srcRate / OUT_RATE
var phase = 0.0
var written = 0
var acc: Float = 0
var accCount = 0

let stdout = FileHandle.standardOutput
let ioQueue = DispatchQueue(label: "meeting-tap.io", qos: .userInitiated)
let debug = ProcessInfo.processInfo.environment["MEETING_TAP_DEBUG"] != nil
let debugStart = Date()
var procID: AudioDeviceIOProcID?
st = AudioDeviceCreateIOProcIDWithBlock(&procID, aggID, ioQueue) { _, inData, _, _, _ in
	let abl = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inData))
	guard abl.count > 0, let first = abl[0].mData else { return }
	let frames: Int
	var planes: [UnsafePointer<Float>] = []
	if nonInterleaved {
		frames = Int(abl[0].mDataByteSize) / 4
		for i in 0..<min(channels, abl.count) {
			if let d = abl[i].mData { planes.append(UnsafePointer(d.assumingMemoryBound(to: Float.self))) }
		}
	} else {
		frames = Int(abl[0].mDataByteSize) / (4 * channels)
	}
	if frames == 0 { return }
	if debug {
		var peak: Float = 0
		let fp = UnsafePointer(first.assumingMemoryBound(to: Float.self))
		for i in 0..<(Int(abl[0].mDataByteSize) / 4) { peak = max(peak, abs(fp[i])) }
		emit(["event": "debug", "t": Date().timeIntervalSince(debugStart), "buffers": abl.count, "bytes": Int(abl[0].mDataByteSize), "ch0": Int(abl[0].mNumberChannels), "frames": frames, "peak": Double(peak)])
	}
	let interleaved = UnsafePointer(first.assumingMemoryBound(to: Float.self))
	var out = [Int16]()
	out.reserveCapacity(Int(Double(frames) / ratio) + 2)
	for f in 0..<frames {
		var v: Float = 0
		if nonInterleaved {
			for p in planes { v += p[f] }
			v /= Float(max(1, planes.count))
		} else {
			for c in 0..<channels { v += interleaved[f * channels + c] }
			v /= Float(channels)
		}
		acc += v
		accCount += 1
		phase += 1
		if phase >= ratio {
			phase -= ratio
			let m = max(-1, min(1, acc / Float(accCount)))
			out.append(Int16(m < 0 ? m * 32768 : m * 32767))
			acc = 0
			accCount = 0
		}
	}
	if out.isEmpty { return }
	written += out.count
	out.withUnsafeBytes { stdout.write(Data($0)) }
}
if st != noErr { cleanup(); fail("Cannot create IO proc", st) }

st = AudioDeviceStart(aggID, procID)
if st != noErr { cleanup(); fail("Cannot start capture", st) }
// Core Audio only calls us while something plays. Fill the gaps with silence so the stream
// always matches the wall clock (the plugin relies on sample count = meeting time).
let wallStart = DispatchTime.now()
let filler = DispatchSource.makeTimerSource(queue: ioQueue)
filler.schedule(deadline: .now() + 0.2, repeating: 0.1)
filler.setEventHandler {
	let elapsed = Double(DispatchTime.now().uptimeNanoseconds - wallStart.uptimeNanoseconds) / 1e9
	let expected = Int(elapsed * OUT_RATE)
	let missing = expected - written - Int(OUT_RATE * 0.15)
	if missing > 0 {
		if debug { emit(["event": "fill", "t": elapsed, "samples": missing]) }
		written += missing
		stdout.write(Data(count: missing * 2))
		phase = 0
		acc = 0
		accCount = 0
	}
}
filler.resume()
emit(["event": "started", "sampleRate": Int(OUT_RATE), "channels": 1, "format": "s16le", "sourceRate": srcRate, "sourceChannels": channels])

func stop(_ code: Int32) -> Never {
	AudioDeviceStop(aggID, procID)
	if let p = procID { AudioDeviceDestroyIOProcID(aggID, p) }
	cleanup()
	emit(["event": "stopped"])
	exit(code)
}

signal(SIGPIPE, SIG_IGN)
for sig in [SIGTERM, SIGINT, SIGHUP] {
	signal(sig, SIG_IGN)
	let src = DispatchSource.makeSignalSource(signal: sig)
	src.setEventHandler { stop(0) }
	src.resume()
	_ = Unmanaged.passRetained(src)
}
// Stop when the parent closes our stdin.
Thread.detachNewThread {
	var buf = [UInt8](repeating: 0, count: 256)
	while read(0, &buf, buf.count) > 0 {}
	stop(0)
}
// Optional duration for testing: --seconds N
if let i = CommandLine.arguments.firstIndex(of: "--seconds"), i + 1 < CommandLine.arguments.count,
	let secs = Double(CommandLine.arguments[i + 1])
{
	DispatchQueue.main.asyncAfter(deadline: .now() + secs) { stop(0) }
}
dispatchMain()
