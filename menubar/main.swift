// Habits Rabbits menu bar item.
//
// It holds no state of its own. Actions are URLs the web app already understands
// (see applyLaunchParams in public/js/app.js), delivered with `open -g` so a
// command never steals focus.
//
// The running timer is read from the web app's window title (the page keeps it
// as "▶ 0:45:03 · Task"), which needs Accessibility permission but no account,
// no network and no copy of the data.
//
// The helper itself runs quietly at login, but its menu bar icon only appears
// while Habits Rabbits is open: open the app and the icon arrives, quit the app
// (or choose Quit here) and it disappears.

import AppKit
import ApplicationServices
import ServiceManagement

let webAppPath = NSString(string: "~/Applications/Tasks.app").expandingTildeInPath
let site = "https://habits-rabbits.netlify.app/"

struct RunningTimer {
    var id: String
    var clock: String       // "1:14:11"
    var category: String
    var colour: NSColor
    var task: String

    /// "45m" / "1h05" for the menu bar, where space is precious.
    var compact: String {
        let parts = clock.split(separator: ":").map { Int($0) ?? 0 }
        guard parts.count == 3 else { return clock }
        return parts[0] > 0 ? "\(parts[0])h\(String(format: "%02d", parts[1]))" : "\(parts[1])m"
    }
}

/// The web app keeps a line like
/// "HRSTATE|id~1:14:11~Work~#eb6834~Finish Fuera app|id2~…" in a hidden element;
/// see publishState in public/js/app.js.
func parseState(_ line: String) -> [RunningTimer] {
    line.components(separatedBy: "|").dropFirst().compactMap { record in
        let f = record.components(separatedBy: "~")
        guard f.count >= 5 else { return nil }
        return RunningTimer(id: f[0], clock: f[1], category: f[2], colour: NSColor(hex: f[3]), task: f[4])
    }
}

extension NSColor {
    convenience init(hex: String) {
        var value: UInt64 = 0
        Scanner(string: hex.trimmingCharacters(in: CharacterSet(charactersIn: "# "))).scanHexInt64(&value)
        self.init(srgbRed: CGFloat((value >> 16) & 0xff) / 255,
                  green: CGFloat((value >> 8) & 0xff) / 255,
                  blue: CGFloat(value & 0xff) / 255,
                  alpha: value == 0 ? 0 : 1)
    }

    /// A small filled circle, like the pulse dot in the app.
    func dot(size: CGFloat = 9) -> NSImage {
        let image = NSImage(size: NSSize(width: size + 6, height: size))
        image.lockFocus()
        setFill()
        NSBezierPath(ovalIn: NSRect(x: 0, y: 0, width: size, height: size)).fill()
        image.unlockFocus()
        return image
    }
}

final class Controller: NSObject, NSApplicationDelegate, NSMenuDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    var timerItems: [NSMenuItem] = []
    let accessItem = NSMenuItem(title: "Allow timer display…", action: #selector(requestAccess), keyEquivalent: "")
    var running: [RunningTimer] = []

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
            center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.refresh() }
        }
        enableLoginItemOnce()
        if !AXIsProcessTrusted() {
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            AXIsProcessTrustedWithOptions(options)
        }
        refresh()
        Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.refresh() }
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

    // MARK: reading the state the web app publishes

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

    /// Breadth of the accessibility tree is large, so walk it shallowly and stop
    /// at the first element whose text is the published state.
    private func search(_ element: AXUIElement, depth: Int) -> String? {
        if depth > 14 { return nil }
        var value: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value) == .success,
           let text = value as? String, text.hasPrefix("HRSTATE") {
            return text
        }
        var childValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childValue) == .success,
              let children = childValue as? [AXUIElement] else { return nil }
        for child in children.prefix(60) {
            if let found = search(child, depth: depth + 1) { return found }
        }
        return nil
    }

    func refresh() {
        let appRunning = webApp() != nil
        item.isVisible = appRunning  // no app, no icon
        guard appRunning else { return }
        let trusted = AXIsProcessTrusted()
        accessItem.isHidden = trusted
        running = trusted ? (stateLine().map(parseState) ?? []) : []

        switch running.count {
        case 0: item.button?.title = ""
        case 1: item.button?.title = " " + running[0].compact
        default: item.button?.title = " " + running.map(\.compact).joined(separator: " · ")
        }
        rebuildTimerItems()
    }

    /// One menu entry per running timer, styled like the cards in the app.
    private func rebuildTimerItems() {
        guard let menu = item.menu else { return }
        for entry in timerItems { menu.removeItem(entry) }
        timerItems.removeAll()

        if running.isEmpty {
            let entry = NSMenuItem(title: AXIsProcessTrusted() ? "No timer running" : "Stop running timer", action: nil, keyEquivalent: "")
            if !AXIsProcessTrusted() {
                entry.action = #selector(stopAll)
                entry.target = self
            }
            entry.isEnabled = !AXIsProcessTrusted()
            menu.insertItem(entry, at: 0)
            timerItems = [entry]
            return
        }

        for (index, timer) in running.enumerated() {
            let entry = NSMenuItem(title: "", action: #selector(stopOne(_:)), keyEquivalent: "")
            entry.target = self
            entry.representedObject = timer.id
            entry.image = timer.colour.dot()
            entry.attributedTitle = card(for: timer)
            menu.insertItem(entry, at: index)
            timerItems.append(entry)
        }
        if running.count > 1 {
            let all = NSMenuItem(title: "Stop all", action: #selector(stopAll), keyEquivalent: "")
            all.target = self
            menu.insertItem(all, at: running.count)
            timerItems.append(all)
        }
    }

    private func card(for timer: RunningTimer) -> NSAttributedString {
        let title = NSMutableAttributedString(
            string: timer.task + "\n",
            attributes: [.font: NSFont.systemFont(ofSize: 13, weight: .semibold)])
        title.append(NSAttributedString(
            string: "\(timer.category) · \(timer.clock)",
            attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular),
                         .foregroundColor: NSColor.secondaryLabelColor]))
        return title
    }

    func menuWillOpen(_ menu: NSMenu) { refresh() }

    // MARK: actions

    @objc private func stopOne(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        send("?do=stop&task=\(id)")
        running.removeAll { $0.id == id }
        refreshTitleOnly()
    }

    @objc private func stopAll() {
        send("?do=stop")
        running.removeAll()
        refreshTitleOnly()
    }

    /// The web app needs a moment to write the new state; keep the bar honest meanwhile.
    private func refreshTitleOnly() {
        item.button?.title = running.isEmpty ? "" : " " + running.map(\.compact).joined(separator: " · ")
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
