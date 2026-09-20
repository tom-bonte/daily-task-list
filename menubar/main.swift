// Habits Rabbits menu bar item.
//
// It holds no state of its own. Actions are URLs the web app already understands
// (see applyLaunchParams in public/js/app.js), delivered with `open -g` so a
// command never steals focus.
//
// The running timer is read from the web app's window title (the page keeps it
// as "▶ 0:45:03 · Task"), which needs Accessibility permission but no account,
// no network and no copy of the data.

import AppKit
import ApplicationServices
import ServiceManagement

let webAppPath = NSString(string: "~/Applications/Tasks.app").expandingTildeInPath
let site = "https://habits-rabbits.netlify.app/"

struct RunningTimer {
    var clock: String      // "0:45:03"
    var task: String?      // nil when several timers run
    var count: Int

    /// "45m" / "1h05" for the menu bar, where space is precious.
    var compact: String {
        let parts = clock.split(separator: ":").map { Int($0) ?? 0 }
        guard parts.count == 3 else { return clock }
        let label = parts[0] > 0 ? "\(parts[0])h\(String(format: "%02d", parts[1]))" : "\(parts[1])m"
        return count > 1 ? "\(label) ·\(count)" : label
    }
}

final class Controller: NSObject, NSApplicationDelegate, NSMenuDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let timerItem = NSMenuItem(title: "No timer running", action: nil, keyEquivalent: "")
    let loginItem = NSMenuItem(title: "Start at login", action: #selector(toggleLogin(_:)), keyEquivalent: "")
    let accessItem = NSMenuItem(title: "Allow timer display…", action: #selector(requestAccess), keyEquivalent: "")
    var running: RunningTimer?

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
        timerItem.target = self
        timerItem.action = #selector(stopTimer)
        menu.addItem(timerItem)
        accessItem.target = self
        menu.addItem(accessItem)
        menu.addItem(.separator())
        add(menu, "Open Habits Rabbits", #selector(openApp), key: " ", mask: [.option])
        add(menu, "Plan tomorrow", #selector(openTomorrow))
        add(menu, "Stats", #selector(openStats))
        menu.addItem(.separator())
        loginItem.target = self
        menu.addItem(loginItem)
        add(menu, "Quit", #selector(quit), key: "q", mask: [.command])
        item.menu = menu

        refresh()
        Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.refresh() }
    }

    private func add(_ menu: NSMenu, _ title: String, _ action: Selector, key: String = "", mask: NSEvent.ModifierFlags = []) {
        let entry = NSMenuItem(title: title, action: action, keyEquivalent: key)
        entry.keyEquivalentModifierMask = mask
        entry.target = self
        menu.addItem(entry)
    }

    // MARK: reading the timer from the web app's window title

    private func windowTitle() -> String? {
        let apps = NSWorkspace.shared.runningApplications.filter {
            $0.bundleIdentifier?.hasPrefix("com.apple.Safari.WebApp") == true
                || $0.bundleURL?.path == webAppPath
        }
        for app in apps {
            let element = AXUIElementCreateApplication(app.processIdentifier)
            var value: CFTypeRef?
            guard AXUIElementCopyAttributeValue(element, kAXWindowsAttribute as CFString, &value) == .success,
                  let windows = value as? [AXUIElement] else { continue }
            for window in windows {
                var titleValue: CFTypeRef?
                guard AXUIElementCopyAttributeValue(window, kAXTitleAttribute as CFString, &titleValue) == .success,
                      let title = titleValue as? String else { continue }
                if title.contains("▶") { return title }
            }
        }
        return nil
    }

    private func parse(_ title: String) -> RunningTimer? {
        let body = title.replacingOccurrences(of: "▶", with: "").trimmingCharacters(in: .whitespaces)
        if body.contains("timers running") {
            let count = Int(body.split(separator: " ").first.map(String.init) ?? "") ?? 2
            return RunningTimer(clock: "", task: nil, count: count)
        }
        let parts = body.components(separatedBy: " · ")
        guard parts.count >= 2 else { return nil }
        return RunningTimer(clock: parts[0], task: parts.dropFirst().joined(separator: " · "), count: 1)
    }

    func refresh() {
        let trusted = AXIsProcessTrusted()
        accessItem.isHidden = trusted
        running = trusted ? windowTitle().flatMap(parse) : nil

        if let running, !running.clock.isEmpty {
            item.button?.title = " " + running.compact
        } else if running != nil {
            item.button?.title = " ·\(running!.count)"
        } else {
            item.button?.title = ""
        }

        if let running {
            timerItem.title = running.task.map { "Stop “\($0)” · \(running.clock)" } ?? "Stop \(running.count) running timers"
            timerItem.isEnabled = true
            timerItem.action = #selector(stopTimer)
        } else if trusted {
            timerItem.title = NSWorkspace.shared.runningApplications.contains { $0.bundleURL?.path == webAppPath }
                ? "No timer running"
                : "Stop running timer"
            timerItem.isEnabled = true
            timerItem.action = #selector(stopTimer)
        } else {
            timerItem.title = "Stop running timer"
            timerItem.action = #selector(stopTimer)
        }
    }

    func menuWillOpen(_ menu: NSMenu) {
        refresh()
        if #available(macOS 13, *) {
            loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
        } else {
            loginItem.isHidden = true
        }
    }

    // MARK: actions

    @objc private func openApp() { NSWorkspace.shared.open(URL(fileURLWithPath: webAppPath)) }
    @objc private func stopTimer() {
        send("?do=stop")
        // Clear the menu bar straight away; the next refresh confirms it.
        running = nil
        item.button?.title = ""
    }
    @objc private func openTomorrow() { send("?date=tomorrow", background: false) }
    @objc private func openStats() { send("?view=stats", background: false) }
    @objc private func quit() { NSApp.terminate(nil) }

    @objc private func requestAccess() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        AXIsProcessTrustedWithOptions(options)
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
    }

    @objc private func toggleLogin(_ sender: NSMenuItem) {
        guard #available(macOS 13, *) else { return }
        let service = SMAppService.mainApp
        do {
            if service.status == .enabled { try service.unregister() } else { try service.register() }
        } catch {
            NSSound.beep()
        }
        sender.state = service.status == .enabled ? .on : .off
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
