/**
 * assets/desktop/main.js
 *
 * Hash-only router for the ClipRuler desktop shell.
 *
 * Design (Plan 011, Design #2534):
 * - Hash-only router: parses location.hash for #/devices, #/status, #/pair
 * - All rendering goes through window.__clipruler.invoke() calls
 * - FORBIDDEN: window reload, href assignment, post-startup navigate
 * - REQUIRED: beforeunload clears window.__clipruler (bindings loss trap)
 */

(function () {
  "use strict";

  var app = document.getElementById("app");

  /**
   * Render a simple error message without any navigation.
   * @param {string} msg
   */
  function renderError(msg) {
    app.innerHTML = '<p class="error">' + escapeHtml(msg) + "</p>";
  }

  /**
   * Escape HTML special characters to prevent XSS.
   * @param {string} s
   * @returns {string}
   */
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /**
   * Render the devices view — polls admin.list every 3 seconds.
   */
  function renderDevices() {
    app.innerHTML = "<h2>Devices</h2><div id=\"device-list\">Loading...</div>";
    var list = document.getElementById("device-list");

    function load() {
      if (!window.__clipruler) {
        list.innerHTML = "<p class=\"error\">Bindings not available.</p>";
        return;
      }
      window.__clipruler
        .invoke("admin.list", {})
        .then(function (response) {
          if (!response || response.status !== "ok") {
            list.innerHTML =
              "<p class=\"error\">Error: " +
              escapeHtml(response && response.message
                ? response.message
                : "unknown") +
              "</p>";
            return;
          }
          var devices = response.data && response.data.devices
            ? response.data.devices
            : [];
          if (devices.length === 0) {
            list.innerHTML = "<p>No devices paired.</p>";
            return;
          }
          list.innerHTML = devices.map(function (d) {
            return (
              '<div class="device">' +
              escapeHtml(d.name || d.id || "unknown") +
              " — " +
              escapeHtml(d.status || "unknown") +
              "</div>"
            );
          }).join("");
        })
        .catch(function (err) {
          list.innerHTML = "<p class=\"error\">" + escapeHtml(String(err)) + "</p>";
        });
    }

    load();
    // 3-second polling per DWB-3.1
    setInterval(load, 3000);
  }

  /**
   * Render the status view.
   */
  function renderStatus() {
    app.innerHTML = "<h2>Status</h2><div id=\"status-view\">Loading...</div>";
    var view = document.getElementById("status-view");

    if (!window.__clipruler) {
      view.innerHTML = "<p class=\"error\">Bindings not available.</p>";
      return;
    }

    window.__clipruler
      .invoke("admin.list", {})
      .then(function (response) {
        if (!response || response.status !== "ok") {
          view.innerHTML = "<p>Daemon unreachable.</p>";
          return;
        }
        var port = response.data && response.data.port;
        view.innerHTML =
          "<p>Running on :" + escapeHtml(String(port || "?")) + "</p>";
      })
      .catch(function () {
        view.innerHTML = "<p>Daemon unreachable.</p>";
      });
  }

  /**
   * Render the pair view — surfaces not_implemented placeholder.
   */
  function renderPair() {
    app.innerHTML =
      "<h2>Pair</h2>" +
      "<div id=\"pair-view\">" +
      "<button id=\"btn-pair\">Start Pairing</button>" +
      "<div id=\"pair-result\"></div>" +
      "</div>";
    var result = document.getElementById("pair-result");
    var btn = document.getElementById("btn-pair");

    btn.addEventListener("click", function () {
      if (!window.__clipruler) {
        result.innerHTML = "<p class=\"error\">Bindings not available.</p>";
        return;
      }
      result.innerHTML = "<p>Initiating pairing...</p>";
      window.__clipruler
        .invoke("admin.pair.request", {})
        .then(function (response) {
          if (
            response && response.status === "error" &&
            (response.message === "not_implemented" ||
              (response.data && response.data.code === "not_implemented"))
          ) {
            result.innerHTML =
              "<p>Pairing not yet implemented — use a future version.</p>";
          } else {
            result.innerHTML = "<p>Pairing response: " +
              escapeHtml(JSON.stringify(response)) + "</p>";
          }
        })
        .catch(function (err) {
          result.innerHTML = "<p class=\"error\">" +
            escapeHtml(String(err)) + "</p>";
        });
    });
  }

  /** @type {Record<string, () => void>} */
  var routes = {
    "#/devices": renderDevices,
    "#/status": renderStatus,
    "#/pair": renderPair,
  };

  /**
   * Parse location.hash and dispatch to the appropriate handler.
   * Default: #/devices if no hash is set.
   */
  function dispatch() {
    var hash = location.hash || "#/devices";
    var handler = routes[hash];
    if (handler) {
      handler();
    } else {
      // Unknown route — fall back to devices without changing the hash
      routes["#/devices"]();
    }
  }

  // Initial render
  dispatch();

  // Re-render on hash changes (back/forward button support)
  window.addEventListener("hashchange", dispatch);

  // Bindings loss trap: clear __clipruler on page unload so the
  // facade re-registers cleanly on the next load.
  window.addEventListener("beforeunload", function () {
    window.__clipruler = undefined;
  });
})();
