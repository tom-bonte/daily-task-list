// Habits Rabbits menu bar item.
//
// It holds no state of its own. Actions are URLs the web app already understands
// (see applyLaunchParams in public/js/app.js), delivered with `open -g` so a
// command never steals focus.
//
// The running timers are read from a line the app publishes in a hidden element
// (publishState in public/js/app.js), through the accessibility tree: no
// account, no network, no copy of the data. That read only succeeds while the
// app's window is reachable, so between reads the clocks keep counting here and
// the last known timers stay on screen on every Space.
//
// The helper runs quietly at login, but its icon only appears while Habits
// Rabbits is open: open the app and the icon arrives, quit it and it goes.

import AppKit
import ApplicationServices
import ServiceManagement

let webAppPath = NSString(string: "~/Applications/Tasks.app").expandingTildeInPath
let site = "https://habits-rabbits.netlify.app/"

struct RunningTimer {
    var id: String
    var seconds: Int
    var category: String
    var colour: NSColor
    var task: String

    var clock: String {
        String(format: "%d:%02d:%02d", seconds / 3600, (seconds / 60) % 60, seconds % 60)
    }

    /// "45m" / "1h05" for the menu bar, where space is precious.
    var compact: String {
        seconds >= 3600 ? "\(seconds / 3600)h\(String(format: "%02d", (seconds / 60) % 60))" : "\((seconds / 60) % 60)m"
    }

    func advanced(by interval: TimeInterval) -> RunningTimer {
        var copy = self
        copy.seconds += Int(interval)
        return copy
    }
}

/// The app publishes "HRSTATE|id~1:14:11~Work~#eb6834~Finish Fuera app|id2~…".
func parseState(_ line: String) -> [RunningTimer] {
    line.components(separatedBy: "|").dropFirst().compactMap { record in
        let f = record.components(separatedBy: "~")
        guard f.count >= 5 else { return nil }
        let parts = f[1].split(separator: ":").map { Int($0) ?? 0 }
        let seconds = parts.count == 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : 0
        return RunningTimer(id: f[0], seconds: seconds, category: f[2], colour: NSColor(hex: f[3]), task: f[4])
    }
}

extension NSColor {
    convenience init(hex: String) {
        var value: UInt64 = 0
        Scanner(string: hex.trimmingCharacters(in: CharacterSet(charactersIn: "# "))).scanHexInt64(&value)
        self.init(srgbRed: CGFloat((value >> 16) & 0xff) / 255,
                  green: CGFloat((value >> 8) & 0xff) / 255,
                  blue: CGFloat(value & 0xff) / 255,
                  alpha: 1)
    }
}

/// A miniature of the timer card in the app: colour stripe and dot, task name,
/// category · clock, and a pause button. Clicking the row stops that timer.
final class TimerRow: NSView {
    private let timer: RunningTimer
    private let onStop: (String) -> Void
    private var tracking: NSTrackingArea?
    private var hovering = false

    init(timer: RunningTimer, onStop: @escaping (String) -> Void) {
        self.timer = timer
        self.onStop = onStop
        super.init(frame: NSRect(x: 0, y: 0, width: 280, height: 46))
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways], owner: self)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) { hovering = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hovering = false; needsDisplay = true }

    override func mouseUp(with event: NSEvent) {
        onStop(timer.id)
        enclosingMenuItem?.menu?.cancelTracking()
    }

    override func draw(_ dirtyRect: NSRect) {
        let inset = NSRect(x: 8, y: 2, width: bounds.width - 16, height: bounds.height - 4)
        if hovering {
            NSColor.selectedContentBackgroundColor.withAlphaComponent(0.18).setFill()
            NSBezierPath(roundedRect: inset, xRadius: 7, yRadius: 7).fill()
        }
        timer.colour.setFill()
        NSBezierPath(roundedRect: NSRect(x: inset.minX + 2, y: inset.minY + 5, width: 3, height: inset.height - 10), xRadius: 1.5, yRadius: 1.5).fill()
        NSBezierPath(ovalIn: NSRect(x: inset.minX + 12, y: bounds.midY + 4, width: 7, height: 7)).fill()

        let textX = inset.minX + 26
        let textWidth = inset.width - 26 - 40
        (timer.task as NSString).draw(
            in: NSRect(x: textX, y: bounds.midY + 1, width: textWidth, height: 17),
            withAttributes: [.font: NSFont.systemFont(ofSize: 13, weight: .semibold),
                             .foregroundColor: NSColor.labelColor])
        ("\(timer.category) · \(timer.clock)" as NSString).draw(
            in: NSRect(x: textX, y: bounds.midY - 16, width: textWidth, height: 15),
            withAttributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular),
                             .foregroundColor: NSColor.secondaryLabelColor])

        // Pause button, mirroring the round button in the app.
        let button = NSRect(x: inset.maxX - 32, y: bounds.midY - 12, width: 24, height: 24)
        timer.colour.setFill()
        NSBezierPath(ovalIn: button).fill()
        NSColor.white.setFill()
        for offset in [CGFloat(-3.5), 1.0] {
            NSBezierPath(rect: NSRect(x: button.midX + offset, y: button.midY - 5, width: 2.5, height: 10)).fill()
        }
    }
}

final class Controller: NSObject, NSApplicationDelegate, NSMenuDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let accessItem = NSMenuItem(title: "Allow timer display…", action: #selector(requestAccess), keyEquivalent: "")
    var timerItems: [NSMenuItem] = []
    var running: [RunningTimer] = []
    var readAt = Date()
    var ticks = 0
    var menuOpen = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let path = Bundle.main.path(forResource: "menubar", ofType: "png"),
           let image = NSImage(contentsOfFile: path) {
            image.isTemplate = true  // macOS recolours it for light and dark menu bars
            image.size = NSSize(width: 18, height: 18)
            item.button?.image = image
            item.button?.imagePosition = .imageLeading
        } else {
            item.button?.title = "HR"
        }

        let menu = NSMenu()
        menu.delegate = self
        accessItem.target = self
        menu.addItem(accessItem)          // only shown until permission is granted
        menu.addItem(.separator())
        add(menu, "Force update", #selector(forceUpdate))
        add(menu, "Quit Habits Rabbits", #selector(quit), key: "q", mask: [.command])
        item.menu = menu

        // Follow the app: the icon comes and goes with it.
        let center = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didTerminateApplicationNotification] {
            center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.refresh(read: true) }
        }
        enableLoginItemOnce()
        if !AXIsProcessTrusted() {
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            AXIsProcessTrustedWithOptions(options)
        }
        refresh(read: true)
        // Tick every second; re-read the app every five.
        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self else { return }
            ticks += 1
            refresh(read: ticks % 5 == 0)
        }
    }

    private func webApp() -> NSRunningApplication? {
        NSWorkspace.shared.runningApplications.first { $0.bundleURL?.path == webAppPath }
    }

    /// Stay out of the way, but be there the next time the app opens.
    private func enableLoginItemOnce() {
        guard #available(macOS 13, *) else { return }
        let key = "loginItemOffered"
        guard !UserDefaults.standard.bool(forKey: key) else { return }
        UserDefaults.standard.set(true, forKey: key)
        try? SMAppService.mainApp.register()
    }

    private func add(_ menu: NSMenu, _ title: String, _ action: Selector, key: String = "", mask: NSEvent.ModifierFlags = []) {
        let entry = NSMenuItem(title: title, action: action, keyEquivalent: key)
        entry.keyEquivalentModifierMask = mask
        entry.target = self
        menu.addItem(entry)
    }

    // MARK: reading the state the app publishes

    private func stateLine() -> String? {
        let apps = NSWorkspace.shared.runningApplications.filter {
            $0.bundleIdentifier?.hasPrefix("com.apple.Safari.WebApp") == true || $0.bundleURL?.path == webAppPath
        }
        for app in apps {
            let root = AXUIElementCreateApplication(app.processIdentifier)
            if let line = search(root, depth: 0) { return line }
        }
        return nil
    }

    /// The accessibility tree is wide, so walk it shallowly and stop at the
    /// first element the predicate accepts.
    private func find(_ element: AXUIElement, depth: Int, _ matches: (AXUIElement) -> Bool) -> AXUIElement? {
        if depth > 16 { return nil }
        if matches(element) { return element }
        var childValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childValue) == .success,
              let children = childValue as? [AXUIElement] else { return nil }
        for child in children.prefix(80) {
            if let found = find(child, depth: depth + 1, matches) { return found }
        }
        return nil
    }

    private func attribute(_ element: AXUIElement, _ name: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value as? String
    }

    private func search(_ element: AXUIElement, depth: Int) -> String? {
        find(element, depth: depth) { (attribute($0, kAXValueAttribute as String) ?? "").hasPrefix("HRSTATE") }
            .flatMap { attribute($0, kAXValueAttribute as String) }
    }

    /// Presses the pause button of that task inside the app. Far better than
    /// reopening the app with a command URL, which reloads the whole page.
    private func pressPause(for task: String) -> Bool {
        let label = "Pause \(task)"
        for app in NSWorkspace.shared.runningApplications where app.bundleURL?.path == webAppPath {
            let root = AXUIElementCreateApplication(app.processIdentifier)
            guard let button = find(root, depth: 0, { element in
                (attribute(element, kAXDescriptionAttribute as String) ?? attribute(element, kAXTitleAttribute as String) ?? "") == label
            }) else { continue }
            return AXUIElementPerformAction(button, kAXPressAction as CFString) == .success
        }
        return false
    }

    /// `read: false` only advances the clocks, which keeps the menu bar alive on
    /// Spaces where the app's window cannot be read.
    func refresh(read: Bool) {
        let appRunning = webApp() != nil
        item.isVisible = appRunning
        guard appRunning else { running = []; return }
        accessItem.isHidden = AXIsProcessTrusted()

        if read, AXIsProcessTrusted(), let line = stateLine() {
            running = parseState(line)
            readAt = Date()
        }
        if menuOpen { rebuildTimerItems(displayed()) }
    }

    private func displayed() -> [RunningTimer] {
        let elapsed = Date().timeIntervalSince(readAt)
        return running.map { $0.advanced(by: elapsed) }
    }

    /// One row per running timer, above the fixed items.
    private func rebuildTimerItems(_ timers: [RunningTimer]) {
        guard let menu = item.menu else { return }
        for entry in timerItems { menu.removeItem(entry) }
        timerItems.removeAll()

        guard !timers.isEmpty else {
            let entry = NSMenuItem(title: AXIsProcessTrusted() ? "No timer running" : "Timer display needs permission", action: nil, keyEquivalent: "")
            entry.isEnabled = false
            menu.insertItem(entry, at: 0)
            timerItems = [entry]
            return
        }

        for (index, timer) in timers.enumerated() {
            let entry = NSMenuItem()
            entry.view = TimerRow(timer: timer) { [weak self] id in self?.stopOne(id) }
            menu.insertItem(entry, at: index)
            timerItems.append(entry)
        }
        if timers.count > 1 {
            let all = NSMenuItem(title: "Stop all", action: #selector(stopAll), keyEquivalent: "")
            all.target = self
            menu.insertItem(all, at: timers.count)
            timerItems.append(all)
        }
    }

    func menuWillOpen(_ menu: NSMenu) {
        menuOpen = true
        refresh(read: true)
        rebuildTimerItems(displayed())
    }

    func menuDidClose(_ menu: NSMenu) { menuOpen = false }

    // MARK: actions

    private func stopOne(_ id: String) {
        guard let timer = running.first(where: { $0.id == id }) else { return }
        stop(tasks: [timer.task], urlFallback: "?do=stop&task=\(id)")
        running.removeAll { $0.id == id }
        refresh(read: false)
    }

    @objc private func stopAll() {
        stop(tasks: running.map(\.task), urlFallback: "?do=stop")
        running.removeAll()
        refresh(read: false)
    }

    /// Pressing the app's own pause button is instant and never reloads the
    /// page, but the accessibility tree is only served while the app's window
    /// is on the current Space. When it isn't, bring the app forward briefly,
    /// press, and hand focus straight back to where it was.
    private func stop(tasks: [String], urlFallback: String) {
        let remaining = tasks.filter { !pressPause(for: $0) }
        guard !remaining.isEmpty else { return }

        let previous = NSWorkspace.shared.frontmostApplication
        guard let app = webApp() else { return send(urlFallback) }
        app.activate()
        attemptPress(remaining, attemptsLeft: 10, previous: previous, urlFallback: urlFallback)
    }

    private func attemptPress(_ tasks: [String], attemptsLeft: Int, previous: NSRunningApplication?, urlFallback: String) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            guard let self else { return }
            let remaining = tasks.filter { !self.pressPause(for: $0) }
            if remaining.isEmpty {
                previous?.activate()
                return
            }
            if attemptsLeft <= 1 {
                previous?.activate()
                self.send(urlFallback)  // last resort: the app reloads and handles it
                return
            }
            attemptPress(remaining, attemptsLeft: attemptsLeft - 1, previous: previous, urlFallback: urlFallback)
        }
    }

    /// Loads the uncached reset page, which clears a stuck service worker.
    @objc private func forceUpdate() { send("reset.html", background: false) }

    /// Quits the app; the icon follows it out. The helper stays for next time.
    @objc private func quit() {
        webApp()?.terminate()
        item.isVisible = false
    }

    @objc private func requestAccess() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        AXIsProcessTrustedWithOptions(options)
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
    }

    private func send(_ query: String, background: Bool = true) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = (background ? ["-g"] : []) + ["-a", webAppPath, site + query]
        try? process.run()
    }
}

let app = NSApplication.shared
let controller = Controller()
app.delegate = controller
app.setActivationPolicy(.accessory)  // menu bar only, no Dock icon
app.run()
