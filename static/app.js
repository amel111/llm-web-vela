"use strict";
(function () {
  var CONF = window.TEMPER || {};
  var convId = CONF.convId || null;
  var settings = CONF.settings || {};
  var currentModel = CONF.model || settings.model || "";

  var appEl = document.getElementById("app");
  var threadEl = document.getElementById("thread");
  var emptyEl = document.getElementById("emptyState");
  var ta = document.getElementById("composerInput");
  var sendBtn = document.getElementById("sendBtn");
  var sidebarList = document.getElementById("convList");

  var rows = [];
  var streamActive = false;
  var controller = null;

  // ---------- theme ----------
  var theme = localStorage.getItem("temper-theme") || "light";
  document.documentElement.setAttribute("data-theme", theme);

  function paintThemeBtn() {
    var b = document.getElementById("themeBtn");
    if (!b) return;
    var sun = b.querySelector(".icon-sun");
    var moon = b.querySelector(".icon-moon");
    if (sun) sun.style.display = theme === "dark" ? "none" : "";
    if (moon) moon.style.display = theme === "dark" ? "" : "none";
  }
  paintThemeBtn();

  function toggleTheme() {
    theme = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("temper-theme", theme);
    paintThemeBtn();
  }
  var themeBtn = document.getElementById("themeBtn");
  if (themeBtn) themeBtn.addEventListener("click", toggleTheme);

  // ---------- sidebar ----------
  var hamburger = document.getElementById("hamburger");
  var collapsed = localStorage.getItem("temper-collapsed") === "1";
  if (collapsed) appEl.classList.add("collapsed");

  function toggleSidebar() {
    if (window.matchMedia("(max-width: 767px)").matches) {
      appEl.classList.toggle("nav-open");
    } else {
      collapsed = !collapsed;
      appEl.classList.toggle("collapsed", collapsed);
      localStorage.setItem("temper-collapsed", collapsed ? "1" : "0");
    }
  }
  if (hamburger) hamburger.addEventListener("click", toggleSidebar);
  var scrim = document.getElementById("scrim");
  if (scrim) scrim.addEventListener("click", function () { appEl.classList.remove("nav-open"); });

  var newChatBtn = document.getElementById("newChatBtn");
  if (newChatBtn) newChatBtn.addEventListener("click", function () {
    location.href = "/";
  });

  // conversations: search + menus
  var searchInput = document.getElementById("convSearch");
  if (searchInput) searchInput.addEventListener("input", function () {
    var q = searchInput.value.toLowerCase();
    var items = sidebarList.querySelectorAll(".conv-item");
    for (var i = 0; i < items.length; i++) {
      var t = items[i].querySelector(".conv-title");
      items[i].style.display = !q || (t && t.textContent.toLowerCase().indexOf(q) !== -1) ? "" : "none";
    }
  });

  function closeMenus() {
    var menus = sidebarList.querySelectorAll(".conv-menu");
    for (var i = 0; i < menus.length; i++) menus[i].style.display = "none";
  }
  document.addEventListener("click", function () { closeMenus(); });

  if (sidebarList) sidebarList.addEventListener("click", function (e) {
    var item = e.target.closest(".conv-item");
    if (!item) return;
    var menuBtn = e.target.closest(".conv-menu-btn");
    var menu = item.querySelector(".conv-menu");
    if (menuBtn) {
      e.preventDefault();
      e.stopPropagation();
      var open = menu && menu.style.display === "block";
      closeMenus();
      if (menu && !open) menu.style.display = "block";
      return;
    }
    if (e.target.closest(".conv-menu")) {
      e.preventDefault();
      e.stopPropagation();
      if (e.target.closest(".act-rename")) startRename(item);
      if (e.target.closest(".act-delete")) deleteConv(+item.dataset.id, item);
      return;
    }
  });

  function startRename(item) {
    var id = +item.dataset.id;
    var titleEl = item.querySelector(".conv-title");
    if (!titleEl || item.querySelector(".conv-rename")) return;
    var old = titleEl.textContent;
    var input = document.createElement("input");
    input.className = "conv-rename";
    input.value = old;
    item.insertBefore(input, titleEl);
    titleEl.style.display = "none";
    input.focus();
    input.select();
    var done = false;
    function save() {
      if (done) return;
      done = true;
      var val = input.value.trim() || old;
      fetch("/api/conversations/" + id + "/rename", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: val })
      }).then(function () {
        titleEl.textContent = val;
        cleanup();
      }).catch(function () { cleanup(); });
    }
    function cleanup() {
      if (input.parentNode) item.removeChild(input);
      titleEl.style.display = "";
    }
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); save(); }
      else if (e.key === "Escape") { done = true; cleanup(); }
    });
    input.addEventListener("blur", save);
    var inner = item.querySelector(".conv-menu");
    if (inner) inner.style.display = "none";
  }

  function deleteConv(id, item) {
    if (!window.confirm("Delete this conversation?")) return;
    fetch("/api/conversations/" + id, { method: "DELETE" }).then(function () {
      if (id === convId) location.href = "/";
      else item.remove();
    });
  }

  function insertConvItem(id, title) {
    var sec = sidebarList.querySelector('[data-group="Today"]');
    if (!sec) {
      sec = document.createElement("div");
      var label = document.createElement("div");
      label.className = "conv-group";
      label.textContent = "Today";
      sidebarList.appendChild(label);
      sec = document.createElement("div");
      sec.setAttribute("data-group", "Today");
      sidebarList.appendChild(sec);
    }
    var a = document.createElement("a");
    a.className = "conv-item active";
    a.href = "/chat/" + id;
    a.dataset.id = id;
    a.innerHTML = '<span class="conv-title"></span>';
    a.querySelector(".conv-title").textContent = title;
    var others = sec.querySelectorAll(".conv-item");
    for (var i = 0; i < others.length; i++) others[i].classList.remove("active");
    sec.insertBefore(a, sec.firstChild);
    sidebarList.scrollTop = 0;
  }

  // ---------- model picker ----------
  function fillDropdown(dd) {
    return fetch("/api/models").then(function (r) { return r.json(); }).then(function (d) {
      dd.innerHTML = "";
      var list = (d.data || []).map(function (m) { return m.id; });
      if (!list.length) list = [currentModel];
      for (var i = 0; i < list.length; i++) {
        var b = document.createElement("button");
        b.type = "button";
        b.textContent = list[i];
        if (list[i] === currentModel) b.className = "selected";
        b.addEventListener("click", function (name) {
          return function () {
            currentModel = name;
            fetch("/api/settings", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: name })
            }).then(function () {
              var lbl = document.getElementById("modelName");
              if (lbl) lbl.textContent = name;
              dd.style.display = "none";
              snack("Model: " + name);
            });
          };
        }(list[i]));
        dd.appendChild(b);
      }
    }).catch(function () {});
  }
  var modelBtn = document.getElementById("modelBtn");
  var modelDropdown = document.getElementById("modelDropdown");
  if (modelBtn && modelDropdown) {
    modelBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (modelDropdown.style.display === "block") { modelDropdown.style.display = "none"; return; }
      modelDropdown.style.display = "block";
      fillDropdown(modelDropdown);
    });
    document.addEventListener("click", function () { modelDropdown.style.display = "none"; });
    modelDropdown.addEventListener("click", function (e) { e.stopPropagation(); });
  }

  // ---------- markdown pipeline ----------
  var rafPending = false;
  var rafHandle = null;

  function md(text) {
    return DOMPurify.sanitize(marked.parse(text));
  }

  function splitOpenFence(text) {
    var idx = text.lastIndexOf("```");
    if (idx === -1) return { head: text, tail: null };
    var before = text.slice(0, idx);
    var fences = (before.match(/```/g) || []).length;
    if (fences % 2 === 1) return { head: text, tail: null };
    return { head: before, tail: text.slice(idx) };
  }

  function renderInto(el, text) {
    var parts = splitOpenFence(text);
    var html = md(parts.head);
    if (parts.tail !== null) html += '<pre class="pending-code"><code></code></pre>';
    el.innerHTML = html;
    if (parts.tail !== null) {
      var code = el.querySelector(".pending-code code");
      if (code) code.textContent = parts.tail;
    }
  }

  function finalize(el, text) {
    if (rafPending && rafHandle !== null) cancelAnimationFrame(rafHandle);
    rafPending = false;
    el.innerHTML = md(text || "");
    var blocks = el.querySelectorAll("pre code");
    for (var i = 0; i < blocks.length; i++) {
      try { hljs.highlightElement(blocks[i]); } catch (e) {}
    }
    addCopyButtons(el);
  }

  function scheduleRender(el, text) {
    if (rafPending) return;
    rafPending = true;
    rafHandle = requestAnimationFrame(function () {
      rafPending = false;
      renderInto(el, text);
      if (followStream) forceScrollBottom();
    });
  }

  // ---------- copy (message + code blocks) ----------
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(text); });
    }
    return legacyCopy(text);
  }
  function legacyCopy(text) {
    return new Promise(function (resolve, reject) {
      try {
        var t = document.createElement("textarea");
        t.value = text;
        t.style.position = "fixed";
        t.style.opacity = "0";
        document.body.appendChild(t);
        t.select();
        var ok = document.execCommand("copy");
        document.body.removeChild(t);
        if (ok) resolve(); else reject(new Error("copy failed"));
      } catch (e) { reject(e); }
    });
  }

  function addCopyButtons(el) {
    var pres = el.querySelectorAll("pre");
    for (var i = 0; i < pres.length; i++) {
      var pre = pres[i];
      if (pre.querySelector(".copy-btn")) continue;
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "copy-btn";
      btn.setAttribute("aria-label", "Copy code");
      btn.title = "Copy";
      icon(btn, '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', 12);
      btn.addEventListener("click", (function (code) {
        return function () {
          copyText(code.textContent).then(
            function () { snack("Copied"); },
            function () { snack("Copy failed"); }
          );
        };
      })(pre.querySelector("code")));
      pre.appendChild(btn);
    }
  }

  function icon(parent, paths, size) {
    var s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("fill", "none");
    s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", "2");
    s.setAttribute("stroke-linecap", "round");
    s.setAttribute("width", (size || 16) + "px");
    s.setAttribute("height", (size || 16) + "px");
    s.innerHTML = paths;
    parent.appendChild(s);
    return s;
  }

  var ICONS = {
    copyMsg: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    regen: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'
  };

  // ---------- message rows ----------
  function appendRow(role) {
    var row = document.createElement("div");
    row.className = "row msg-" + role;
    threadEl.appendChild(row);
    return row;
  }

  function buildUserRow(m) {
    var row = appendRow("user");
    var wrap = document.createElement("div");
    wrap.className = "bubble-wrap";
    var bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = m.content;
    wrap.appendChild(bubble);
    var acts = document.createElement("div");
    acts.className = "msg-actions right";
    var eb = document.createElement("button");
    eb.type = "button";
    eb.className = "icon-btn";
    eb.title = "Edit";
    icon(eb, ICONS.edit, 14);
    eb.addEventListener("click", function () { startEdit(m.id, row); });
    acts.appendChild(eb);
    wrap.appendChild(acts);
    row.appendChild(wrap);
    rows.push({ el: row, role: "user", id: m.id, content: m.content });
    return row;
  }

  function buildAssistantRow(m) {
    var row = appendRow("assistant");
    finalize(row, m.content || "");
    appendAssistantActions(row, m.content || "", m);
    rows.push({ el: row, role: "assistant", id: m.id, content: m.content });
    return row;
  }

  function appendAssistantActions(row, content, m) {
    var old = row.querySelector(".msg-actions");
    if (old) old.remove();
    var acts = document.createElement("div");
    acts.className = "msg-actions";
    var cb = document.createElement("button");
    cb.type = "button"; cb.className = "icon-btn"; cb.title = "Copy";
    icon(cb, ICONS.copyMsg, 14);
    cb.addEventListener("click", function () {
      copyText(content).then(function () { snack("Copied"); }, function () { snack("Copy failed"); });
    });
    var rb = document.createElement("button");
    rb.type = "button"; rb.className = "icon-btn"; rb.title = "Regenerate";
    icon(rb, ICONS.regen, 14);
    rb.addEventListener("click", function () { regenerate(); });
    acts.appendChild(cb);
    acts.appendChild(rb);
    if (m && m.completion_tokens) {
      var meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = "in=" + m.prompt_tokens + " out=" + m.completion_tokens;
      acts.appendChild(meta);
    }
    row.appendChild(acts);
  }

  function renderHistory() {
    var oldRows = threadEl.querySelectorAll(".row");
    for (var i = 0; i < oldRows.length; i++) oldRows[i].remove();
    rows = [];
    var history = CONF.messages || [];
    if (!history.length) {
      if (emptyEl) emptyEl.style.display = "flex";
      return;
    }
    if (emptyEl) emptyEl.style.display = "none";
    for (var i = 0; i < history.length; i++) {
      if (history[i].role === "user") buildUserRow(history[i]);
      else buildAssistantRow(history[i]);
    }
    threadEl.scrollTop = threadEl.scrollHeight;
  }

  // ---------- edit user message ----------
  function startEdit(mid, row) {
    if (streamActive) return;
    var entry = null;
    for (var i = 0; i < rows.length; i++) if (rows[i].id === mid) entry = rows[i];
    if (!entry) return;
    var wrap = row.querySelector(".bubble-wrap");
    var bubble = row.querySelector(".bubble");
    var input = document.createElement("textarea");
    input.className = "user-edit-input";
    input.value = entry.content;
    wrap.replaceChild(input, bubble);
    input.focus();
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
      else if (e.key === "Escape") { wrap.replaceChild(bubble, input); }
    });
    input.addEventListener("blur", function () {
      if (input.parentNode) wrap.replaceChild(bubble, input);
    });
    function submit() {
      var val = input.value.trim();
      if (!val) { wrap.replaceChild(bubble, input); return; }
      input.disabled = true;
      doEdit(mid, val, row);
    }
  }

  function doEdit(mid, content, userRow) {
    // drop everything after the edited message in the DOM
    var idx = -1;
    for (var i = 0; i < rows.length; i++) if (rows[i].id === mid) { idx = i; break; }
    if (idx === -1) return;
    for (var j = rows.length - 1; j > idx; j--) {
      rows[j].el.remove();
      rows.pop();
    }
    // replace the inline input with a fresh bubble
    var input = userRow.querySelector(".user-edit-input");
    var bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = content;
    if (input && input.parentNode) input.parentNode.replaceChild(bubble, input);
    else {
      var wrap = userRow.querySelector(".bubble-wrap");
      if (wrap) wrap.appendChild(bubble);
    }
    var e0 = findEntry(mid); if (e0) e0.content = content;
    streamReply({ message_id: mid, content: content }, "/api/chat/edit");
  }

  function findEntry(id) {
    for (var i = 0; i < rows.length; i++) if (rows[i].id === id) return rows[i];
    return null;
  }

  // ---------- regenerate ----------
  function regenerate() {
    if (streamActive || !convId) return;
    var removed = false;
    for (var i = rows.length - 1; i >= 0; i--) {
      if (rows[i].role === "assistant") {
        rows[i].el.remove();
        rows.splice(i, 1);
        removed = true;
        break;
      }
    }
    if (!removed) return;
    streamReply({ conversation_id: convId }, "/api/chat/regenerate");
  }

  // ---------- streaming ----------
  function streamReply(body, url) {
    emptyEl.style.display = "none";
    var row = appendRow("assistant");
    row.classList.add("stream-caret");
    rows.push({ el: row, role: "assistant", id: null, content: "" });
    streamActive = true;
    setSendState();
    controller = new AbortController();
    var full = "";
    var lastUsage = null;
    forceScrollBottom();

    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return readStream(r.body.getReader(), row);
    }).then(function () {
      finishStream(row, full, lastUsage);
    }).catch(function (e) {
      if (e && e.name === "AbortError") {
        finishStream(row, full, lastUsage);
      } else {
        row.classList.remove("stream-caret");
        var err = document.createElement("div");
        err.className = "msg-error";
        err.textContent = "error: " + ((e && e.message) || String(e));
        row.appendChild(err);
        streamActive = false;
        setSendState();
      }
    });

    function readStream(reader, rowEl) {
      var dec = new TextDecoder();
      var buf = "";
      function pump() {
        return reader.read().then(function (out) {
          if (out.done) return;
          buf += dec.decode(out.value, { stream: true });
          var lines = buf.split("\n");
          buf = lines.pop();
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (line.indexOf("data: ") !== 0) continue;
            var payload = line.slice(6).trim();
            if (payload === "[DONE]") continue;
            var j = null;
            try { j = JSON.parse(payload); } catch (e2) { continue; }
            if (j.error) throw new Error(j.error);
            var delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
            if (delta) { full += delta; scheduleRender(rowEl, full); }
            if (j.usage) lastUsage = j.usage;
          }
          return pump();
        });
      }
      return pump();
    }
  }

  function finishStream(row, full, lastUsage) {
    row.classList.remove("stream-caret");
    streamActive = false;
    setSendState();
    var entry = null;
    for (var i = 0; i < rows.length; i++) if (rows[i].el === row) entry = rows[i];
    if (entry) entry.content = full;
    if (full) {
      finalize(row, full);
      appendAssistantActions(row, full, lastUsage ? {
        completion_tokens: lastUsage.completion_tokens, prompt_tokens: lastUsage.prompt_tokens
      } : null);
    }
    stickToBottom();
  }

  // ---------- composer ----------
  function setSendState() {
    sendBtn.classList.toggle("stop", streamActive);
    sendBtn.disabled = false;
    ta.placeholder = streamActive ? "Generating…" : "Message Temper…";
  }

  function autosize() {
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }
  ta.addEventListener("input", autosize);

  async function send() {
    var text = ta.value.trim();
    if (streamActive) { if (controller) controller.abort(); return; }
    if (!text) return;
    if (!convId) {
      var r = await fetch("/api/conversations/new", { method: "POST" });
      var d = await r.json();
      convId = d.id;
      insertConvItem(convId, text.slice(0, 40));
    }
    emptyEl.style.display = "none";
    ta.value = "";
    autosize();
    buildUserRow({ role: "user", id: null, content: text });
    forceScrollBottom();
    streamReply({ conversation_id: convId, message: text }, "/api/chat/send");
  }
  sendBtn.addEventListener("click", send);
  ta.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });

  // suggestion chips
  document.querySelectorAll(".chip").forEach(function (chip) {
    chip.addEventListener("click", function () {
      ta.value = chip.dataset.text || chip.textContent;
      autosize();
      send();
    });
  });

  function stickToBottom() {
    if (threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight < 48) {
      threadEl.scrollTop = threadEl.scrollHeight;
    }
  }
  var followStream = false;
  function forceScrollBottom() {
    threadEl.scrollTop = threadEl.scrollHeight;
    followStream = true;
  }
  threadEl.addEventListener("scroll", function () {
    if (!streamActive) return;
    followStream = (threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight) < 24;
  });

  // ---------- settings modal ----------
  var modal = document.getElementById("settingsModal");
  var settingsBtn = document.getElementById("settingsBtn");
  var modalClose = document.getElementById("modalClose");
  var statsTimer = null;

  function openModal() {
    fillSettingsForm();
    fillModelSelect();
    refreshStats();
    statsTimer = setInterval(refreshStats, 5000);
    modal.classList.add("open");
  }
  function closeModal() {
    clearInterval(statsTimer);
    statsTimer = null;
    modal.classList.remove("open");
  }
  if (settingsBtn) settingsBtn.addEventListener("click", openModal);
  if (modalClose) modalClose.addEventListener("click", closeModal);
  if (modal) modal.addEventListener("click", function (e) { if (e.target === modal) closeModal(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeModal(); });

  function fillSettingsForm() {
    var set = function (id, v) { var el = document.getElementById(id); if (el != null && v != null) el.value = v; };
    set("s_ollama_url", settings.ollama_url);
    set("s_input_price", settings.input_price);
    set("s_output_price", settings.output_price);
    set("s_usd_to_idr", settings.usd_to_idr);
  }

  function fillModelSelect() {
    var sel = document.getElementById("s_model");
    if (!sel) return;
    fetch("/api/models").then(function (r) { return r.json(); }).then(function (d) {
      sel.innerHTML = "";
      var list = (d.data || []).map(function (m) { return m.id; });
      if (!list.length) list = [currentModel];
      for (var i = 0; i < list.length; i++) {
        var o = document.createElement("option");
        o.value = list[i];
        o.textContent = list[i];
        if (list[i] === currentModel) o.selected = true;
        sel.appendChild(o);
      }
    }).catch(function () {});
  }

  var fmtUsd = function (v) {
    if (!isFinite(v)) v = 0;
    var s = v.toFixed(6).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
    return "$" + s;
  };
  var fmtIdr = function (v) {
    if (!isFinite(v)) v = 0;
    return "Rp " + Math.round(v).toLocaleString("id-ID");
  };

  function refreshStats() {
    fetch("/api/stats").then(function (r) { return r.json(); }).then(function (d) {
      var t = d.totals || {};
      var setText = function (id, v) { var el = document.getElementById(id); if (el) el.textContent = v; };
      setText("s_req", (t.requests || 0).toLocaleString("id-ID"));
      setText("s_in", (t.prompt_tokens || 0).toLocaleString("id-ID"));
      setText("s_out", (t.completion_tokens || 0).toLocaleString("id-ID"));
      setText("s_tot", (t.total_tokens || 0).toLocaleString("id-ID"));
      var ip = parseFloat(document.getElementById("s_input_price").value) || 0;
      var op = parseFloat(document.getElementById("s_output_price").value) || 0;
      var rate = parseFloat(document.getElementById("s_usd_to_idr").value) || 0;
      var usd = (t.prompt_tokens || 0) / 1000 * ip + (t.completion_tokens || 0) / 1000 * op;
      setText("s_usd", fmtUsd(usd));
      setText("s_idr", fmtIdr(usd * rate));
      var tb = document.getElementById("recentBody");
      if (tb) {
        tb.innerHTML = "";
        var rec = (d.recent || []).slice(-20).reverse();
        for (var i = 0; i < rec.length; i++) {
          var r2 = rec[i];
          var tr = document.createElement("tr");
          var ts = new Date(r2.ts * 1000).toLocaleTimeString();
          tr.innerHTML = "<td>" + esc(ts) + "</td><td>" + esc(r2.model || "") + "</td><td>" +
            r2.prompt_tokens + "</td><td>" + r2.completion_tokens + "</td><td>" + r2.total_tokens +
            "</td><td>" + r2.elapsed_s + "s</td>";
          tb.appendChild(tr);
        }
      }
    }).catch(function () {});
  }
  function esc(s) {
    var d = document.createElement("div");
    d.textContent = String(s);
    return d.innerHTML;
  }

  var saveBtn = document.getElementById("s_save");
  if (saveBtn) saveBtn.addEventListener("click", function () {
    var body = {
      ollama_url: document.getElementById("s_ollama_url").value,
      model: (document.getElementById("s_model") || {}).value,
      input_price: parseFloat(document.getElementById("s_input_price").value),
      output_price: parseFloat(document.getElementById("s_output_price").value),
      usd_to_idr: parseFloat(document.getElementById("s_usd_to_idr").value)
    };
    fetch("/api/settings", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    }).then(function (r) { return r.json(); }).then(function () {
      settings.ollama_url = body.ollama_url;
      currentModel = body.model;
      var lbl = document.getElementById("modelName");
      if (lbl) lbl.textContent = body.model;
      snack("Settings saved");
    }).catch(function () { snack("Save failed"); });
  });

  var testBtn = document.getElementById("s_test");
  if (testBtn) testBtn.addEventListener("click", function () {
    var st = document.getElementById("s_test_status");
    fetch("/api/settings/test", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ollama_url: document.getElementById("s_ollama_url").value })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (st) st.textContent = d.ok ? "OK: " + d.count + " models" : "FAIL: " + (d.error || "");
    }).catch(function () { if (st) st.textContent = "FAIL"; });
  });

  var exportBtn = document.getElementById("s_export");
  if (exportBtn) exportBtn.addEventListener("click", function () {
    window.location = "/stats/export";
  });

  // ---------- boot ----------
  renderHistory();
})();
