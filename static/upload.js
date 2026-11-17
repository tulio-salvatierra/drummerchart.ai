/* Upload page: send the file, show an "Analyzing…" state, then open the editor. */
(function () {
  "use strict";
  var form = document.getElementById("upload-form");
  var input = document.getElementById("file-input");
  var drop = document.getElementById("file-drop");
  var nameEl = document.getElementById("file-name");
  var button = document.getElementById("upload-button");
  var status = document.getElementById("status");
  var MAX_BYTES = 20 * 1024 * 1024;
  var timer = null;

  function setFileName() {
    nameEl.textContent = input.files.length ? input.files[0].name : "Choose an MP3, or drop it here";
    status.textContent = "";
    status.classList.remove("error");
  }
  input.addEventListener("change", setFileName);

  ["dragenter", "dragover"].forEach(function (type) {
    drop.addEventListener(type, function (e) { e.preventDefault(); drop.classList.add("over"); });
  });
  ["dragleave", "drop"].forEach(function (type) {
    drop.addEventListener(type, function (e) { e.preventDefault(); drop.classList.remove("over"); });
  });
  drop.addEventListener("drop", function (e) {
    if (e.dataTransfer.files.length) { input.files = e.dataTransfer.files; setFileName(); }
  });

  function fail(message) {
    clearInterval(timer);
    status.textContent = message;
    status.classList.add("error");
    button.disabled = false;
    button.textContent = "Analyze song";
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var file = input.files[0];
    if (!file) return;
    if (!/\.mp3$/i.test(file.name)) return fail("Only MP3 files are accepted.");
    if (file.size > MAX_BYTES) return fail("File is too large. The limit is 20 MB.");

    button.disabled = true;
    button.textContent = "Analyzing…";
    status.classList.remove("error");
    var started = Date.now();
    status.textContent = "Analyzing… finding beats, sections and time signatures.";
    timer = setInterval(function () {
      status.textContent = "Analyzing… " + Math.round((Date.now() - started) / 1000) + " s (usually under a minute)";
    }, 1000);

    fetch("/analyze", { method: "POST", body: new FormData(form) })
      .then(function (res) {
        if (res.ok && res.redirected) { window.location.href = res.url; return null; }
        return res.json().then(
          function (body) { fail(body.detail || "Something went wrong. Try another file."); },
          function () { fail("Something went wrong (" + res.status + "). Try another file."); }
        );
      })
      .catch(function () { fail("Could not reach the server. Is it still running?"); });
  });
})();
