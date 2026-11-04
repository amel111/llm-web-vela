"use strict";
(function () {
  var CONF = window.TEMPER || {};
  var convId = CONF.convId || null;

  var msgsEl = document.getElementById("messages");
  var inputEl = document.getElementById("input");

  // ---------- markdown pipeline ----------
  var rafPending = false;
  var rafHandle = null;

  function md(text) {
    return DOMPurify.sanitize(marked.parse(text));
  }

  // If the fence at idx is an OPENER (odd-numbered counting from 1), it is
  // unclosed: prose up to it renders live, the raw tail stays plain until
  // the fence closes. before-count even => fence at idx is odd-numbered.
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

  // ---------- copy buttons ----------
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
      var icon = document.createElement("span");
      icon.className = "copy-ico";
      icon.textContent = "content_copy";
      btn.appendChild(icon);
      btn.addEventListener("click", makeCopyHandler(pre));
      pre.appendChild(btn);
    }
  }

  function makeCopyHandler(pre) {
    return function () {
      var code = pre.querySelector("code");
      var text = code ? code.textContent : "";
      copyText(text).then(
        function () { if (window.snack) window.snack("Copied"); },
        function () { if (window.snack) window.snack("Copy failed"); }
      );
    };
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () {
        return legacyCopy(text);
      });
    }
    return legacyCopy(text);
  }

  function legacyCopy(text) {
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand("copy");
        document.body.removeChild(ta);
        if (ok) resolve(); else reject(new Error("copy failed"));
      } catch (e) { reject(e); }
    });
  }

  // ---------- message DOM ----------
  function appendMsg(role) {
    var d = document.createElement("div");
    d.className = "msg " + role;
    msgsEl.appendChild(d);
    return d;
  }

  function appendUser(text) {
    var d = appendMsg("user");
    d.textContent = text;
    return d;
  }

  function metaLine(el, pt, ct) {
    var m = document.createElement("div");
    m.className = "meta";
    m.textContent = "in=" + pt + " out=" + ct;
    el.appendChild(m);
  }

  // ---------- scroll ----------
  function atBottom() {
    return msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 48;
  }

  function stickToBottom() {
    if (atBottom()) msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  // ---------- streaming ----------
  function scheduleRender(el, text) {
    if (rafPending) return;
    rafPending = true;
    rafHandle = requestAnimationFrame(function () {
      rafPending = false;
      renderInto(el, text);
      stickToBottom();
    });
  }

  async function send() {
    var text = inputEl.value.trim();
    if (!text) return;
    if (!convId) {
      var r0 = await fetch("/api/conversations/new", { method: "POST" });
      convId = (await r0.json()).id;
      location.href = "/chat/" + convId;
      return;
    }
    appendUser(text);
    inputEl.value = "";
    var a = appendMsg("assistant");
    stickToBottom();

    var r = await fetch("/api/chat/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: convId, message: text })
    });
    var reader = r.body.getReader();
    var dec = new TextDecoder();
    var buf = "";
    var full = "";
    var lastUsage = null;
    for (;;) {
      var out = await reader.read();
      if (out.done) break;
      buf += dec.decode(out.value, { stream: true });
      var lines = buf.split("\n");
      buf = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.indexOf("data: ") !== 0) continue;
        var payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;
        var j = null;
        try { j = JSON.parse(payload); } catch (e) { continue; }
        if (j.error) {
          a.classList.add("error");
          a.textContent = "error: " + j.error;
          continue;
        }
        var delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        if (delta) { full += delta; scheduleRender(a, full); }
        if (j.usage) lastUsage = j.usage;
      }
    }
    finalize(a, full);
    if (lastUsage) metaLine(a, lastUsage.prompt_tokens, lastUsage.completion_tokens);
    stickToBottom();
  }

  async function newConv() {
    var r = await fetch("/api/conversations/new", { method: "POST" });
    var d = await r.json();
    location.href = "/chat/" + d.id;
  }

  // ---------- wiring ----------
  var newChatBtn = document.getElementById("newChatBtn");
  if (newChatBtn) newChatBtn.addEventListener("click", newConv);
  var sendBtn = document.getElementById("sendBtn");
  if (sendBtn) sendBtn.addEventListener("click", send);
  if (inputEl) inputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });

  // ---------- history ----------
  var history = CONF.messages || [];
  for (var i = 0; i < history.length; i++) {
    var m = history[i];
    if (m.role === "user") {
      appendUser(m.content);
    } else {
      var el = appendMsg("assistant");
      finalize(el, m.content || "");
      if (m.completion_tokens) metaLine(el, m.prompt_tokens, m.completion_tokens);
    }
  }
  if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;
})();
