// Talks to Firebase directly, so the menu bar can read and stop timers from any
// desktop, with or without the app open.
//
// Sign-in is the standard installed-app flow: Google OAuth with PKCE on a
// loopback address, exchanged for a Firebase session. Only the refresh token is
// kept, in the Keychain. The OAuth client id and secret live in
// ~/Library/Application Support/HabitsRabbits/oauth.json (never in the repo);
// for an installed app they are identifiers, not credentials.

import AppKit
import CryptoKit
import Foundation
import Network
import Security

private let projectId = "daily-task-list-df530"
private let webApiKey = "AIzaSyBQth3C5dlha644oF5hyTjKDPdaIfWk-7o"   // public web key
private let keychainService = "com.tombonte.habitsrabbits.menu"
private let keychainAccount = "firebase-refresh-token"

struct OAuthConfig: Decodable {
    let clientId: String
    let clientSecret: String

    static func load() -> OAuthConfig? {
        let url = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/HabitsRabbits/oauth.json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(OAuthConfig.self, from: data)
    }
}

enum Keychain {
    static func save(_ value: String) {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: keychainService,
                                    kSecAttrAccount as String: keychainAccount]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = Data(value.utf8)
        SecItemAdd(add as CFDictionary, nil)
    }

    static func read() -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: keychainService,
                                    kSecAttrAccount as String: keychainAccount,
                                    kSecReturnData as String: true]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func clear() {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword,
                       kSecAttrService as String: keychainService,
                       kSecAttrAccount as String: keychainAccount] as CFDictionary)
    }
}

/// Minimal Firestore REST client for the two documents the menu bar cares about.
final class Backend {
    private(set) var uid: String?
    private var idToken: String?
    private var idTokenExpiry = Date.distantPast
    private var refreshToken: String? { didSet { if let refreshToken { Keychain.save(refreshToken) } } }
    private var listener: NWListener?

    var isSignedIn: Bool { refreshToken != nil }

    init() {
        refreshToken = Keychain.read()
        uid = UserDefaults.standard.string(forKey: "firebaseUid")
    }

    func signOut() {
        Keychain.clear()
        refreshToken = nil
        idToken = nil
        uid = nil
    }

    // MARK: sign-in

    /// Opens the browser for Google sign-in and waits for the loopback redirect.
    func signIn(completion: @escaping (String?) -> Void) {
        guard let config = OAuthConfig.load() else {
            return completion("No OAuth client configured. See CLAUDE.md.")
        }
        let verifier = Data((0..<64).map { _ in UInt8.random(in: 33...126) }).base64URL
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URL

        let port = UInt16.random(in: 49_200...49_900)
        do {
            listener = try NWListener(using: .tcp, on: NWEndpoint.Port(rawValue: port)!)
        } catch {
            return completion("Could not open a local port: \(error.localizedDescription)")
        }
        listener?.newConnectionHandler = { [weak self] connection in
            connection.start(queue: .main)
            connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { data, _, _, _ in
                let request = String(decoding: data ?? Data(), as: UTF8.self)
                let code = request.split(separator: " ").first { $0.contains("code=") }
                    .flatMap { URLComponents(string: "http://x\($0)")?.queryItems?.first { $0.name == "code" }?.value }
                let body = "You can close this window and go back to Habits Rabbits."
                let response = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: \(body.utf8.count)\r\n\r\n\(body)"
                connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
                self?.listener?.cancel()
                self?.listener = nil
                guard let code else { return completion("Sign-in was cancelled.") }
                self?.exchange(code: code, verifier: verifier, config: config, port: port, completion: completion)
            }
        }
        listener?.start(queue: .main)

        var auth = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
        auth.queryItems = [
            .init(name: "client_id", value: config.clientId),
            .init(name: "redirect_uri", value: "http://127.0.0.1:\(port)"),
            .init(name: "response_type", value: "code"),
            .init(name: "scope", value: "openid email profile"),
            .init(name: "code_challenge", value: challenge),
            .init(name: "code_challenge_method", value: "S256"),
        ]
        NSWorkspace.shared.open(auth.url!)
    }

    private func exchange(code: String, verifier: String, config: OAuthConfig, port: UInt16, completion: @escaping (String?) -> Void) {
        let form = ["code": code,
                    "client_id": config.clientId,
                    "client_secret": config.clientSecret,
                    "code_verifier": verifier,
                    "grant_type": "authorization_code",
                    "redirect_uri": "http://127.0.0.1:\(port)"]
        post("https://oauth2.googleapis.com/token", form: form) { [weak self] json in
            guard let googleToken = json?["id_token"] as? String else {
                return completion("Google did not return a token.")
            }
            // Trade the Google identity for a Firebase session.
            let body: [String: Any] = ["postBody": "id_token=\(googleToken)&providerId=google.com",
                                       "requestUri": "http://127.0.0.1",
                                       "returnSecureToken": true]
            self?.postJSON("https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=\(webApiKey)", body: body) { json in
                guard let json, let refresh = json["refreshToken"] as? String, let uid = json["localId"] as? String else {
                    return completion("Firebase refused the sign-in.")
                }
                self?.refreshToken = refresh
                self?.idToken = json["idToken"] as? String
                self?.idTokenExpiry = Date().addingTimeInterval(3000)
                self?.uid = uid
                UserDefaults.standard.set(uid, forKey: "firebaseUid")
                completion(nil)
            }
        }
    }

    /// A valid Firebase token, refreshed when needed.
    private func token(_ completion: @escaping (String?) -> Void) {
        if let idToken, Date() < idTokenExpiry { return completion(idToken) }
        guard let refreshToken else { return completion(nil) }
        post("https://securetoken.googleapis.com/v1/token?key=\(webApiKey)",
             form: ["grant_type": "refresh_token", "refresh_token": refreshToken]) { [weak self] json in
            guard let token = json?["id_token"] as? String else { return completion(nil) }
            self?.idToken = token
            self?.idTokenExpiry = Date().addingTimeInterval(3000)
            if let uid = json?["user_id"] as? String {
                self?.uid = uid
                UserDefaults.standard.set(uid, forKey: "firebaseUid")
            }
            completion(token)
        }
    }

    // MARK: Firestore

    private func documentURL(_ path: String) -> URL {
        URL(string: "https://firestore.googleapis.com/v1/projects/\(projectId)/databases/(default)/documents/\(path)")!
    }

    private func get(_ path: String, completion: @escaping ([String: Any]?) -> Void) {
        token { token in
            guard let token else { return completion(nil) }
            var request = URLRequest(url: self.documentURL(path))
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            URLSession.shared.dataTask(with: request) { data, _, _ in
                let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
                DispatchQueue.main.async { completion(json) }
            }.resume()
        }
    }

    private func patch(_ path: String, fields: [String: Any], mask: [String], completion: @escaping (Bool) -> Void) {
        token { token in
            guard let token else { return completion(false) }
            var components = URLComponents(url: self.documentURL(path), resolvingAgainstBaseURL: false)!
            components.queryItems = mask.map { URLQueryItem(name: "updateMask.fieldPaths", value: $0) }
            var request = URLRequest(url: components.url!)
            request.httpMethod = "PATCH"
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: ["fields": fields])
            URLSession.shared.dataTask(with: request) { _, response, _ in
                let ok = (response as? HTTPURLResponse)?.statusCode == 200
                DispatchQueue.main.async { completion(ok) }
            }.resume()
        }
    }

    /// Running timers, straight from the user's settings document.
    func fetchRunning(completion: @escaping ([RunningTimer]) -> Void) {
        guard let uid else { return completion([]) }
        get("users/\(uid)/meta/settings") { json in
            guard let fields = json?["fields"] as? [String: Any] else { return completion([]) }
            let categories = (Firestore.array(fields["categories"]) ?? []).compactMap { Firestore.map($0) }
            let now = Date().timeIntervalSince1970 * 1000
            let timers: [RunningTimer] = (Firestore.array(fields["running"]) ?? []).compactMap { entry in
                guard let run = Firestore.map(entry),
                      let id = Firestore.string(run["id"]),
                      let text = Firestore.string(run["text"]),
                      let started = Firestore.number(run["s"]) else { return nil }
                let base = Firestore.number(run["base"]) ?? 0
                let catId = Firestore.string(run["cat"]) ?? ""
                let category = categories.first { Firestore.string($0["id"]) == catId }
                let slot = Int(Firestore.number(category?["slot"]) ?? 0)
                return RunningTimer(id: id,
                                    seconds: Int((base + now - started) / 1000),
                                    category: Firestore.string(category?["name"]) ?? "",
                                    colour: NSColor(hex: paletteHex(slot)),
                                    task: text,
                                    date: Firestore.string(run["date"]) ?? "")
            }
            completion(timers)
        }
    }

    /// Closes the open session of that task and drops it from the running list,
    /// mirroring stopRunning + tidySessions in the web app.
    func stop(timer: RunningTimer, completion: @escaping (Bool) -> Void) {
        guard let uid else { return completion(false) }
        let now = Date().timeIntervalSince1970 * 1000
        get("users/\(uid)/days/\(timer.date)") { json in
            guard var fields = json?["fields"] as? [String: Any],
                  var tasks = Firestore.array(fields["tasks"]) else { return completion(false) }
            guard let index = tasks.firstIndex(where: { Firestore.string(Firestore.map($0)?["id"]) == timer.id }),
                  var task = Firestore.map(tasks[index]),
                  var sessions = Firestore.array(task["sessions"]), !sessions.isEmpty else { return completion(false) }

            guard let openIndex = sessions.lastIndex(where: { Firestore.map($0)?["e"] as? [String: Any] == nil || (Firestore.map($0)?["e"] as? [String: Any])?["nullValue"] != nil }) else {
                return completion(false)
            }
            var session = Firestore.map(sessions[openIndex]) ?? [:]
            let started = Firestore.number(session["s"]) ?? now
            if now - started < 60_000 {
                sessions.remove(at: openIndex)          // under a minute: not logged
            } else {
                session["e"] = ["doubleValue": now]
                sessions[openIndex] = ["mapValue": ["fields": session]]
            }
            task["sessions"] = ["arrayValue": ["values": sessions]]
            tasks[index] = ["mapValue": ["fields": task]]
            fields["tasks"] = ["arrayValue": ["values": tasks]]

            self.patch("users/\(uid)/days/\(timer.date)", fields: ["tasks": fields["tasks"]!], mask: ["tasks"]) { ok in
                guard ok else { return completion(false) }
                self.removeFromRunning(uid: uid, id: timer.id, completion: completion)
            }
        }
    }

    private func removeFromRunning(uid: String, id: String, completion: @escaping (Bool) -> Void) {
        get("users/\(uid)/meta/settings") { json in
            guard let fields = json?["fields"] as? [String: Any] else { return completion(false) }
            let remaining = (Firestore.array(fields["running"]) ?? []).filter {
                Firestore.string(Firestore.map($0)?["id"]) != id
            }
            self.patch("users/\(uid)/meta/settings",
                       fields: ["running": ["arrayValue": ["values": remaining]]],
                       mask: ["running"],
                       completion: completion)
        }
    }

    // MARK: small HTTP helpers

    private func post(_ url: String, form: [String: String], completion: @escaping ([String: Any]?) -> Void) {
        var request = URLRequest(url: URL(string: url)!)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(form.map { "\($0.key)=\($0.value.formEncoded)" }.joined(separator: "&").utf8)
        send(request, completion: completion)
    }

    private func postJSON(_ url: String, body: [String: Any], completion: @escaping ([String: Any]?) -> Void) {
        var request = URLRequest(url: URL(string: url)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        send(request, completion: completion)
    }

    private func send(_ request: URLRequest, completion: @escaping ([String: Any]?) -> Void) {
        URLSession.shared.dataTask(with: request) { data, _, _ in
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
            DispatchQueue.main.async { completion(json) }
        }.resume()
    }
}

/// Unwrapping Firestore's typed JSON ({"stringValue": "x"} and friends).
enum Firestore {
    static func map(_ value: Any?) -> [String: Any]? {
        ((value as? [String: Any])?["mapValue"] as? [String: Any])?["fields"] as? [String: Any]
    }
    static func array(_ value: Any?) -> [Any]? {
        ((value as? [String: Any])?["arrayValue"] as? [String: Any])?["values"] as? [Any] ?? []
    }
    static func string(_ value: Any?) -> String? {
        (value as? [String: Any])?["stringValue"] as? String
    }
    static func number(_ value: Any?) -> Double? {
        guard let dict = value as? [String: Any] else { return nil }
        if let d = dict["doubleValue"] as? Double { return d }
        if let i = dict["integerValue"] as? String { return Double(i) }
        if let i = dict["integerValue"] as? Int { return Double(i) }
        return nil
    }
}

/// The same categorical palette the app uses (light steps).
func paletteHex(_ slot: Int) -> String {
    let hues = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"]
    if slot <= 0 { return "#a3a29b" }
    return hues[(slot - 1) % 8]
}

extension Data {
    var base64URL: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

extension String {
    var formEncoded: String {
        addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? self
    }
}
