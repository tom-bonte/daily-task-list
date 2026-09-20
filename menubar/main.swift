// Habits Rabbits menu bar item.
//
// Deliberately thin: it holds no state of its own. Every action is a URL the web
// app already understands (see applyLaunchParams in public/js/app.js), delivered
// with `open -g` so the command runs without stealing focus.

import AppKit
import ServiceManagement

let webAppPath = NSString(string: "~/Applications/Tasks.app").expandingTildeInPath
let site = "https://habits-rabbits.netlify.app/"

final class Controller: NSObject, NSApplicationDelegate, NSMenuDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let loginItem = NSMenuItem(title: "Start at login", action: #selector(toggleLogin(_:)), keyEquivalent: "")

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let path = Bundle.main.path(forResource: "menubar", ofType: "png"),
           let image = NSImage(contentsOfFile: path) {
            image.isTemplate = true  // macOS recolours it for light and dark menu bars
            image.size = NSSize(width: 18, height: 18)
            item.button?.image = image
        } else {
            item.button?.title = "HR"
        }
        item.button?.toolTip = "Habits Rabbits"

        let menu = NSMenu()
        menu.delegate = self
        add(menu, "Open Habits Rabbits", #selector(openApp), key: " ", mask: [.option])
        menu.addItem(.separator())
        add(menu, "Stop running timer", #selector(stopTimer))
        add(menu, "Today", #selector(openToday))
        add(menu, "Plan tomorrow", #selector(openTomorrow))
        add(menu, "Stats", #selector(openStats))
        menu.addItem(.separator())
        loginItem.target = self
        menu.addItem(loginItem)
        add(menu, "Quit", #selector(quit), key: "q", mask: [.command])
        item.menu = menu
    }

    private func add(_ menu: NSMenu, _ title: String, _ action: Selector, key: String = "", mask: NSEvent.ModifierFlags = []) {
        let entry = NSMenuItem(title: title, action: action, keyEquivalent: key)
        entry.keyEquivalentModifierMask = mask
        entry.target = self
        menu.addItem(entry)
    }

    // The shortcut is owned by BetterTouchTool; the menu only shows it, so keep
    // the key equivalent from firing here as well.
    func menuWillOpen(_ menu: NSMenu) {
        if #available(macOS 13, *) {
            loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
        } else {
            loginItem.isHidden = true
        }
    }

    // MARK: actions

    @objc private func openApp() { NSWorkspace.shared.open(URL(fileURLWithPath: webAppPath)) }
    @objc private func stopTimer() { send("?do=stop") }
    @objc private func openToday() { send("?date=today", background: false) }
    @objc private func openTomorrow() { send("?date=tomorrow", background: false) }
    @objc private func openStats() { send("?view=stats", background: false) }
    @objc private func quit() { NSApp.terminate(nil) }

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
