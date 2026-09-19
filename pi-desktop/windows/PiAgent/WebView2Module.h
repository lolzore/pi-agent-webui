#pragma once

// ---------------------------------------------------------------------------
// PiWebView: a WebView2-backed browser surface for the Pi Agent Windows app.
//
// Why a native module instead of react-native-webview:
//
//   react-native-webview's windows/ target is a legacy UWP project
//   (ApplicationType "Windows Store") and cannot link into this WinAppSDK /
//   New Architecture app, and react-native-windows 0.84 ships no WebView
//   component of its own.
//
// What this gives the app:
//
//   A real Chromium surface (the same engine Edge uses) hosted in a child HWND
//   of the app's main window. It is a top-level browsing context, so the
//   `X-Frame-Options: DENY` header Instagram and TikTok send does not apply and
//   their infinite feeds load the way they do in the mobile app.
//
// How it works:
//
//   The module owns one child window and one CoreWebView2Controller. JS calls
//   open()/setBounds()/navigate()/close(); every one of those marshals onto the
//   UI dispatcher, because both CreateWindowEx and WebView2 must run on the
//   thread that owns the window. WebView2's user-data folder is shared with
//   nothing else, so a login made inside the panel persists across launches.
//
// Bounds come from JS in device-independent pixels and are scaled by the
// window's DPI here, so the RN layout maths stays in DIPs like everywhere else.
// ---------------------------------------------------------------------------

#include "pch.h"

#include "NativeModules.h"

#include <WebView2.h>
#include <wrl.h>

#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace PiAgent {

// The child window class. Registered once, on first use.
static const wchar_t *kWebViewHostClass = L"PiAgent.WebView2Host";
static const wchar_t *kMainWindowTitle = L"PiAgent";

class PiWebViewController {
 public:
  // Surfaces are NAMED, so the app can show a feed beside the WebUI instead of
  // navigating away from it:
  //
  //   "main"   the WebUI itself, positioned by the React Native layer
  //   "shorts" a docked Instagram / TikTok / YouTube feed, created on demand
  //            when the WebUI asks for one (see HandlePageMessage)
  //
  // Each surface owns one child HWND and one CoreWebView2Controller.
  static PiWebViewController &Instance(const std::wstring &id) {
    static std::mutex mutex;
    static std::map<std::wstring, std::unique_ptr<PiWebViewController>> instances;
    std::lock_guard<std::mutex> lock(mutex);
    auto &slot = instances[id];
    if (!slot) slot.reset(new PiWebViewController(id));
    return *slot;
  }

  // Creates (or reuses) the host window and points the WebView at `url`.
  void Open(
      const std::string &url,
      double x,
      double y,
      double width,
      double height,
      const std::string &userAgent) {
    OpenW(Utf8ToWide(url), x, y, width, height, Utf8ToWide(userAgent));
  }

  /** Same as Open() but without the UTF-8 round trip (used from page messages). */
  void OpenW(
      const std::wstring &url,
      double x,
      double y,
      double width,
      double height,
      const std::wstring &userAgent) {
    m_pendingUrl = url;
    m_pendingUserAgent = userAgent;
    EnsureHostWindow();
    SetBoundsDip(x, y, width, height);
    if (m_controller) {
      Navigate(m_pendingUrl);
    } else if (!m_creating) {
      CreateWebView();
    }
  }

  void SetBounds(double x, double y, double width, double height) {
    SetBoundsDip(x, y, width, height);
  }

  void Navigate(const std::string &url) {
    Navigate(Utf8ToWide(url));
  }

  void Reload() {
    if (m_webview) m_webview->Reload();
  }

  void GoBack() {
    if (!m_webview) return;
    BOOL canGo = FALSE;
    m_webview->get_CanGoBack(&canGo);
    if (canGo) m_webview->GoBack();
  }

  void Close() {
    if (m_controller) {
      m_controller->Close();
      m_controller = nullptr;
      m_webview = nullptr;
    }
    if (m_host) {
      DestroyWindow(m_host);
      m_host = nullptr;
    }
    m_creating = false;
  }

  bool IsOpen() const {
    return m_host != nullptr;
  }

  /** This surface's origin in DIP, relative to the app window's client area. */
  double DipX() const {
    return m_dip.x;
  }
  double DipY() const {
    return m_dip.y;
  }

 private:
  explicit PiWebViewController(std::wstring id) : m_id(std::move(id)) {}

  static std::wstring Utf8ToWide(const std::string &s) {
    if (s.empty()) return {};
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), nullptr, 0);
    std::wstring out(static_cast<size_t>(n), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), out.data(), n);
    return out;
  }

  void EnsureHostWindow() {
    if (m_host) return;

    static std::once_flag classOnce;
    std::call_once(classOnce, []() {
      WNDCLASSEXW wc = {};
      wc.cbSize = sizeof(wc);
      wc.lpfnWndProc = &PiWebViewController::HostWndProc;
      wc.hInstance = GetModuleHandleW(nullptr);
      wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
      wc.hbrBackground = nullptr;  // WebView2 paints everything
      wc.lpszClassName = kWebViewHostClass;
      RegisterClassExW(&wc);
    });

    // The React Native window. Its title is set in PiAgent.cpp.
    HWND parent = FindWindowW(nullptr, kMainWindowTitle);
    if (!parent) parent = GetActiveWindow();
    if (!parent) return;

    m_host = CreateWindowExW(
        0,
        kWebViewHostClass,
        L"",
        WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
        0,
        0,
        10,
        10,
        parent,
        nullptr,
        GetModuleHandleW(nullptr),
        this);

    if (m_host) ShowWindow(m_host, SW_SHOW);
  }

  static LRESULT CALLBACK HostWndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    if (msg == WM_NCCREATE) {
      auto cs = reinterpret_cast<CREATESTRUCTW *>(lParam);
      SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(cs->lpCreateParams));
    }
    return DefWindowProcW(hwnd, msg, wParam, lParam);
  }

  double DpiScale() const {
    HWND reference = m_host ? m_host : FindWindowW(nullptr, kMainWindowTitle);
    if (!reference) return 1.0;
    UINT dpi = GetDpiForWindow(reference);
    return dpi ? static_cast<double>(dpi) / 96.0 : 1.0;
  }

  // Bounds from JS are device-independent pixels; RECT uses left/top/right/bottom
  // in physical pixels, so keep them apart rather than overloading one type.
  struct DipBounds {
    double x = 0;
    double y = 0;
    double w = 400;
    double h = 700;
  };

  void SetBoundsDip(double x, double y, double width, double height) {
    m_dip = {x, y, width, height};
    if (!m_host) return;
    const double scale = DpiScale();
    int px = static_cast<int>(x * scale);
    int py = static_cast<int>(y * scale);
    int pw = static_cast<int>(width * scale);
    int ph = static_cast<int>(height * scale);
    if (pw < 1) pw = 1;
    if (ph < 1) ph = 1;
    SetWindowPos(m_host, HWND_TOP, px, py, pw, ph, SWP_NOACTIVATE);
    if (m_controller) {
      RECT bounds = {0, 0, pw, ph};
      m_controller->put_Bounds(bounds);
    }
  }

  void CreateWebView() {
    if (m_creating || !m_host) return;
    m_creating = true;

    // Per-user data folder so logins in the panel persist between runs.
    std::wstring userData = UserDataFolder();

    using namespace Microsoft::WRL;
    auto envHandler = Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
        [this](HRESULT hr, ICoreWebView2Environment *env) -> HRESULT {
          if (FAILED(hr) || !env) {
            m_creating = false;
            return S_OK;
          }
          m_env = env;

          auto controllerHandler = Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
              [this](HRESULT hr2, ICoreWebView2Controller *controller) -> HRESULT {
                m_creating = false;
                if (FAILED(hr2) || !controller) return S_OK;
                m_controller = controller;

                if (SUCCEEDED(m_controller->get_CoreWebView2(&m_webview)) && m_webview) {
                  if (!m_pendingUserAgent.empty()) {
                    // UserAgent lives on the Settings2 interface, not Settings.
                    ComPtr<ICoreWebView2Settings> settings;
                    ComPtr<ICoreWebView2Settings2> settings2;
                    if (SUCCEEDED(m_webview->get_Settings(&settings)) && settings &&
                        SUCCEEDED(settings.As(&settings2)) && settings2) {
                      settings2->put_UserAgent(m_pendingUserAgent.c_str());
                    }
                  }
                  // `window.open` (and target=_blank) must become a REAL top-level
                  // WebView2 window, not a navigation of this surface.
                  //
                  // It used to `put_Handled(TRUE)` and navigate this same webview,
                  // which threw the WebUI away the moment its Reels panel asked for
                  // a feed. More importantly, a popup is its own top-level browsing
                  // context, so the `X-Frame-Options: DENY` that Instagram and
                  // TikTok send does not apply and their infinite feeds actually
                  // load -- which is the whole point of the Reels panel.
                  m_webview->add_NewWindowRequested(
                      Callback<ICoreWebView2NewWindowRequestedEventHandler>(
                          [this](ICoreWebView2 *, ICoreWebView2NewWindowRequestedEventArgs *args) -> HRESULT {
                            // Left unhandled on purpose: WebView2 creates the popup
                            // using the window features the page asked for.
                            args->put_Handled(FALSE);
                            return S_OK;
                          })
                          .Get(),
                      &m_newWindowToken);

                  // Messages from the page: how the WebUI asks the app to dock a
                  // real feed beside itself. An iframe cannot do this (Instagram
                  // and TikTok send X-Frame-Options: DENY) but a second child
                  // HWND is a top-level browsing context, so it can.
                  m_webview->add_WebMessageReceived(
                      Callback<ICoreWebView2WebMessageReceivedEventHandler>(
                          [this](ICoreWebView2 *, ICoreWebView2WebMessageReceivedEventArgs *args) -> HRESULT {
                            LPWSTR raw = nullptr;
                            if (SUCCEEDED(args->TryGetWebMessageAsString(&raw)) && raw) {
                              HandlePageMessage(raw);
                              CoTaskMemFree(raw);
                            }
                            return S_OK;
                          })
                          .Get(),
                      &m_messageToken);
                }

                // Re-apply the current size (the window may already be sized).
                SetBoundsDip(m_dip.x, m_dip.y, m_dip.w, m_dip.h);
                if (m_controller) m_controller->put_IsVisible(TRUE);
                Navigate(m_pendingUrl);
                return S_OK;
              });

          env->CreateCoreWebView2Controller(m_host, controllerHandler.Get());
          return S_OK;
        });

    HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(
        nullptr, userData.empty() ? nullptr : userData.c_str(), nullptr, envHandler.Get());
    if (FAILED(hr)) m_creating = false;
  }

  void Navigate(const std::wstring &url) {
    if (url.empty()) return;
    if (m_webview) {
      m_webview->Navigate(url.c_str());
      return;
    }
    // Not created yet — CreateWebView() will pick up m_pendingUrl.
    m_pendingUrl = url;
  }

  static std::vector<std::wstring> Split(const std::wstring &s, wchar_t sep) {
    std::vector<std::wstring> out;
    std::wstring cur;
    for (wchar_t c : s) {
      if (c == sep) {
        out.push_back(cur);
        cur.clear();
      } else {
        cur.push_back(c);
      }
    }
    out.push_back(cur);
    return out;
  }

  /*
   * Wire protocol from the page (kept to a `|`-separated line so it needs no
   * JSON parser on this side):
   *
   *   piagent|shorts|open|x|y|w|h|url     create/repoint the docked feed surface
   *   piagent|shorts|rect|x|y|w|h         move/resize it (splitter dragged,
   *                                       window resized, panel toggled)
   *   piagent|shorts|close                destroy it
   *
   * x/y are relative to THIS surface's viewport (they come straight from
   * getBoundingClientRect()), so add this surface's own origin to get window
   * coordinates.
   */
  void HandlePageMessage(const std::wstring &raw) {
    const auto parts = Split(raw, L'|');
    if (parts.size() < 3 || parts[0] != L"piagent" || parts[1] != L"shorts") return;

    auto &shorts = PiWebViewController::Instance(L"shorts");
    const std::wstring &action = parts[2];
    if (action == L"close") {
      shorts.Close();
      return;
    }
    if (parts.size() < 7) return;

    const double x = wcstod(parts[3].c_str(), nullptr);
    const double y = wcstod(parts[4].c_str(), nullptr);
    const double w = wcstod(parts[5].c_str(), nullptr);
    const double h = wcstod(parts[6].c_str(), nullptr);
    if (w < 1 || h < 1) return;

    const double ox = DipX();
    const double oy = DipY();

    if (action == L"rect") {
      shorts.SetBounds(ox + x, oy + y, w, h);
      return;
    }
    if (action == L"open") {
      const std::wstring url = parts.size() > 7 ? parts[7] : std::wstring();
      shorts.OpenW(url, ox + x, oy + y, w, h, std::wstring());
    }
  }

  static std::wstring UserDataFolder() {
    wchar_t *local = nullptr;
    size_t len = 0;
    std::wstring folder;
    if (_wdupenv_s(&local, &len, L"LOCALAPPDATA") == 0 && local) {
      folder = std::wstring(local) + L"\\PiAgent\\WebView2";
      free(local);
    }
    return folder;
  }

  HWND m_host = nullptr;
  std::wstring m_id;
  DipBounds m_dip;
  bool m_creating = false;
  std::wstring m_pendingUrl;
  std::wstring m_pendingUserAgent;

  Microsoft::WRL::ComPtr<ICoreWebView2Environment> m_env;
  Microsoft::WRL::ComPtr<ICoreWebView2Controller> m_controller;
  Microsoft::WRL::ComPtr<ICoreWebView2> m_webview;
  EventRegistrationToken m_newWindowToken = {};
  EventRegistrationToken m_messageToken = {};
};

REACT_MODULE(PiWebView)
struct PiWebView {
  REACT_INIT(Initialize)
  void Initialize(winrt::Microsoft::ReactNative::ReactContext const &reactContext) noexcept {
    m_context = reactContext;
  }

  // Opens (or re-points) the embedded browser at `url`, docked at the given
  // device-independent-pixel rectangle inside the app window.
  REACT_METHOD(Open, L"open")
  void Open(
      std::string url,
      double x,
      double y,
      double width,
      double height,
      std::string userAgent) noexcept {
    auto &controller = PiWebViewController::Instance(L"main");
    m_context.UIDispatcher().Post([&controller, url, x, y, width, height, userAgent]() {
      controller.Open(url, x, y, width, height, userAgent);
    });
  }

  REACT_METHOD(SetBounds, L"setBounds")
  void SetBounds(double x, double y, double width, double height) noexcept {
    auto &controller = PiWebViewController::Instance(L"main");
    m_context.UIDispatcher().Post([&controller, x, y, width, height]() {
      controller.SetBounds(x, y, width, height);
    });
  }

  REACT_METHOD(Navigate, L"navigate")
  void Navigate(std::string url) noexcept {
    auto &controller = PiWebViewController::Instance(L"main");
    m_context.UIDispatcher().Post([&controller, url]() { controller.Navigate(url); });
  }

  REACT_METHOD(Reload, L"reload")
  void Reload() noexcept {
    auto &controller = PiWebViewController::Instance(L"main");
    m_context.UIDispatcher().Post([&controller]() { controller.Reload(); });
  }

  REACT_METHOD(GoBack, L"goBack")
  void GoBack() noexcept {
    auto &controller = PiWebViewController::Instance(L"main");
    m_context.UIDispatcher().Post([&controller]() { controller.GoBack(); });
  }

  REACT_METHOD(Close, L"close")
  void Close() noexcept {
    auto &controller = PiWebViewController::Instance(L"main");
    m_context.UIDispatcher().Post([&controller]() { controller.Close(); });
  }

  REACT_SYNC_METHOD(IsOpen, L"isOpen")
  bool IsOpen() noexcept {
    return PiWebViewController::Instance(L"main").IsOpen();
  }

 private:
  winrt::Microsoft::ReactNative::ReactContext m_context{nullptr};
};

}  // namespace PiAgent
