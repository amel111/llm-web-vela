import os
import json
import time
import sqlite3
import threading
from collections import deque
from datetime import datetime, timedelta
import os as _os
from flask import Flask, request, jsonify, Response, stream_with_context, render_template, redirect, url_for, session, send_from_directory

import httpx

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
MODEL = os.environ.get("OLLAMA_MODEL", "temper-2-ion")
API_KEY = os.environ.get("PROXY_API_KEY", "sk-temper-24h-askdj1")
HOST = os.environ.get("PROXY_HOST", "0.0.0.0")
PORT = int(os.environ.get("PROXY_PORT", "8080"))
DB_PATH = os.environ.get("USAGE_DB", "usage.db")
SETTINGS_PATH = os.environ.get("SETTINGS_FILE", "settings.json")
WEB_PASSWORD = os.environ.get("WEB_PASSWORD", "") or API_KEY

LOG_FILE = os.environ.get("USAGE_LOG", "usage.log")

# static asset cache-busting version — bump after changing static/ui.css or static/app.js
ASSET_V = os.environ.get("ASSET_V", "20261105c")

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "temper-secret-change-me")
_lock = threading.Lock()
_recent = deque(maxlen=500)
_stats = {"requests": 0, "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}


def _init_db():
    con = sqlite3.connect(DB_PATH)
    con.execute(
        """CREATE TABLE IF NOT EXISTS usage (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts REAL NOT NULL,
            model TEXT,
            prompt_tokens INTEGER,
            completion_tokens INTEGER,
            total_tokens INTEGER,
            elapsed_s REAL,
            endpoint TEXT
        )"""
    )
    con.execute(
        """CREATE TABLE IF NOT EXISTS conversations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT,
            model TEXT,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        )"""
    )
    con.execute(
        """CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id INTEGER NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            prompt_tokens INTEGER DEFAULT 0,
            completion_tokens INTEGER DEFAULT 0,
            created_at REAL NOT NULL,
            FOREIGN KEY(conversation_id) REFERENCES conversations(id)
        )"""
    )
    con.commit()
    con.close()


_init_db()

_DEFAULT_SETTINGS = {
    "ollama_url": OLLAMA_URL,
    "model": MODEL,
    "temperature": 0.2,
    "top_p": 0.8,
    "top_k": 20,
    "repeat_penalty": 1.05,
    "max_tokens": 1000,
    "num_ctx": 32768,
    "input_price": 0.0001,
    "output_price": 0.0002,
    "usd_to_idr": 16000,
}


def load_settings():
    try:
        with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
            s = json.load(f)
        return {**_DEFAULT_SETTINGS, **s}
    except Exception:
        return dict(_DEFAULT_SETTINGS)


def save_settings(s):
    with open(SETTINGS_PATH, "w", encoding="utf-8") as f:
        json.dump(s, f, indent=2)


_SETTINGS = load_settings()


def _auth():
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        # also allow x-api-key
        alt = request.headers.get("x-api-key", "")
        return alt == API_KEY
    return auth.split(" ", 1)[1].strip() == API_KEY


@app.before_request
def _check_auth():
    skip = ("/health", "/login", "/logout", "/static/")
    if any(request.path == s or request.path.startswith(s) for s in skip):
        return None
    page_routes = request.path in ("/", "/settings") or request.path.startswith("/chat/")
    api_routes = request.path.startswith("/api/") or request.path.startswith("/v1/") or request.path.startswith("/models") or request.path.startswith("/stats")
    if page_routes:
        if session.get("authed"):
            return None
        return redirect(url_for("web_login_get"))
    if api_routes:
        if session.get("authed"):
            return None
        if _auth():
            return None
        return jsonify({"error": {"message": "invalid api key", "type": "auth_error"}}), 401
    # default: require api key
    if not _auth():
        return jsonify({"error": {"message": "invalid api key", "type": "auth_error"}}), 401
    if not _auth():
        return jsonify({"error": {"message": "invalid api key", "type": "auth_error"}}), 401


@app.get("/health")
def health():
    return jsonify({"status": "ok", "model": MODEL, "ollama": OLLAMA_URL, "version": "2.0"})


@app.get("/v1/models")
@app.get("/models")
def list_models():
    try:
        r = httpx.get(f"{OLLAMA_URL}/api/tags", timeout=10)
        r.raise_for_status()
        tags = r.json().get("models", [])
    except Exception:
        tags = []
    data = [{"id": m.get("name", MODEL), "object": "model", "owned_by": "ollama"} for m in tags]
    if not data:
        data = [{"id": MODEL, "object": "model", "owned_by": "ollama"}]
    return jsonify({"object": "list", "data": data})


@app.get("/stats")
def stats():
    with _lock:
        snap = dict(_stats)
        recent = list(_recent)
    # also load persisted totals
    try:
        con = sqlite3.connect(DB_PATH)
        row = con.execute("SELECT COUNT(*), COALESCE(SUM(prompt_tokens),0), COALESCE(SUM(completion_tokens),0), COALESCE(SUM(total_tokens),0) FROM usage").fetchone()
        con.close()
        persisted = {"requests": row[0], "prompt_tokens": row[1], "completion_tokens": row[2], "total_tokens": row[3]}
    except Exception:
        persisted = snap
    return jsonify({"totals": persisted, "recent": recent, "session": snap})


@app.get("/stats/export")
def stats_export():
    con = sqlite3.connect(DB_PATH)
    rows = con.execute("SELECT ts,model,prompt_tokens,completion_tokens,total_tokens,elapsed_s,endpoint FROM usage ORDER BY id").fetchall()
    con.close()
    lines = ["ts,model,prompt_tokens,completion_tokens,total_tokens,elapsed_s,endpoint"]
    for r in rows:
        lines.append(",".join(str(x) for x in r))
    return Response("\n".join(lines) + "\n", mimetype="text/csv", headers={"Content-Disposition": "attachment; filename=usage.csv"})


def _record(model, pt, ct, total, elapsed, endpoint):
    rec = {"ts": time.time(), "model": model, "prompt_tokens": pt,
           "completion_tokens": ct, "total_tokens": total, "elapsed_s": round(elapsed, 3)}
    with _lock:
        _stats["requests"] += 1
        _stats["prompt_tokens"] += pt
        _stats["completion_tokens"] += ct
        _stats["total_tokens"] += total
        _recent.append(rec)
    try:
        con = sqlite3.connect(DB_PATH)
        con.execute("INSERT INTO usage (ts,model,prompt_tokens,completion_tokens,total_tokens,elapsed_s,endpoint) VALUES (?,?,?,?,?,?,?)",
                    (rec["ts"], model, pt, ct, total, rec["elapsed_s"], endpoint))
        con.commit()
        con.close()
    except Exception:
        pass
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")
    except Exception:
        pass
    return rec


@app.post("/v1/chat/completions")
def chat_completions():
    data = request.get_json(force=True, silent=True) or {}
    messages = data.get("messages", [])
    model = data.get("model", MODEL)
    temperature = data.get("temperature", 0.2)
    top_p = data.get("top_p", 0.8)
    top_k = data.get("top_k", 20)
    repeat_penalty = data.get("repeat_penalty", 1.05)
    max_tokens = data.get("max_tokens", 1000)
    num_ctx = data.get("num_ctx", None)
    stream = bool(data.get("stream", False))

    opts = {"temperature": temperature, "top_p": top_p, "top_k": top_k,
            "repeat_penalty": repeat_penalty, "num_predict": max_tokens}
    if num_ctx:
        opts["num_ctx"] = num_ctx

    payload = {"model": model, "messages": messages, "stream": stream, "options": opts}

    if stream:
        def gen():
            t0 = time.time()
            pt = 0
            ct = 0
            try:
                with httpx.stream("POST", f"{OLLAMA_URL}/api/chat", json=payload, timeout=300) as r:
                    r.raise_for_status()
                    for line in r.iter_lines():
                        if not line:
                            continue
                        try:
                            obj = json.loads(line)
                        except Exception:
                            continue
                        if "prompt_eval_count" in obj:
                            pt = int(obj.get("prompt_eval_count", 0) or 0)
                        if "eval_count" in obj:
                            ct = int(obj.get("eval_count", 0) or 0)
                        delta = obj.get("message", {}).get("content", "")
                        chunk = {
                            "id": f"chatcmpl-{int(time.time()*1000)}",
                            "object": "chat.completion.chunk",
                            "created": int(time.time()),
                            "model": model,
                            "choices": [{"index": 0, "delta": {"content": delta}, "finish_reason": None}],
                        }
                        if obj.get("done"):
                            chunk["choices"][0]["finish_reason"] = "stop"
                            chunk["usage"] = {"prompt_tokens": pt, "completion_tokens": ct, "total_tokens": pt + ct}
                        yield f"data: {json.dumps(chunk)}\n\n"
            except Exception as e:
                yield f"data: {json.dumps({'error': str(e)})}\n\n"
            finally:
                _record(model, pt, ct, pt + ct, time.time() - t0, "/v1/chat/completions")
            yield "data: [DONE]\n\n"
        return Response(stream_with_context(gen()), mimetype="text/event-stream")

    t0 = time.time()
    try:
        r = httpx.post(f"{OLLAMA_URL}/api/chat", json=payload, timeout=300)
        r.raise_for_status()
    except Exception as e:
        return jsonify({"error": {"message": str(e), "type": "upstream_error"}}), 502
    body = r.json()
    content = body.get("message", {}).get("content", "")
    pt = int(body.get("prompt_eval_count", 0) or 0)
    ct = int(body.get("eval_count", 0) or 0)
    total = pt + ct
    _record(model, pt, ct, total, time.time() - t0, "/v1/chat/completions")
    resp = {
        "id": f"chatcmpl-{int(time.time()*1000)}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": pt, "completion_tokens": ct, "total_tokens": total},
    }
    return jsonify(resp)


@app.post("/v1/completions")
def completions():
    data = request.get_json(force=True, silent=True) or {}
    prompt = data.get("prompt", "")
    model = data.get("model", MODEL)
    opts = {
        "temperature": data.get("temperature", 0.2),
        "top_p": data.get("top_p", 0.8),
        "top_k": data.get("top_k", 20),
        "repeat_penalty": data.get("repeat_penalty", 1.05),
        "num_predict": data.get("max_tokens", 1000),
    }
    if data.get("num_ctx"):
        opts["num_ctx"] = data["num_ctx"]
    payload = {"model": model, "prompt": prompt, "stream": False, "options": opts}
    t0 = time.time()
    try:
        r = httpx.post(f"{OLLAMA_URL}/api/generate", json=payload, timeout=300)
        r.raise_for_status()
    except Exception as e:
        return jsonify({"error": {"message": str(e), "type": "upstream_error"}}), 502
    body = r.json()
    text = body.get("response", "")
    pt = int(body.get("prompt_eval_count", 0) or 0)
    ct = int(body.get("eval_count", 0) or 0)
    total = pt + ct
    _record(model, pt, ct, total, time.time() - t0, "/v1/completions")
    return jsonify({
        "id": f"cmpl-{int(time.time()*1000)}",
        "object": "text_completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "text": text, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": pt, "completion_tokens": ct, "total_tokens": total},
    })


# ---- Web UI ----
def _web_authed():
    return session.get("authed") is True


@app.get("/login")
def web_login_get():
    if _web_authed():
        return redirect(url_for("web_chat"))
    return render_template("login.html", error=None)


@app.post("/login")
def web_login_post():
    pw = request.form.get("password", "")
    if pw == WEB_PASSWORD:
        session["authed"] = True
        return redirect(url_for("web_chat"))
    return render_template("login.html", error="Invalid password"), 401


@app.get("/logout")
def web_logout():
    session.clear()
    return redirect(url_for("web_login_get"))


def _require_web():
    if not _web_authed():
        return redirect(url_for("web_login_get"))
    return None


def _group_conversations(convs):
    today = datetime.now().date()
    week_ago = today - timedelta(days=7)
    groups = {"Today": [], "Previous 7 days": [], "Older": []}
    for c in convs:
        d = datetime.fromtimestamp(c["updated_at"]).date()
        if d >= today:
            groups["Today"].append(c)
        elif d >= week_ago:
            groups["Previous 7 days"].append(c)
        else:
            groups["Older"].append(c)
    return [(k, v) for k, v in groups.items() if v]


@app.get("/")
def web_chat():
    r = _require_web()
    if r:
        return r
    conv_id = request.args.get("conv")
    convs = _list_conversations()
    active = None
    msgs = []
    if conv_id:
        active = int(conv_id)
        msgs = _list_messages(active)
    elif convs:
        active = convs[0]["id"]
        msgs = _list_messages(active)
    return render_template("chat.html", conv_groups=_group_conversations(convs), active_id=active, messages=msgs, settings=_SETTINGS, V=ASSET_V)


@app.get("/chat/new")
def web_chat_new():
    r = _require_web()
    if r:
        return r
    convs = _list_conversations()
    return render_template("chat.html", conv_groups=_group_conversations(convs), active_id=None, messages=[], settings=_SETTINGS, V=ASSET_V)


@app.get("/chat/<int:cid>")
def web_chat_one(cid):
    r = _require_web()
    if r:
        return r
    convs = _list_conversations()
    msgs = _list_messages(cid)
    return render_template("chat.html", conv_groups=_group_conversations(convs), active_id=cid, messages=msgs, settings=_SETTINGS, V=ASSET_V)


@app.post("/api/conversations/new")
def api_conv_new():
    if not _web_authed():
        return jsonify({"error": "unauth"}), 401
    cid = _new_conversation(_SETTINGS.get("model"))
    return jsonify({"id": cid})


@app.delete("/api/conversations/<int:cid>")
def api_conv_del(cid):
    if not _web_authed():
        return jsonify({"error": "unauth"}), 401
    _del_conversation(cid)
    return jsonify({"ok": True})


def _chat_options():
    return {"temperature": _SETTINGS.get("temperature", 0.2),
            "top_p": _SETTINGS.get("top_p", 0.8),
            "top_k": _SETTINGS.get("top_k", 20),
            "repeat_penalty": _SETTINGS.get("repeat_penalty", 1.05),
            "num_predict": _SETTINGS.get("max_tokens", 1000),
            "num_ctx": _SETTINGS.get("num_ctx", 32768)}


def _stream_chat(cid, history, model, endpoint):
    """Stream an assistant reply over SSE for the given history, then persist.
    Shared by /api/chat/send, /api/chat/regenerate, /api/chat/edit."""
    payload = {"model": model, "messages": history, "stream": True,
               "options": _chat_options()}

    def gen():
        t0 = time.time()
        pt = 0
        ct = 0
        full = ""
        try:
            with httpx.stream("POST", "{}/api/chat".format(_SETTINGS.get("ollama_url", OLLAMA_URL).rstrip("/")),
                              json=payload, timeout=300) as r:
                r.raise_for_status()
                for line in r.iter_lines():
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except Exception:
                        continue
                    if "prompt_eval_count" in obj:
                        pt = int(obj.get("prompt_eval_count", 0) or 0)
                    if "eval_count" in obj:
                        ct = int(obj.get("eval_count", 0) or 0)
                    delta = obj.get("message", {}).get("content", "")
                    if delta:
                        full += delta
                        chunk = {"id": "c-{}".format(int(time.time()*1000)), "object": "chat.completion.chunk",
                                 "created": int(time.time()), "model": model,
                                 "choices": [{"index": 0, "delta": {"content": delta}, "finish_reason": None}]}
                        yield "data: {}\n\n".format(json.dumps(chunk))
                    if obj.get("done"):
                        chunk = {"id": "c-{}".format(int(time.time()*1000)), "object": "chat.completion.chunk",
                                 "created": int(time.time()), "model": model,
                                 "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                                 "usage": {"prompt_tokens": pt, "completion_tokens": ct, "total_tokens": pt+ct}}
                        yield "data: {}\n\n".format(json.dumps(chunk))
        except Exception as e:
            yield "data: {}\n\n".format(json.dumps({"error": str(e)}))
        finally:
            _add_message(cid, "assistant", full, pt, ct)
            _record(model, pt, ct, pt+ct, time.time()-t0, endpoint)
            _touch_conversation(cid)
        yield "data: [DONE]\n\n"

    return Response(stream_with_context(gen()), mimetype="text/event-stream")


@app.post("/api/chat/send")
def api_chat_send():
    if not _web_authed():
        return jsonify({"error": "unauth"}), 401
    data = request.get_json(force=True, silent=True) or {}
    cid = data.get("conversation_id")
    text = (data.get("message") or "").strip()
    if not cid or not text:
        return jsonify({"error": "missing"}), 400
    cid = int(cid)
    _add_message(cid, "user", text)
    conv = _get_conversation(cid)
    if not conv.get("title"):
        _set_title(cid, text[:40])

    msgs_db = _list_messages(cid)
    api_msgs = [{"role": m["role"], "content": m["content"]} for m in msgs_db]
    return _stream_chat(cid, api_msgs, _SETTINGS.get("model"), "/web/chat")


@app.post("/api/chat/regenerate")
def api_chat_regenerate():
    if not _web_authed():
        return jsonify({"error": "unauth"}), 401
    data = request.get_json(force=True, silent=True) or {}
    cid = data.get("conversation_id")
    if not cid:
        return jsonify({"error": "missing"}), 400
    cid = int(cid)
    if not _get_conversation(cid):
        return jsonify({"error": "not found"}), 404
    con = sqlite3.connect(DB_PATH)
    row = con.execute("SELECT id, role FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 1", (cid,)).fetchone()
    if row and row[1] == "assistant":
        con.execute("DELETE FROM messages WHERE id=?", (row[0],))
        con.commit()
    con.close()
    if not row:
        return jsonify({"error": "empty"}), 400
    msgs_db = _list_messages(cid)
    api_msgs = [{"role": m["role"], "content": m["content"]} for m in msgs_db]
    return _stream_chat(cid, api_msgs, _SETTINGS.get("model"), "/web/regenerate")


@app.post("/api/chat/edit")
def api_chat_edit():
    if not _web_authed():
        return jsonify({"error": "unauth"}), 401
    data = request.get_json(force=True, silent=True) or {}
    mid = data.get("message_id")
    content = (data.get("content") or "").strip()
    if not mid or not content:
        return jsonify({"error": "missing"}), 400
    con = sqlite3.connect(DB_PATH)
    row = con.execute("SELECT id, role, conversation_id FROM messages WHERE id=?", (int(mid),)).fetchone()
    if not row:
        con.close()
        return jsonify({"error": "not found"}), 404
    cid = row[2]
    if row[1] != "user":
        con.close()
        return jsonify({"error": "can only edit user messages"}), 400
    con.execute("UPDATE messages SET content=? WHERE id=?", (content, int(mid)))
    con.execute("DELETE FROM messages WHERE conversation_id=? AND id>?", (cid, int(mid)))
    con.commit()
    con.close()
    _set_title(cid, content[:40])
    msgs_db = _list_messages(cid)
    api_msgs = [{"role": m["role"], "content": m["content"]} for m in msgs_db]
    return _stream_chat(cid, api_msgs, _SETTINGS.get("model"), "/web/edit")


@app.post("/api/conversations/<int:cid>/rename")
def api_conv_rename(cid):
    if not _web_authed():
        return jsonify({"error": "unauth"}), 401
    data = request.get_json(force=True, silent=True) or {}
    title = (data.get("title") or "").strip()
    if not title:
        return jsonify({"error": "missing"}), 400
    _set_title(cid, title[:80])
    return jsonify({"ok": True})


@app.get("/settings")
def web_settings():
    return redirect(url_for("web_chat"))


@app.post("/api/settings")
def api_settings_save():
    if not _web_authed():
        return jsonify({"error": "unauth"}), 401
    data = request.get_json(force=True, silent=True) or {}
    for k in _DEFAULT_SETTINGS:
        if k in data:
            _SETTINGS[k] = data[k]
    save_settings(_SETTINGS)
    global MODEL, OLLAMA_URL
    MODEL = _SETTINGS.get("model", MODEL)
    OLLAMA_URL = _SETTINGS.get("ollama_url", OLLAMA_URL).rstrip("/")
    return jsonify({"ok": True})


@app.post("/api/settings/test")
def api_settings_test():
    if not _web_authed():
        return jsonify({"error": "unauth"}), 401
    data = request.get_json(force=True, silent=True) or {}
    url = (data.get("ollama_url") or _SETTINGS.get("ollama_url") or OLLAMA_URL).rstrip("/")
    try:
        r = httpx.get("{}/api/tags".format(url), timeout=10)
        r.raise_for_status()
        return jsonify({"ok": True, "count": len(r.json().get("models", []))})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


@app.get("/api/stats")
def api_stats_alias():
    if not _web_authed():
        return jsonify({"error": "unauth"}), 401
    return stats()


@app.get("/api/models")
def api_models_alias():
    if not _web_authed():
        return jsonify({"error": "unauth"}), 401
    return list_models()


# ---- DB helpers for web ----
def _list_conversations():
    con = sqlite3.connect(DB_PATH)
    rows = con.execute("SELECT id,title,model,created_at,updated_at FROM conversations ORDER BY updated_at DESC").fetchall()
    con.close()
    return [{"id": r[0], "title": r[1], "model": r[2], "created_at": r[3], "updated_at": r[4]} for r in rows]


def _get_conversation(cid):
    con = sqlite3.connect(DB_PATH)
    row = con.execute("SELECT id,title,model FROM conversations WHERE id=?", (cid,)).fetchone()
    con.close()
    return {"id": row[0], "title": row[1], "model": row[2]} if row else {}


def _new_conversation(model):
    now = time.time()
    con = sqlite3.connect(DB_PATH)
    cur = con.execute("INSERT INTO conversations (title,model,created_at,updated_at) VALUES (?,?,?,?)", (None, model, now, now))
    cid = cur.lastrowid
    con.commit()
    con.close()
    return cid


def _del_conversation(cid):
    con = sqlite3.connect(DB_PATH)
    con.execute("DELETE FROM messages WHERE conversation_id=?", (cid,))
    con.execute("DELETE FROM conversations WHERE id=?", (cid,))
    con.commit()
    con.close()


def _add_message(cid, role, content, pt=0, ct=0):
    now = time.time()
    con = sqlite3.connect(DB_PATH)
    con.execute("INSERT INTO messages (conversation_id,role,content,prompt_tokens,completion_tokens,created_at) VALUES (?,?,?,?,?,?)",
                (cid, role, content, pt, ct, now))
    con.commit()
    con.close()


def _list_messages(cid):
    con = sqlite3.connect(DB_PATH)
    rows = con.execute("SELECT id,role,content,prompt_tokens,completion_tokens,created_at FROM messages WHERE conversation_id=? ORDER BY id", (cid,)).fetchall()
    con.close()
    return [{"id": r[0], "role": r[1], "content": r[2], "prompt_tokens": r[3], "completion_tokens": r[4], "created_at": r[5]} for r in rows]


def _set_title(cid, title):
    con = sqlite3.connect(DB_PATH)
    con.execute("UPDATE conversations SET title=? WHERE id=?", (title, cid))
    con.commit()
    con.close()


def _touch_conversation(cid):
    con = sqlite3.connect(DB_PATH)
    con.execute("UPDATE conversations SET updated_at=? WHERE id=?", (time.time(), cid))
    con.commit()
    con.close()


def _ollama_model_names():
    try:
        r = httpx.get("{}/api/tags".format(_SETTINGS.get("ollama_url", OLLAMA_URL).rstrip("/")), timeout=10)
        r.raise_for_status()
        return [m.get("name") for m in r.json().get("models", [])]
    except Exception:
        return []


@app.get("/static/<path:fname>")
def static_files(fname):
    return send_from_directory("static", fname)
if __name__ == "__main__":
    print(f"Proxy v2 listening on {HOST}:{PORT}")
    print(f"Model: {MODEL}  Ollama: {OLLAMA_URL}")
    app.run(host=HOST, port=PORT)
