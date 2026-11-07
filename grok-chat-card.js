const HAUS_MEMORY_MS = 4 * 60 * 1000;
const HAUS_MAX_MESSAGES = 200;
const HAUS_MAX_THREADS = 50;
const HAUS_NEW_TITLE = "Neues Gespräch";
const HAUS_MEDIA = "media-source://media_source/local/grok-haus";

function hausId() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch (_) {}
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function hausTitle(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return HAUS_NEW_TITLE;
  return clean.length > 48 ? `${clean.slice(0, 48).trim()}…` : clean;
}

function liveConversationId(id, touchedAt, now) {
  if (!id || !touchedAt) return undefined;
  if (now - touchedAt > HAUS_MEMORY_MS) return undefined;
  return id;
}

function blankThread() {
  return {
    id: hausId(),
    title: HAUS_NEW_TITLE,
    conversationId: null,
    touchedAt: 0,
    updated: Date.now(),
    messages: [],
  };
}

function slimMessage(m, i) {
  return {
    id: m.id || hausId(),
    seq: m.seq || i + 1,
    role: m.role === "user" ? "user" : "assistant",
    text: m.text || "",
    error: !!m.error,
    mediaId: m.mediaId || "",
  };
}

function normalizeStore(value) {
  const threads = Array.isArray(value?.threads) ? value.threads : [];
  const clean = threads
    .filter((t) => t && t.id)
    .map((t) => ({
      id: String(t.id),
      title: t.title || HAUS_NEW_TITLE,
      conversationId: t.conversationId || null,
      touchedAt: t.touchedAt || 0,
      updated: t.updated || 0,
      messages: (Array.isArray(t.messages) ? t.messages : [])
        .slice(-HAUS_MAX_MESSAGES)
        .map(slimMessage),
    }))
    .sort((a, b) => (b.updated || 0) - (a.updated || 0))
    .slice(0, HAUS_MAX_THREADS);
  const wanted = value?.activeId == null ? "" : String(value.activeId);
  const activeId = clean.some((t) => t.id === wanted) ? wanted : clean[0]?.id || "";
  return { activeId, threads: clean };
}

class GrokChatCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = {};
    this._messages = [];
    this._conversationId = null;
    this._touchedAt = 0;
    this._thread = null;
    this._busy = false;
    this._compose = "chat";
    this._runToken = 0;
    this._loaded = false;
    this._ready = false;
    this._mode = "loading";
    this._loadGen = 0;
    this._seq = 0;
    this._listOpen = false;
    this._armDelete = "";
    this._listGen = 0;
    this._viewGen = 0;
    this._saveFlag = "";
    this._writeChain = Promise.resolve();
    this._store = { activeId: "", threads: [] };
    this._configReady = false;
    this._storeTrusted = false;
    this._saveEpoch = 0;
    this._epochUi = 0;
  }

  static getConfigElement() {
    return document.createElement("grok-chat-card-editor");
  }

  static getStubConfig() {
    return {
      title: "Grok",
      pipeline_id: "preferred",
      ai_task_entity: "",
      camera_entity: "",
    };
  }

  setConfig(config) {
    const prev = this._loaded ? this._cardKey() : "";
    const merged = {
      title: "Grok",
      pipeline_id: "preferred",
      ai_task_entity: "",
      camera_entity: "",
      ...config,
    };
    const next = `${merged.pipeline_id || "preferred"}:${merged.ai_task_entity || ""}`;
    if (this._loaded && prev !== next) this._stop();
    this._config = merged;
    const draft = this._input ? this._input.value : "";
    this._render();
    if (draft && this._input) this._input.value = draft;
    this._configReady = true;
    if (!this._hass) return;
    if (!this._loaded) {
      this._loaded = true;
      this._boot();
    } else if (prev !== next) {
      this._boot();
    }
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._rootBuilt) this._render();
    if (!this._loaded && this._configReady) {
      this._loaded = true;
      this._boot();
    } else if (this._ready && !this._storeTrusted) {
      this._retryStore();
    } else if (this._ready) {
      this._rehydrateImages();
    }
  }

  getCardSize() {
    return 6;
  }

  _cardKey() {
    return `${this._config.pipeline_id || "preferred"}:${this._config.ai_task_entity || ""}`;
  }

  _userKey() {
    return `grok-haus:${this._cardKey()}`;
  }

  _ws(msg, ms = 8000) {
    let pending;
    try {
      pending = this._hass?.callWS
        ? this._hass.callWS(msg)
        : this._hass?.connection?.sendMessagePromise(msg);
    } catch (err) {
      return Promise.reject(err);
    }
    if (!pending || typeof pending.then !== "function") return Promise.reject(new Error("no-ws"));
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        fn(value);
      };
      const timer = setTimeout(() => {
        const err = new Error("timeout");
        if (msg.type === "frontend/get_user_data") err.load = true;
        finish(reject, err);
      }, ms);
      Promise.resolve(pending).then(
        (value) => finish(resolve, value),
        (err) => finish(reject, err),
      );
    });
  }

  _storeValue(data) {
    return normalizeStore(data && Object.prototype.hasOwnProperty.call(data, "value") ? data.value : data);
  }

  async _boot() {
    const gen = ++this._loadGen;
    this._epochUi += 1;
    this._saveEpoch += 1;
    this._storeTrusted = false;
    this._viewGen += 1;
    this._ready = false;
    this._mode = "loading";
    this._listOpen = false;
    this._revokeImages();
    this._messages = [];
    this._thread = null;
    this._store = { activeId: "", threads: [] };
    this._paint();
    let store = { activeId: "", threads: [] };
    let failed = false;
    try {
      const data = await this._ws({ type: "frontend/get_user_data", key: this._userKey() }, 4000);
      if (gen !== this._loadGen) return;
      store = this._storeValue(data);
    } catch (err) {
      if (gen !== this._loadGen) return;
      failed = true;
      const wrapped = err instanceof Error ? err : new Error(String(err?.message || err || "load"));
      wrapped.load = true;
      this._noteSave(wrapped);
    }
    if (gen !== this._loadGen) return;
    try {
      let dirty = false;
      if (!store.threads.length) {
        const thread = blankThread();
        store = { activeId: thread.id, threads: [thread] };
        dirty = !failed;
      }
      const thread = store.threads.find((item) => item.id === store.activeId) || store.threads[0];
      this._store = store;
      this._storeTrusted = !failed;
      this._showMemory(thread);
      if (this._storeTrusted && dirty) this._save();
      if (failed) this._retryAfter = Date.now() + 8000;
    } catch (_) {
      if (gen !== this._loadGen) return;
      const thread = blankThread();
      this._store = { activeId: thread.id, threads: [thread] };
      this._storeTrusted = false;
      this._ready = true;
      this._thread = thread;
      this._messages = [];
      this._paint();
      const err = new Error("load");
      err.load = true;
      this._noteSave(err);
    }
  }

  _retryStore() {
    if (this._retrying || this._busy || this._messages.length) return;
    if (this._retryAfter && Date.now() < this._retryAfter) return;
    this._retrying = true;
    this._retryAfter = Date.now() + 15000;
    const gen = this._loadGen;
    this._ws({ type: "frontend/get_user_data", key: this._userKey() }, 4000)
      .then((data) => {
        if (gen !== this._loadGen || this._busy || this._messages.length) return;
        const store = this._storeValue(data);
        if (!store.threads.length) {
          this._storeTrusted = true;
          this._noteSave(null);
          this._save();
          return;
        }
        const thread = store.threads.find((item) => item.id === store.activeId) || store.threads[0];
        this._store = store;
        this._storeTrusted = true;
        this._showMemory(thread);
        this._noteSave(null);
      })
      .catch(() => {})
      .finally(() => {
        this._retrying = false;
      });
  }

  _threads() {
    return (this._store?.threads || []).slice().sort((a, b) => (b.updated || 0) - (a.updated || 0));
  }

  _syncThread() {
    if (!this._store || !this._thread) return;
    let thread = this._store.threads.find((item) => item.id === this._thread.id);
    if (!thread) {
      thread = blankThread();
      thread.id = this._thread.id;
      this._store.threads.unshift(thread);
    }
    thread.title = this._thread.title || HAUS_NEW_TITLE;
    thread.conversationId = this._conversationId || null;
    thread.touchedAt = this._touchedAt || 0;
    thread.updated = Date.now();
    thread.messages = this._messages.slice(-HAUS_MAX_MESSAGES).map(slimMessage);
    this._thread.updated = thread.updated;
    this._store.activeId = thread.id;
    this._store.threads.sort((a, b) => (b.updated || 0) - (a.updated || 0));
    if (this._store.threads.length > HAUS_MAX_THREADS) {
      const keep = new Set(this._store.threads.slice(0, HAUS_MAX_THREADS).map((item) => item.id));
      keep.add(thread.id);
      this._store.threads = this._store.threads.filter((item) => keep.has(item.id)).slice(0, HAUS_MAX_THREADS);
    }
  }

  _showMemory(thread) {
    this._revokeImages();
    const messages = (thread.messages || []).slice(-HAUS_MAX_MESSAGES).map((m, i) => {
      const slim = slimMessage(m, i);
      return {
        ...slim,
        pending: false,
        text: slim.role === "user" ? slim.text : stuckText(slim.text),
      };
    });
    this._seq = messages.reduce((max, m) => Math.max(max, m.seq || 0), 0);
    this._thread = thread;
    this._messages = messages;
    this._conversationId = thread.conversationId || null;
    this._touchedAt = thread.touchedAt || 0;
    this._imagesReady = false;
    this._ready = true;
    this._mode = "remote";
    this._store.activeId = thread.id;
    this._paint();
    this._rehydrateImages();
  }

  _dropBlobs(messages) {
    for (const m of messages) {
      if (typeof m.image === "string" && m.image.startsWith("blob:")) URL.revokeObjectURL(m.image);
    }
  }

  _revokeImages() {
    this._dropBlobs(this._messages);
  }

  _save() {
    if (!this._storeTrusted || !this._hass || !this._store || !this._thread) return;
    this._syncThread();
    const key = this._userKey();
    const epoch = this._saveEpoch;
    const value = {
      activeId: this._store.activeId,
      threads: this._store.threads.map((thread) => ({
        id: thread.id,
        title: thread.title || HAUS_NEW_TITLE,
        conversationId: thread.conversationId || null,
        touchedAt: thread.touchedAt || 0,
        updated: thread.updated || 0,
        messages: (thread.messages || []).slice(-HAUS_MAX_MESSAGES).map(slimMessage),
      })),
    };
    this._writeChain = this._writeChain
      .then(async () => {
        await this._ws({ type: "frontend/set_user_data", key, value });
        if (epoch !== this._saveEpoch) return;
        this._noteSave(null);
      })
      .catch((err) => {
        if (epoch !== this._saveEpoch) return;
        this._noteSave(err);
      });
  }

  _saveSoon() {
    clearTimeout(this._saveTimer);
    const threadId = this._thread?.id;
    this._saveTimer = setTimeout(() => {
      if (this._thread?.id !== threadId) return;
      this._save();
    }, 1200);
  }

  _noteSave(err) {
    const next = !err
      ? ""
      : err.load
        ? "Verlauf konnte nicht geladen werden."
        : "Verlauf konnte nicht gespeichert werden.";
    if (next === this._saveFlag) return;
    this._saveFlag = next;
    this._paintFlag();
  }

  _paintFlag() {
    const el = this.shadowRoot && this.shadowRoot.getElementById("saveflag");
    if (!el) return;
    el.hidden = !this._saveFlag;
    el.textContent = this._saveFlag || "";
  }

  _render() {
    if (!this.shadowRoot) return;
    this._rootBuilt = true;
    const camBtn = this._config.camera_entity ? `<button type="button" id="cam">Kamera</button>` : "";
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; color: var(--primary-text-color); }
        ha-card { display: flex; flex-direction: column; overflow: hidden; }
        header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 14px 14px 12px; }
        .titles { display: flex; flex-direction: column; gap: 0; min-width: 0; flex: 1; }
        #cardtitle { font-size: 16px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.2; }
        .limit { display: block; font-size: 12px; line-height: 1.35; opacity: 0.45; margin-top: 12px; }
        button.ghost {
          display: block;
          width: 100%;
          margin-top: 8px;
          background: color-mix(in srgb, var(--primary-text-color) 7%, transparent);
          border: 0;
          border-radius: 10px;
          padding: 6px 10px;
          min-height: 32px;
          min-width: 0;
          max-width: 100%;
          font-size: 13px;
          font-weight: 500;
          opacity: 1;
          text-align: left;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        button.ghost[hidden] { display: none; }
        button.ghost::after { content: "▾"; margin-left: 6px; opacity: 0.55; font-size: 11px; }
        .actions { display: flex; gap: 4px; flex: none; }
        #clear, #stop {
          background: transparent;
          border: 0;
          color: var(--primary-text-color);
          opacity: 0.85;
          min-height: 32px;
          padding: 4px 8px;
          font-size: 13px;
          font-weight: 500;
        }
        #saveflag { margin: 4px 14px 0; color: var(--error-color, #c62828); font-size: 13px; }
        #threadlist { display: flex; flex-direction: column; gap: 2px; max-height: 240px; overflow: auto; margin: 8px 10px 0; padding: 4px; border-radius: 12px; background: color-mix(in srgb, var(--primary-text-color) 6%, transparent); }
        #threadlist[hidden] { display: none; }
        #stop { opacity: 1; color: var(--error-color, #ef5350); }
        #threadlist button { background: transparent; border: 0; border-radius: 8px; text-align: left; min-height: 36px; }
        .trow { display: flex; gap: 4px; align-items: center; }
        .trow .pick { flex: 1; text-align: left; background: transparent; }
        .msgs, .bubble, .empty {
          user-select: text !important;
          -webkit-user-select: text !important;
          -webkit-touch-callout: default;
        }
        .msgs { overflow-y: auto; max-height: 420px; padding: 4px 16px 12px; display: flex; flex-direction: column; gap: 10px; }
        .empty { max-width: 28rem; margin: 8px 0; color: var(--primary-text-color); opacity: 0.55; font-size: 15px; line-height: 1.45; }
        .row { display: flex; }
        .row.user { justify-content: flex-end; }
        .bubble { max-width: 88%; white-space: pre-wrap; word-break: break-word; font-size: 15px; line-height: 1.5; }
        .row.user .bubble { max-width: 82%; padding: 10px 14px; border-radius: 18px; border-bottom-right-radius: 6px; background: var(--primary-color); color: var(--text-primary-color, #fff); }
        .row.bot .bubble {
          padding: 10px 14px;
          border-radius: 18px;
          border-bottom-left-radius: 6px;
          background: color-mix(in srgb, var(--primary-text-color) 7%, transparent);
          color: var(--primary-text-color);
        }
        .row.bot .bubble.err { color: var(--error-color, #ef5350); }
        .bubble img { display: block; width: 100%; height: auto; max-width: 100%; border-radius: 12px; margin-top: 8px; }
        .bubble img:first-child { margin-top: 0; }
        .err { color: var(--error-color, #ef5350); }
        .row.user .err { color: var(--text-primary-color, #fff); }
        .pending { opacity: 0.62; }
        footer { padding: 8px 14px 20px; }
        .dock { display: flex; flex-direction: column; gap: 10px; padding: 0; }
        .field { display: flex; align-items: center; gap: 8px; }
        .dockbar { display: flex; flex-flow: row wrap; align-items: center; justify-content: flex-start; gap: 6px; }
        .dockbar > * { flex: 0 0 auto; }
        button, label.filebtn {
          cursor: pointer;
          border: 0;
          border-radius: 12px;
          padding: 8px 10px;
          min-height: 36px;
          background: transparent;
          color: var(--primary-text-color);
          font: inherit;
          font-size: 13px;
          font-weight: 600;
        }
        label.filebtn { display: inline-flex; align-items: center; }
        .dockbar button, .dockbar label.filebtn {
          opacity: 1;
          background: color-mix(in srgb, var(--primary-text-color) 10%, transparent);
          border-radius: 999px;
          padding: 8px 14px;
        }
        .dockbar label.filebtn {
          background: transparent;
          padding: 8px 6px;
          min-height: 36px;
          font-size: 13px;
          font-weight: 500;
          opacity: 0.72;
        }
        .dockbar button.mode.on {
          background: var(--primary-color);
          color: var(--text-primary-color, #fff);
        }
        button.primary { background: var(--primary-color); color: var(--text-primary-color, #fff); opacity: 1; }
        button:disabled, label.filebtn.disabled, input:disabled { opacity: 0.4; pointer-events: none; }
        input[type="text"] {
          flex: 1;
          min-width: 0;
          width: auto;
          border: 0;
          border-radius: 12px;
          padding: 0 12px;
          min-height: 36px;
          height: 36px;
          background: color-mix(in srgb, var(--primary-text-color) 6%, transparent);
          color: var(--primary-text-color);
          font: inherit;
          font-size: 15px;
          outline: none;
        }
        input[type="text"]::placeholder { color: var(--primary-text-color); opacity: 0.4; }
        input[type="text"]:focus { box-shadow: inset 0 0 0 1px var(--primary-color); }
        input[type="file"] { display: none; }
      </style>
      <ha-card>
        <header>
          <div class="titles">
            <span id="cardtitle"></span>
            <button type="button" id="threads" class="ghost"></button>
            <span class="limit" id="limit">Grok sieht den Chat nur etwa fünf Minuten.</span>
          </div>
          <span class="actions">
            <button type="button" id="stop" hidden>Stopp</button>
            <button type="button" id="clear">Leeren</button>
          </span>
        </header>
        <p id="saveflag" hidden></p>
        <div id="threadlist" hidden></div>
        <div class="msgs" id="msgs"></div>
        <footer>
          <div class="dock">
            <div class="field">
              <input type="text" id="q" placeholder="Nachricht…" autocomplete="off">
              <button type="button" id="send" class="primary">Senden</button>
            </div>
            <div class="dockbar">
              <button type="button" id="mode-chat" class="mode on">Chat</button>
              <button type="button" id="mode-bild" class="mode">Bild</button>
              ${camBtn}
              <label class="filebtn">Foto<input type="file" id="file" accept="image/*"></label>
            </div>
          </div>
        </footer>
      </ha-card>
    `;
    this._msgsEl = this.shadowRoot.getElementById("msgs");
    this._input = this.shadowRoot.getElementById("q");
    this._stopBtn = this.shadowRoot.getElementById("stop");
    this._listEl = this.shadowRoot.getElementById("threadlist");
    this.shadowRoot.getElementById("send").onclick = () => this._sendText();
    this.shadowRoot.getElementById("clear").onclick = () => this._clearThread();
    this._stopBtn.onclick = () => this._stop();
    this.shadowRoot.getElementById("mode-chat").onclick = () => this._setCompose("chat");
    this.shadowRoot.getElementById("mode-bild").onclick = () => this._setCompose("bild");
    this.shadowRoot.getElementById("threads").onclick = () => this._toggleList();
    const cam = this.shadowRoot.getElementById("cam");
    if (cam) cam.onclick = () => this._camera();
    this.shadowRoot.getElementById("file").onchange = (e) => this._file(e);
    this._input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this._sendText();
      }
    });
    this._msgsEl.addEventListener("scroll", () => {
      const el = this._msgsEl;
      if (!el) return;
      this._followEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    });
    this._paint();
    if (this._listOpen && this._store) this._fillList();
  }

  _follow() {
    const el = this._msgsEl;
    if (!el || this._followEnd === false) return;
    el.scrollTop = el.scrollHeight;
  }

  _escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (ch) => {
      switch (ch) {
        case "&":
          return "&" + "amp;";
        case "<":
          return "&" + "lt;";
        case ">":
          return "&" + "gt;";
        case '"':
          return "&" + "quot;";
        default:
          return "&" + "#39;";
      }
    });
  }

  _format(s) {
    return this._escape(s).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  }

  _paint() {
    const cardTitle = this.shadowRoot && this.shadowRoot.getElementById("cardtitle");
    if (cardTitle) cardTitle.textContent = this._config.title || "Grok";
    const title = this.shadowRoot && this.shadowRoot.getElementById("threads");
    if (title) {
      title.hidden = !this._ready;
      title.textContent = this._thread?.title || HAUS_NEW_TITLE;
    }
    this._paintFlag();
    const limit = this.shadowRoot && this.shadowRoot.getElementById("limit");
    if (limit) limit.textContent = "Grok sieht den Chat nur etwa fünf Minuten.";
    if (this._listEl) this._listEl.hidden = !this._listOpen;
    if (!this._msgsEl) return;
    const follow = this._followEnd !== false;
    let rows = this._messages;
    if (!this._ready && !rows.length) {
      rows = [{ role: "assistant", text: "Gespräch wird geladen…", pending: true }];
    }
    if (!rows.length) {
      this._msgsEl.innerHTML = `<p class="empty">Noch nichts in diesem Gespräch.</p>`;
    } else {
    this._msgsEl.innerHTML = rows
      .map((m) => {
        const img = m.image ? `<img src="${this._escape(m.image)}" alt="">` : "";
        const cls = m.role === "user" ? "user" : "bot";
        const extra = `${m.error ? " err" : ""}${m.pending ? " pending" : ""}`;
        return `<div class="row ${cls}"><div class="bubble${extra}">${this._format(m.text || "")}${img}</div></div>`;
      })
      .join("");
    }
    this._msgsEl.querySelectorAll("img").forEach((img) => {
      if (!img.complete) img.addEventListener("load", () => this._follow(), { once: true });
    });
    if (follow) this._followEnd = true;
    this._follow();
    const locked = !this._ready;
    this.shadowRoot.querySelectorAll("button, label.filebtn").forEach((el) => {
      if (el.id === "stop" || el.closest("#threadlist")) return;
      if (el.id === "threads") {
        el.disabled = locked;
        return;
      }
      if (el.id === "clear") {
        el.disabled = locked;
        return;
      }
      el.disabled = locked || this._busy;
      el.classList.toggle("disabled", locked || this._busy);
    });
    if (this._input) this._input.disabled = locked;
    if (this._input) this._input.placeholder = this._compose === "bild" ? "Was soll zu sehen sein…" : "Nachricht…";
    const send = this.shadowRoot.getElementById("send");
    if (send) send.textContent = this._compose === "bild" ? "Erzeugen" : "Senden";
    const chatMode = this.shadowRoot.getElementById("mode-chat");
    const bildMode = this.shadowRoot.getElementById("mode-bild");
    if (chatMode) chatMode.classList.toggle("on", this._compose !== "bild");
    if (bildMode) bildMode.classList.toggle("on", this._compose === "bild");
    if (this._stopBtn) this._stopBtn.hidden = !this._busy;
  }

  async _toggleList() {
    if (!this._ready || !this._store) return;
    this._listOpen = !this._listOpen;
    this._armDelete = "";
    if (this._listEl) this._listEl.hidden = !this._listOpen;
    if (this._listOpen) this._fillList();
  }

  _fillList() {
    if (!this._listEl || !this._store) return;
    const threads = this._threads();
    this._listEl.replaceChildren();
    const fresh = document.createElement("button");
    fresh.type = "button";
    fresh.textContent = "Neues Gespräch";
    fresh.onclick = () => this._newThread(threads.length);
    this._listEl.appendChild(fresh);
    for (const thread of threads) {
      const row = document.createElement("div");
      row.className = "trow";
      const pick = document.createElement("button");
      pick.type = "button";
      pick.className = "pick";
      const when = thread.updated ? new Date(thread.updated).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
      pick.textContent = when ? `${thread.title || HAUS_NEW_TITLE} · ${when}` : thread.title || HAUS_NEW_TITLE;
      pick.onclick = () => this._switchThread(thread.id);
      const del = document.createElement("button");
      del.type = "button";
      del.textContent = this._armDelete === thread.id ? "Wirklich" : "Löschen";
      del.onclick = () => this._deleteThread(thread.id);
      row.append(pick, del);
      this._listEl.appendChild(row);
    }
  }

  _newThread(count) {
    const total = count == null ? this._threads().length : count;
    if (total >= HAUS_MAX_THREADS) {
      this._listOpen = false;
      this._push("assistant", "50 Gespräche sind voll. Eins löschen, dann geht neu.", { error: true });
      return;
    }
    this._epochUi += 1;
    this._stop();
    this._syncThread();
    const thread = blankThread();
    this._store.threads.unshift(thread);
    this._listOpen = false;
    this._showMemory(thread);
    this._save();
  }

  async _switchThread(id) {
    if (id === this._thread?.id) {
      this._listOpen = false;
      this._paint();
      return;
    }
    const op = ++this._epochUi;
    const load = this._loadGen;
    this._stop();
    this._syncThread();
    await this._writeChain;
    if (op !== this._epochUi || load !== this._loadGen) return;
    const thread = this._store?.threads.find((item) => item.id === id);
    if (!thread) {
      this._fillList();
      return;
    }
    this._listOpen = false;
    this._showMemory(thread);
    this._save();
  }

  async _deleteThread(id) {
    if (this._armDelete !== id) {
      this._armDelete = id;
      this._fillList();
      return;
    }
    const op = ++this._epochUi;
    const load = this._loadGen;
    this._armDelete = "";
    if (this._thread?.id === id) this._stop();
    await this._writeChain;
    if (op !== this._epochUi || load !== this._loadGen) return;
    if (!this._store?.threads.some((item) => item.id === id)) return;
    this._store.threads = this._store.threads.filter((item) => item.id !== id);
    if (this._thread?.id !== id) {
      this._save();
      this._fillList();
      return;
    }
    const next = this._threads()[0] || blankThread();
    if (!this._store.threads.some((item) => item.id === next.id)) this._store.threads.unshift(next);
    this._listOpen = false;
    this._showMemory(next);
    this._save();
  }

  async _clearThread() {
    this._epochUi += 1;
    const threadId = this._thread?.id;
    this._stop();
    this._revokeImages();
    this._messages = [];
    this._conversationId = null;
    this._touchedAt = 0;
    if (this._thread && this._thread.id === threadId) {
      this._thread.title = HAUS_NEW_TITLE;
      this._thread.conversationId = null;
      this._thread.touchedAt = 0;
    }
    this._save();
    this._paint();
  }

  _push(role, text, extra = {}) {
    const msg = {
      id: hausId(),
      seq: ++this._seq,
      role,
      text,
      pending: false,
      error: false,
      ...extra,
    };
    this._messages.push(msg);
    if (this._messages.length > HAUS_MAX_MESSAGES) {
      this._dropBlobs(this._messages.splice(0, this._messages.length - HAUS_MAX_MESSAGES));
    }
    if (role === "user" && this._thread && this._thread.title === HAUS_NEW_TITLE && text) {
      this._thread.title = hausTitle(text);
    }
    this._save();
    this._paint();
    return msg.id;
  }

  _sameRun(token, threadId) {
    return token === this._runToken && (!threadId || this._thread?.id === threadId);
  }

  _setMsg(id, patch, stream, token, threadId) {
    if (token != null && !this._sameRun(token, threadId)) return;
    const index = this._messages.findIndex((item) => item.id === id);
    const msg = index >= 0 ? this._messages[index] : null;
    if (!msg) return;
    Object.assign(msg, patch);
    if (stream && this._patchBubble(index)) {
      this._saveSoon();
      return;
    }
    if (msg.pending) this._saveSoon();
    else this._save();
    this._paint();
  }

  _patchBubble(index) {
    if (!this._msgsEl || this._msgsEl.children.length !== this._messages.length) return false;
    const bubble = this._msgsEl.children[index]?.querySelector(".bubble");
    if (!bubble) return false;
    const m = this._messages[index];
    bubble.className = `bubble${m.error ? " err" : ""}${m.pending ? " pending" : ""}`;
    const img = m.image ? `<img src="${this._escape(m.image)}" alt="">` : "";
    bubble.innerHTML = `${this._format(m.text || "")}${img}`;
    this._follow();
    return true;
  }

  _explain(err) {
    const msg = String(err?.message || err?.code || err || "Unbekannter Fehler");
    if (/\b(402|403)\b|payment|forbidden|unauthorized/i.test(msg)) {
      return `${msg} — Abo oder Proxy, kein Fehler in der Karte.`;
    }
    return msg;
  }

  _stop() {
    this._runToken += 1;
    this._busy = false;
    clearTimeout(this._saveTimer);
    if (this._fetchCtrl) {
      try {
        this._fetchCtrl.abort();
      } catch (_) {}
      this._fetchCtrl = null;
    }
    if (this._pendingUnsub) {
      try {
        this._pendingUnsub();
      } catch (_) {}
      this._pendingUnsub = null;
    }
    const settle = this._runSettle;
    this._runSettle = null;
    if (settle) settle();
    const last = this._messages[this._messages.length - 1];
    if (last && last.pending) {
      last.pending = false;
      const kept = last.text && last.text !== "schreibt…" && last.text !== "Bild wird erzeugt…" && last.text !== "schaut…";
      if (!kept) {
        last.text = "Abgebrochen.";
        last.error = true;
        last.image = undefined;
      }
    }
    this._save();
    this._paint();
  }

  _setCompose(mode) {
    if (this._busy || !this._ready) return;
    this._compose = mode === "bild" ? "bild" : "chat";
    this._paint();
    this._input?.focus();
  }

  async _sendText() {
    const text = (this._input?.value || "").trim();
    if (!text || !this._hass || this._busy || !this._ready) return;
    if (this._compose === "bild") return this._imagine();
    this._followEnd = true;
    this._input.value = "";
    this._push("user", text);
    await this._runPipeline(text);
  }

  _mergeSpeech(prev, chunk) {
    if (!chunk) return prev || "";
    if (!prev) return chunk;
    if (chunk.startsWith(prev)) return chunk;
    if (prev.endsWith(chunk)) return prev;
    return prev + chunk;
  }

  _rememberConversation(cid, threadId) {
    if (!this._thread || this._thread.id !== threadId) return;
    this._touchedAt = Date.now();
    if (cid) this._conversationId = cid;
    if (this._thread && this._thread.id === threadId) {
      this._thread.touchedAt = this._touchedAt;
      this._thread.conversationId = this._conversationId;
    }
    this._save();
  }

  async _runPipeline(text) {
    const token = ++this._runToken;
    const threadId = this._thread?.id;
    const conv = liveConversationId(this._conversationId, this._touchedAt, Date.now());
    this._busy = true;
    const idx = this._push("assistant", "schreibt…", { pending: true });
    let reply = "";
    let cid = "";
    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (err) => {
          if (settled) return;
          settled = true;
          if (this._runSettle === finish) this._runSettle = null;
          if (err) reject(err);
          else resolve();
        };
        this._runSettle = () => finish();
        const unsubPromise = this._hass.connection.subscribeMessage(
          (ev) => {
            if (!this._sameRun(token, threadId)) return;
            const type = ev?.type;
            const data = ev?.data || {};
            if (type === "intent-progress") {
              const delta =
                (typeof data.chat_log_delta?.content === "string" && data.chat_log_delta.content) ||
                (typeof data.delta === "string" && data.delta) ||
                (typeof data.chunk === "string" && data.chunk) ||
                "";
              if (delta) {
                reply = this._mergeSpeech(reply, delta);
                this._setMsg(idx, { text: reply, pending: true }, true, token, threadId);
              }
            }
            if (type === "intent-end") {
              const speech =
                data.intent_output?.response?.speech?.plain?.speech ||
                (typeof data.intent_output?.response?.speech?.plain === "string"
                  ? data.intent_output.response.speech.plain
                  : "") ||
                "";
              if (speech) {
                const spoken = String(speech);
                if (spoken.length >= reply.length) reply = spoken;
              }
              cid = data.intent_output?.conversation_id || data.conversation_id || ev?.conversation_id || cid;
            }
            if (type === "run-end" || type === "error") {
              cid = data.conversation_id || ev?.conversation_id || cid;
              if (type === "error") finish(new Error(data.message || data.code || "pipeline error"));
              else finish();
            }
          },
          {
            type: "assist_pipeline/run",
            start_stage: "intent",
            end_stage: "intent",
            input: { text },
            ...(this._config.pipeline_id && this._config.pipeline_id !== "preferred"
              ? { pipeline: this._config.pipeline_id }
              : {}),
            ...(conv ? { conversation_id: conv } : {}),
          },
        );
        Promise.resolve(unsubPromise).then(
          (unsub) => {
            if (token !== this._runToken) {
              try {
                unsub();
              } catch (_) {}
              return;
            }
            this._pendingUnsub = unsub;
          },
          (err) => finish(err instanceof Error ? err : new Error(err?.message || "Pipeline nicht gefunden.")),
        );
      });
      if (!this._sameRun(token, threadId)) return;
      this._rememberConversation(cid, threadId);
      this._setMsg(idx, { text: reply || "(keine Antwort)", pending: false }, false, token, threadId);
    } catch (err) {
      if (!this._sameRun(token, threadId)) return;
      this._setMsg(idx, { text: this._explain(err), pending: false, error: true }, false, token, threadId);
    } finally {
      if (token === this._runToken) {
        this._busy = false;
        if (this._pendingUnsub) {
          try {
            this._pendingUnsub();
          } catch (_) {}
          this._pendingUnsub = null;
        }
        this._paint();
      }
    }
  }

  _taskEntity() {
    return this._config.ai_task_entity || "";
  }

  async _call(domain, service, data) {
    return this._hass.connection.sendMessagePromise({
      type: "call_service",
      domain,
      service,
      service_data: data,
      return_response: true,
    });
  }

  _walk(node, depth = 0) {
    if (!node || depth > 6) return null;
    if (typeof node === "string") {
      if (node.startsWith("http") || node.startsWith("/") || node.startsWith("media-source://") || node.startsWith("data:")) {
        return { url: node };
      }
      return null;
    }
    if (typeof node !== "object") return null;
    const url = node.url || node.path || "";
    const mediaId = node.media_source_id || node.media_content_id || "";
    if (url || mediaId) return { url, mediaId };
    for (const key of ["response", "result", "data", "service_response"]) {
      if (node[key]) {
        const hit = this._walk(node[key], depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  }

  async _rehydrateImages() {
    if (this._imagesReady || !this._hass || !this._ready) return;
    const threadId = this._thread?.id;
    const need = this._messages.some((m) => !m.image && m.mediaId);
    if (!need) {
      this._imagesReady = true;
      return;
    }
    if (!this._hass.callWS || !this._hass.auth?.data?.access_token) return;
    this._imagesReady = true;
    let changed = false;
    for (const m of this._messages) {
      if (this._thread?.id !== threadId) return;
      if (m.image || !m.mediaId) continue;
      const image = await this._displayUrl({ mediaId: m.mediaId });
      if (this._thread?.id !== threadId) {
        if (typeof image === "string" && image.startsWith("blob:")) URL.revokeObjectURL(image);
        return;
      }
      if (!image) continue;
      m.image = image;
      changed = true;
    }
    if (changed && this._thread?.id === threadId) this._paint();
  }

  async _displayUrl(ref) {
    if (!ref) return "";
    let url = ref.url || "";
    let mediaId = ref.mediaId || "";
    if (!mediaId && url.startsWith("media-source://")) mediaId = url;
    const signed = url.includes("authSig=");
    if (!signed && mediaId && this._hass.callWS) {
      try {
        const resolved = await this._hass.callWS({
          type: "media_source/resolve_media",
          media_content_id: mediaId,
        });
        if (resolved?.url) url = resolved.url;
      } catch (_) {}
    }
    if (!url || url.startsWith("media-source://")) return "";
    if (url.startsWith("data:") || url.startsWith("blob:")) return url;
    const abs = url.startsWith("http") ? url : this._hass.hassUrl(url.startsWith("/") ? url : `/${url}`);
    if (signed || abs.includes("authSig=")) return abs;
    if (abs.includes("/api/") || abs.includes("/media/")) {
      try {
        const resp = await fetch(abs, {
          headers: { Authorization: `Bearer ${this._hass.auth?.data?.access_token || ""}` },
        });
        if (!resp.ok) return "";
        return URL.createObjectURL(await resp.blob());
      } catch (_) {
        return "";
      }
    }
    return abs;
  }

  async _imagine() {
    const prompt = (this._input?.value || "").trim();
    if (!prompt) {
      this._push("assistant", "Erst einen Text ins Feld schreiben.", { error: true });
      return;
    }
    const entity = this._taskEntity();
    if (!entity) {
      this._push("assistant", "ai_task_entity in der Karte setzen.", { error: true });
      return;
    }
    if (!this._hass || this._busy || !this._ready) return;
    this._followEnd = true;
    this._input.value = "";
    this._push("user", prompt);
    const token = ++this._runToken;
    const threadId = this._thread?.id;
    this._busy = true;
    const idx = this._push("assistant", "Bild wird erzeugt…", { pending: true });
    try {
      const res = await this._call("ai_task", "generate_image", {
        task_name: "grok chat imagine",
        instructions: prompt,
        entity_id: entity,
      });
      if (!this._sameRun(token, threadId)) return;
      const body = res?.response || res || {};
      const ref = this._walk(body) || this._walk(res);
      const image = await this._displayUrl(ref);
      if (!this._sameRun(token, threadId)) return;
      const note = image ? "" : "Kein Bild in der Antwort.";
      this._setMsg(
        idx,
        { text: note, image: image || undefined, mediaId: ref?.mediaId || undefined, pending: false, error: !image },
        false,
        token,
        threadId,
      );
    } catch (err) {
      if (!this._sameRun(token, threadId)) return;
      this._setMsg(idx, { text: this._explain(err), pending: false, error: true }, false, token, threadId);
    } finally {
      if (token === this._runToken) {
        this._busy = false;
        this._paint();
      }
    }
  }

  async _camera() {
    const cam = this._config.camera_entity;
    const entity = this._taskEntity();
    if (!cam || !entity) {
      this._push("assistant", "camera_entity und ai_task_entity setzen.", { error: true });
      return;
    }
    if (!this._ready || this._busy) return;
    const q = (this._input?.value || "").trim() || "Was ist auf dem Bild? Auf Deutsch.";
    this._followEnd = true;
    this._input.value = "";
    this._push("user", q);
    await this._analyze({
      media_content_id: `media-source://camera/${cam}`,
      media_content_type: "image/jpeg",
      instructions: q,
    });
  }

  async _file(ev) {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = "";
    if (!file || !this._hass || this._busy || !this._ready) return;
    const entity = this._taskEntity();
    if (!entity) {
      this._push("assistant", "ai_task_entity setzen.", { error: true });
      return;
    }
    this._push("user", file.name);
    const token = this._runToken;
    const threadId = this._thread?.id;
    this._busy = true;
    this._paint();
    const ctrl = new AbortController();
    this._fetchCtrl = ctrl;
    let started = false;
    try {
      const fd = new FormData();
      fd.append("media_content_id", HAUS_MEDIA);
      fd.append("file", file);
      const resp = await fetch("/api/media_source/local_source/upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${this._hass.auth?.data?.access_token || ""}` },
        body: fd,
        signal: ctrl.signal,
      });
      if (!this._sameRun(token, threadId)) return;
      if (!resp.ok) {
        if (resp.status === 401 || resp.status === 403) throw new Error("Upload nur als Admin. Sonst die Kamera nehmen.");
        throw new Error(`Upload ${resp.status}. Ordner /media/grok-haus anlegen oder nur Kamera nutzen.`);
      }
      const data = await resp.json();
      if (!this._sameRun(token, threadId)) return;
      const mid = data.media_content_id || `${HAUS_MEDIA}/${file.name}`;
      const q = (this._input?.value || "").trim() || "Beschreibe das Bild auf Deutsch.";
      this._input.value = "";
      started = true;
      await this._analyze({
        media_content_id: mid,
        media_content_type: file.type || "image/jpeg",
        instructions: q,
      });
    } catch (err) {
      if (!this._sameRun(token, threadId) || err?.name === "AbortError") return;
      this._push("assistant", this._explain(err), { error: true });
      this._busy = false;
      this._paint();
    } finally {
      if (this._fetchCtrl === ctrl) this._fetchCtrl = null;
      if (!started && this._runToken === token) {
        this._busy = false;
        this._paint();
      }
    }
  }

  async _analyze({ media_content_id, media_content_type, instructions }) {
    const entity = this._taskEntity();
    const token = ++this._runToken;
    const threadId = this._thread?.id;
    this._busy = true;
    const idx = this._push("assistant", "schaut…", { pending: true });
    try {
      const res = await this._call("ai_task", "generate_data", {
        task_name: "grok chat vision",
        entity_id: entity,
        instructions,
        attachments: [{ media_content_id, media_content_type }],
      });
      if (!this._sameRun(token, threadId)) return;
      const body = res?.response || res || {};
      const data = body.data !== undefined ? body.data : body;
      const text =
        (typeof data === "string" && data) ||
        data?.text ||
        data?.response ||
        (data && typeof data === "object" ? JSON.stringify(data, null, 2) : "") ||
        "(keine Antwort)";
      this._setMsg(idx, { text, pending: false }, false, token, threadId);
    } catch (err) {
      if (!this._sameRun(token, threadId)) return;
      this._setMsg(idx, { text: this._explain(err), pending: false, error: true }, false, token, threadId);
    } finally {
      if (token === this._runToken) {
        this._busy = false;
        this._paint();
      }
    }
  }
}

function stuckText(text) {
  if (text === "schreibt…" || text === "Bild wird erzeugt…" || text === "schaut…") return "Abgebrochen.";
  return text || "";
}

class GrokChatCardEditor extends HTMLElement {
  constructor() {
    super();
    this._config = {};
    this._hass = null;
    this._built = false;
    this._pipelines = [];
  }

  setConfig(config) {
    this._config = { ...config };
    this._ensure();
  }

  set hass(hass) {
    this._hass = hass;
    this._ensure();
    if (this._built && !this._pipelines.length) this._loadPipelines();
    this._fillEntities();
  }

  _ensure() {
    if (!this._hass || !this._config || this._built) return;
    this._build();
    this._loadPipelines();
    this._fillEntities();
  }

  _fire() {
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config: { ...this._config } },
        bubbles: true,
        composed: true,
      }),
    );
  }

  _set(key, value) {
    this._config = { ...this._config, [key]: value };
    this._fire();
  }

  _build() {
    this._built = true;
    this.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:12px;padding:8px 0">
        <label>Titel<br><input id="title" style="width:100%"></label>
        <label>Pipeline<br><select id="pipeline" style="width:100%"></select></label>
        <label>AI Task<br><select id="task" style="width:100%"></select></label>
        <label>Kamera<br><select id="camera" style="width:100%"></select></label>
      </div>
    `;
    this.querySelector("#title").value = this._config.title || "Grok";
    this.querySelector("#title").addEventListener("change", (e) => this._set("title", e.target.value));
    this.querySelector("#pipeline").addEventListener("change", (e) => this._set("pipeline_id", e.target.value));
    this.querySelector("#task").addEventListener("change", (e) => this._set("ai_task_entity", e.target.value));
    this.querySelector("#camera").addEventListener("change", (e) => this._set("camera_entity", e.target.value));
  }

  _options(select, values, current, placeholder) {
    if (!select) return;
    const cur = current == null ? "" : String(current);
    const items = values.slice();
    if (cur && !items.some((item) => item.value === cur)) {
      items.unshift({ value: cur, label: cur });
    }
    select.innerHTML = "";
    if (placeholder) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = placeholder;
      select.appendChild(opt);
    }
    for (const item of items) {
      const opt = document.createElement("option");
      opt.value = item.value;
      opt.textContent = item.label;
      select.appendChild(opt);
    }
    select.value = [...select.options].some((o) => o.value === cur) ? cur : select.options[0]?.value || "";
  }

  _fillEntities() {
    if (!this._hass || !this._built) return;
    const states = this._hass.states || {};
    const tasks = Object.keys(states)
      .filter((id) => id.startsWith("ai_task."))
      .map((id) => ({ value: id, label: states[id].attributes?.friendly_name || id }));
    const cams = Object.keys(states)
      .filter((id) => id.startsWith("camera."))
      .map((id) => ({ value: id, label: states[id].attributes?.friendly_name || id }));
    const sig = `${tasks.map((t) => t.value).join(",")}|${cams.map((c) => c.value).join(",")}`;
    if (sig === this._entitySig) return;
    this._entitySig = sig;
    this._options(this.querySelector("#task"), tasks, this._config.ai_task_entity, "wählen");
    this._options(this.querySelector("#camera"), cams, this._config.camera_entity || "", "keine");
  }

  async _loadPipelines() {
    const select = this.querySelector("#pipeline");
    const base = [
      { value: "preferred", label: "Bevorzugt" },
      { value: "last_used", label: "Zuletzt benutzt" },
    ];
    this._options(select, base, this._config.pipeline_id || "preferred");
    try {
      const res = await (this._hass.callWS
        ? this._hass.callWS({ type: "assist_pipeline/pipeline/list" })
        : this._hass.connection.sendMessagePromise({ type: "assist_pipeline/pipeline/list" }));
      const list = (res?.pipelines || []).map((p) => ({
        value: p.id,
        label: p.name || p.id,
      }));
      this._pipelines = list;
      this._options(select, [...base, ...list], this._config.pipeline_id || "preferred");
    } catch (_) {}
  }
}

if (!customElements.get("grok-chat-card")) {
  customElements.define("grok-chat-card", GrokChatCard);
}
if (!customElements.get("grok-chat-card-editor")) {
  customElements.define("grok-chat-card-editor", GrokChatCardEditor);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "grok-chat-card")) {
  window.customCards.push({
    type: "grok-chat-card",
    name: "Grok Chat Card",
    description: "Assist-Chat, Imagine und Kamera/Foto über SuperGrok AI Task",
    preview: false,
  });
}
