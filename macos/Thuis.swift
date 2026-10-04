import AppKit
import WebKit

private var home: URL = {
    let value = UserDefaults.standard.string(forKey: "ServerURL") ?? "http://localhost:8771/"
    guard let url = URL(string: value), url.user == nil, url.password == nil,
          url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(url.host ?? "")) else {
        return URL(string: "http://localhost:8771/")!
    }
    return url
}()
private func isHome(_ url: URL?) -> Bool {
    guard let url = url else { return false }
    return url.scheme == home.scheme && url.host == home.host && url.port == home.port
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, URLSessionTaskDelegate, WKDownloadDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var timer: Timer?
    var pollBusy = false
    var badgeRevision = 0
    var activity: NSObjectProtocol?
    var fileDownloads: [WKDownload] = []
    lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.timeoutIntervalForRequest = 12
        return URLSession(configuration: config, delegate: self, delegateQueue: .main)
    }()

    func applicationDidFinishLaunching(_ notification: Notification) {
        makeMenu()
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.userContentController.add(self, name: "thuisBadge")
        config.userContentController.addUserScript(WKUserScript(source: "window.__thuisMacActive = false;", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 840), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Thuis"
        window.minSize = NSSize(width: 380, height: 520)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.contentView = web
        window.setFrameAutosaveName("ThuisMainWindow")
        if !window.setFrameUsingName("ThuisMainWindow") { window.center() }
        web.load(URLRequest(url: home))
        showWindow()
        // Keep only the count poll awake; allow the Mac itself to sleep normally.
        activity = ProcessInfo.processInfo.beginActivity(options: .userInitiatedAllowingIdleSystemSleep, reason: "Ongelezen chatberichten op het Thuis-icoon bijwerken")
        timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in self?.pollBadge() }
        timer?.tolerance = 2
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(woke), name: NSWorkspace.didWakeNotification, object: nil)
    }

    func makeMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu(); appItem.submenu = appMenu
        appMenu.addItem(withTitle: "Over Thuis", action: #selector(about), keyEquivalent: "")
        appMenu.addItem(withTitle: "Serveradres…", action: #selector(changeServer), keyEquivalent: ",")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Verberg Thuis", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Stop Thuis", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let edit = NSMenuItem(); main.addItem(edit); edit.submenu = NSMenu(title: "Bewerken")
        for (title, action, key) in [("Herstel", "undo:", "z"), ("Knip", "cut:", "x"), ("Kopieer", "copy:", "c"), ("Plak", "paste:", "v"), ("Selecteer alles", "selectAll:", "a")] {
            edit.submenu?.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        let view = NSMenuItem(); main.addItem(view); view.submenu = NSMenu(title: "Venster")
        view.submenu?.addItem(withTitle: "Toon Thuis", action: #selector(showWindow), keyEquivalent: "0")
        view.submenu?.addItem(withTitle: "Ververs", action: #selector(reload), keyEquivalent: "r")
        view.submenu?.addItem(withTitle: "Minimaliseer", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        view.submenu?.addItem(withTitle: "Sluit venster", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        NSApp.mainMenu = main
    }
    @objc func changeServer() {
        let alert = NSAlert(); alert.messageText = "Jouw Thuis-server"
        alert.informativeText = "Gebruik HTTPS voor je eigen server of http://localhost:8771/ op deze Mac."
        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 380, height: 24)); input.stringValue = home.absoluteString
        alert.accessoryView = input; alert.addButton(withTitle: "Opslaan"); alert.addButton(withTitle: "Annuleren")
        guard alert.runModal() == .alertFirstButtonReturn,
              let url = URL(string: input.stringValue), url.host != nil, url.user == nil, url.password == nil,
              url.path == "/" || url.path.isEmpty, url.query == nil, url.fragment == nil,
              url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(url.host ?? "")) else { return }
        home = url; UserDefaults.standard.set(url.absoluteString, forKey: "ServerURL")
        badgeRevision += 1; setBadge(0); web.load(URLRequest(url: home))
    }
    @objc func about() {
        let alert = NSAlert()
        alert.messageText = "Thuis — samen thuis"
        alert.informativeText = "Jullie gezinsdashboard, met het aantal ongelezen chatberichten op het Dock-icoon.\n\nSluit het venster gerust: Thuis blijft het cijfer bijwerken. Na Stop Thuis (⌘Q) begint dat weer zodra je de app opent. Hiervoor moet je ingelogd zijn en internet hebben."
        alert.addButton(withTitle: "Oké"); alert.runModal()
    }
    @objc func showWindow() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        updateActive(); pollBadge()
    }
    @objc func reload() { web.reload() }
    @objc func woke() { pollBadge() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showWindow(); return true }
    func applicationDidBecomeActive(_ notification: Notification) { updateActive(); pollBadge() }
    func applicationDidResignActive(_ notification: Notification) { updateActive() }
    func windowDidBecomeKey(_ notification: Notification) { updateActive() }
    func windowDidResignKey(_ notification: Notification) { updateActive() }
    func windowDidMiniaturize(_ notification: Notification) { updateActive() }
    func windowDidDeminiaturize(_ notification: Notification) { updateActive() }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil); updateActive(); return false
    }
    func updateActive() {
        guard web != nil, window != nil, isHome(web.url) else { return }
        let active = NSApp.isActive && window.isVisible && !window.isMiniaturized && window.isKeyWindow
        web.evaluateJavaScript("window.__thuisMacActive = \(active ? "true" : "false"); window.dispatchEvent(new Event('thuis-app-visibility'));", completionHandler: nil)
    }
    func setBadge(_ value: Int) {
        let count = max(0, value)
        NSApp.dockTile.badgeLabel = count == 0 ? nil : (count > 99 ? "99+" : String(count))
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, isHome(message.frameInfo.request.url), message.name == "thuisBadge", let count = message.body as? Int else { return }
        badgeRevision += 1
        setBadge(count)
    }
    func pollBadge() {
        guard web != nil, !pollBusy else { return }
        pollBusy = true
        let revision = badgeRevision
        web.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
            guard let self = self else { return }
            let auth = cookies.filter { $0.name == "family_session" && $0.domain == home.host && (home.scheme == "http" || $0.isSecure) && ($0.expiresDate == nil || $0.expiresDate! > Date()) }
            guard !auth.isEmpty else { self.pollBusy = false; if revision == self.badgeRevision { self.setBadge(0) }; return }
            var request = URLRequest(url: home.appendingPathComponent("api/chat/unread"), cachePolicy: .reloadIgnoringLocalCacheData)
            request.allHTTPHeaderFields = HTTPCookie.requestHeaderFields(with: auth)
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            self.session.dataTask(with: request) { [weak self] data, response, error in
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    self.pollBusy = false
                    guard revision == self.badgeRevision, error == nil, let response = response as? HTTPURLResponse else { return }
                    if response.statusCode == 401 || response.statusCode == 403 { self.setBadge(0); return }
                    guard response.statusCode == 200, let data = data,
                          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let count = object["unread"] as? Int else { return }
                    self.setBadge(count)
                }
            }.resume()
        }
    }
    // Never forward the private session cookie through an HTTP redirect.
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { updateActive(); pollBadge() }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if isHome(url) {
            decisionHandler(navigationAction.shouldPerformDownload ? .download : .allow); return
        }
        let embedHosts: Set<String> = ["www.youtube-nocookie.com", "player.vimeo.com", "open.spotify.com", "docs.google.com", "www.google.com"]
        if navigationAction.targetFrame?.isMainFrame == false, url.scheme == "https", embedHosts.contains(url.host ?? ""), url.user == nil, url.password == nil, url.port == nil || url.port == 443 {
            decisionHandler(.allow); return
        }
        if ["https", "http", "mailto", "tel"].contains(url.scheme ?? "") && navigationAction.navigationType == .linkActivated { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            if isHome(url) && (url.path.hasPrefix("/api/files/") || url.path.hasPrefix("/api/chat/files/")) {
                // Use the authenticated WK cookie store; an external browser has a separate login.
                webView.startDownload(using: navigationAction.request) { [weak self] download in
                    guard let self = self else { return }
                    self.fileDownloads.append(download); download.delegate = self
                }
            } else if ["https", "http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        }
        return nil
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        fileDownloads.append(download); download.delegate = self
    }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        guard let response = response as? HTTPURLResponse, response.statusCode == 200, isHome(response.url) else {
            completionHandler(nil); fileDownloads.removeAll { $0 === download }
            let alert = NSAlert(); alert.messageText = "Het bestand is niet beschikbaar. Log zo nodig opnieuw in."
            alert.beginSheetModal(for: window); return
        }
        let panel = NSSavePanel(); panel.nameFieldStringValue = suggestedFilename
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.url : nil) }
    }
    func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void) {
        decisionHandler(.cancel)
    }
    func downloadDidFinish(_ download: WKDownload) { fileDownloads.removeAll { $0 === download } }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        fileDownloads.removeAll { $0 === download }
        if (error as NSError).code == NSURLErrorCancelled { return }
        let alert = NSAlert(); alert.messageText = "Download mislukt. Probeer het bestand opnieuw."
        alert.beginSheetModal(for: window)
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert(); alert.messageText = message; alert.addButton(withTitle: "Oké")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = message; alert.addButton(withTitle: "Doorgaan"); alert.addButton(withTitle: "Annuleren")
        alert.beginSheetModal(for: window) { response in completionHandler(response == .alertFirstButtonReturn) }
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert(); alert.messageText = prompt; alert.addButton(withTitle: "Opslaan"); alert.addButton(withTitle: "Annuleren")
        let input = NSTextField(string: defaultText ?? ""); input.frame = NSRect(x: 0, y: 0, width: 300, height: 24); alert.accessoryView = input
        alert.beginSheetModal(for: window) { response in completionHandler(response == .alertFirstButtonReturn ? input.stringValue : nil) }
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel(); panel.allowsMultipleSelection = parameters.allowsMultipleSelection; panel.canChooseDirectories = parameters.allowsDirectories
        panel.beginSheetModal(for: window) { response in completionHandler(response == .OK ? panel.urls : nil) }
    }
    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate(); session.invalidateAndCancel()
        if let activity = activity { ProcessInfo.processInfo.endActivity(activity) }
    }
}
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
