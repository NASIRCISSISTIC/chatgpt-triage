// ==UserScript==
// @name         Triage
// @namespace    https://github.com/NASIRCISSISTIC/chatgpt-triage
// @version      1.0.2
// @description  Bulk delete, archive and rename your ChatGPT chats without the "Too many requests" lockout. Read each chat first, queue your changes, and let them run at a safe pace.
// @author       Nasir Yar Khan
// @license      MIT
// @homepageURL  https://github.com/NASIRCISSISTIC/chatgpt-triage
// @supportURL   https://github.com/NASIRCISSISTIC/chatgpt-triage/issues
// @updateURL    https://raw.githubusercontent.com/NASIRCISSISTIC/chatgpt-triage/main/chatgpt-triage.user.js
// @downloadURL  https://raw.githubusercontent.com/NASIRCISSISTIC/chatgpt-triage/main/chatgpt-triage.user.js
// @match        https://chatgpt.com/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * Triage
 *
 * Works two ways:
 *   - As a userscript (Tampermonkey, Violentmonkey): adds a Triage button to chatgpt.com.
 *   - Pasted into the browser console on chatgpt.com: opens straight away.
 *
 * Everything runs in your browser. The only server it talks to is chatgpt.com,
 * using the same private web API the ChatGPT site uses. That API is undocumented,
 * so a ChatGPT update can break things; Triage checks the data it gets back and
 * switches changes off if it looks unfamiliar.
 *
 * MIT License. Not affiliated with OpenAI.
 */
(function triageForChatGPT() {
  "use strict";

  if (window.__chatgptTriage) {
    window.__chatgptTriage.open();
    return;
  }

  // ---------------------------------------------------------------------------
  // Settings and constants
  // ---------------------------------------------------------------------------

  // One source for the version: the @version line above, which a userscript manager passes in as GM_info.
  // Pasted into the console there's no GM_info, so it falls back to this copy.
  const VERSION = (typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) || "1.0.2";
  const APP = "chatgpt-triage";
  const HOMEPAGE = "https://github.com/NASIRCISSISTIC/chatgpt-triage";
  // The demo page and the test harness set this to speed up waits. chatgpt.com never does.
  const TEST = window.__TRIAGE_TEST__ && typeof window.__TRIAGE_TEST__ === "object" ? window.__TRIAGE_TEST__ : {};
  const SCALE = Number(TEST.timeScale) > 0 ? Number(TEST.timeScale) : 1;
  const IS_USERSCRIPT = typeof GM_info !== "undefined";

  const SEC = 1000;
  const MIN = 60 * SEC;
  const DAY = 24 * 60 * MIN;
  const CFG = {
    pageSize: 100,
    maxPages: 200,
    requestGap: 1200, // minimum time between any two requests to ChatGPT
    backupGap: 2500, // extra spacing while reading chats for a backup
    gapDefault: 8, // seconds between changes; the user can change this
    gapMin: 3,
    gapMax: 120,
    cooldownLadder: [2 * MIN, 5 * MIN, 15 * MIN, 30 * MIN], // used when ChatGPT gives no Retry-After
    retryAfterMax: 60 * MIN,
    transientBackoff: [5 * SEC, 15 * SEC, 45 * SEC],
    calmAfter: 10, // successful requests before the cooldown ladder resets
    typeToConfirm: 20, // deleting this many or more asks you to type the number
    previewDelay: 650, // keyboard browsing waits this long before loading a chat
    staleBeat: 20 * SEC, // a run with no heartbeat for this long is treated as interrupted
  };
  const scaled = (ms) => Math.round(ms * SCALE);
  // The demo fast-forwards time. Pace figures then show what you actually see, with the real figure beside it.
  const SPEEDUP = Math.round(1 / SCALE);
  const paceHere = (gap) => (SCALE === 1 ? `${gap}s` : `${+(gap * SCALE).toFixed(1)}s`);
  const paceNote = (gap) => (SCALE === 1 ? "" : ` in this demo (${gap}s on chatgpt.com)`);
  const timeLeft = (secs) => (secs < 60 ? "Under a minute" : `About ${plural(Math.round(secs / 60), "minute")}`);

  const ACTION = {
    delete: { label: "Delete", verb: "Deleting", past: "Deleted", key: "D", icon: "trash" },
    archive: { label: "Archive", verb: "Archiving", past: "Archived", key: "A", icon: "archive" },
    unarchive: { label: "Unarchive", verb: "Unarchiving", past: "Unarchived", key: "U", icon: "restore" },
    rename: { label: "Rename", verb: "Renaming", past: "Renamed", key: "R", icon: "pencil" },
    protect: { label: "Protect", verb: "", past: "", key: "P", icon: "shield" },
  };

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  class TriageError extends Error {
    constructor(kind, message, extra = {}) {
      super(message);
      this.kind = kind;
      Object.assign(this, extra);
    }
  }

  const now = () => Date.now();
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const isUntitled = (c) => !c.title || /^new chat$/i.test(c.title);
  const quote = (s) => `“${s || "Untitled"}”`;

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(new TriageError("aborted", "Stopped."));
        return;
      }
      const timer = setTimeout(done, Math.max(0, ms));
      function done() {
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve();
      }
      function onAbort() {
        clearTimeout(timer);
        reject(new TriageError("aborted", "Stopped."));
      }
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  function toMs(value) {
    if (value == null || value === "") return 0;
    if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
    const t = Date.parse(value);
    return Number.isNaN(t) ? 0 : t;
  }

  const fmtClock = (t) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  function fmtDuration(ms) {
    const s = Math.max(0, Math.ceil(ms / SEC));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rest = s % 60;
    if (m < 60) return rest ? `${m}m ${rest}s` : `${m}m`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  }

  function parseRetryAfter(value) {
    if (!value) return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * SEC);
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : Math.max(0, t - now());
  }

  function download(filename, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30 * SEC);
  }

  const fileStamp = () => {
    const d = new Date();
    const two = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}-${two(d.getMinutes())}`;
  };

  function csv(rows) {
    const cell = (v) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return rows.map((r) => r.map(cell).join(",")).join("\n");
  }

  // Builds DOM without innerHTML, so chat content can never be interpreted as markup.
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === "class") el.className = v;
        else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
        else if (k in el && typeof v !== "string") el[k] = v;
        else el.setAttribute(k, v === true ? "" : String(v));
      }
    }
    for (const child of children.flat(Infinity)) {
      if (child == null || child === false) continue;
      el.append(child instanceof Node ? child : String(child));
    }
    return el;
  }

  const ICONS = {
    logo: "M4 5h16l-6 7.5V18l-4 2v-7.5z",
    trash: "M4 7h16M10 11v6M14 11v6M9 7V4h6v3M6 7l1 13h10l1-13",
    archive: "M3 4h18v4H3zM5 8v12h14V8M10 12h4",
    restore: "M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3",
    pencil: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
    shield: "M12 3 4 6v6c0 5 3.4 8 8 9 4.6-1 8-4 8-9V6z",
    pin: "M9 4h6l-1 5 3 3v2H7v-2l3-3zM12 14v6",
    x: "M6 6l12 12M18 6 6 18",
    refresh: "M20 11a8 8 0 1 0-2 5.3M20 4v7h-7",
    sliders: "M4 7h9M17 7h3M15 5v4M4 17h3M11 17h9M9 15v4",
    help: "M3 12a9 9 0 1 0 18 0 9 9 0 1 0-18 0M9.6 9.3a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.4M12 17h.01",
    external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
    download: "M12 4v11M7 10l5 5 5-5M5 20h14",
    check: "M5 12.5 10 17l9-10",
    eraser: "M8 20h12M5 15l8-8 5 5-6 6H8z",
    sun: "M12 3v1.5M12 19.5V21M4.6 4.6l1.1 1.1M18.3 18.3l1.1 1.1M3 12h1.5M19.5 12H21M4.6 19.4l1.1-1.1M18.3 5.7l1.1-1.1M8 12a4 4 0 1 0 8 0 4 4 0 1 0-8 0",
    moon: "M20 14.2A8 8 0 0 1 9.8 4 8 8 0 1 0 20 14.2z",
    play: "M7 4.5v15a1 1 0 0 0 1.5.9l12-7.5a1 1 0 0 0 0-1.8l-12-7.5A1 1 0 0 0 7 4.5z",
    search: "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM20 20l-4.5-4.5",
    filter: "M4 6h16M7 12h10M10 18h4",
    chevron: "M6 9l6 6 6-6",
  };

  function icon(name, size = 16) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.5");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", ICONS[name] || "");
    if (name === "play") {
      path.setAttribute("fill", "currentColor");
      path.setAttribute("stroke", "none");
    }
    svg.append(path);
    return svg;
  }

  // ---------------------------------------------------------------------------
  // Saved state (per ChatGPT account, in this browser only)
  // ---------------------------------------------------------------------------

  const DEFAULT_STATE = () => ({
    marks: {}, // id -> { a: action, title, t?: new title, at }
    protect: {}, // id -> { title, at }
    seen: {}, // id -> 1
    settings: { gap: CFG.gapDefault, backup: true, pinnedInSelectAll: false },
    run: null,
    cooldownUntil: 0,
    strikes: 0,
  });

  const Store = {
    key: null,
    data: DEFAULT_STATE(),
    timer: null,
    open(accountId) {
      this.key = `${APP}:v1:${accountId || "default"}`;
      let saved = null;
      try {
        saved = JSON.parse(localStorage.getItem(this.key) || "null");
      } catch {
        saved = null;
      }
      const d = DEFAULT_STATE();
      if (saved && typeof saved === "object") {
        for (const k of ["marks", "protect", "seen"]) if (saved[k] && typeof saved[k] === "object") d[k] = saved[k];
        if (saved.settings && typeof saved.settings === "object") Object.assign(d.settings, saved.settings);
        d.run = saved.run && Array.isArray(saved.run.jobs) ? saved.run : null;
        d.cooldownUntil = Number(saved.cooldownUntil) || 0;
        d.strikes = Number(saved.strikes) || 0;
      }
      d.settings.gap = clamp(Number(d.settings.gap) || CFG.gapDefault, CFG.gapMin, CFG.gapMax);
      this.data = d;
    },
    save() {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), 250);
    },
    flush() {
      clearTimeout(this.timer);
      if (!this.key) return;
      try {
        localStorage.setItem(this.key, JSON.stringify(this.data));
      } catch {
        ui.toast("Couldn't save your marks. Browser storage may be full.");
      }
    },
  };
  window.addEventListener("pagehide", () => Store.flush());

  // ---------------------------------------------------------------------------
  // Talking to ChatGPT
  // ---------------------------------------------------------------------------

  const Api = {
    token: null,
    accountId: null,
    lastAt: 0,
    calm: 0,
    log: [],

    async session() {
      let resp;
      try {
        resp = await fetch("/api/auth/session", { credentials: "include" });
      } catch {
        throw new TriageError("offline", "Couldn't reach ChatGPT. Check your connection, then reload the page.");
      }
      this.record("GET", "/api/auth/session", resp.status, 0);
      if (!resp.ok) throw new TriageError("auth", `ChatGPT didn't return a session (HTTP ${resp.status}). Make sure you're signed in at chatgpt.com.`);
      const data = await resp.json().catch(() => null);
      if (!data || !data.accessToken) throw new TriageError("auth", "You don't seem to be signed in. Sign in at chatgpt.com, then open Triage again.");
      this.token = data.accessToken;
      this.accountId = (data.user && data.user.id) || null;
      return data;
    },

    record(method, path, status, ms) {
      this.log.push({ at: now(), method, path, status, ms });
      if (this.log.length > 400) this.log.shift();
      ui.onNetwork();
    },

    cooldownLeft() {
      return Math.max(0, Store.data.cooldownUntil - now());
    },

    async request(method, path, { body, retryAuth = true } = {}) {
      const cooling = () => {
        if (this.cooldownLeft() > 0) {
          throw new TriageError("cooldown", "ChatGPT asked Triage to slow down.", { until: Store.data.cooldownUntil });
        }
      };
      cooling();
      // Reserve the next free slot synchronously, so parallel callers never fire together.
      const slot = Math.max(now(), this.lastAt + scaled(CFG.requestGap));
      this.lastAt = slot;
      if (slot > now()) await sleep(slot - now());
      cooling();

      const headers = { Authorization: `Bearer ${this.token}` };
      if (body) headers["Content-Type"] = "application/json";
      const started = now();
      let resp;
      try {
        resp = await fetch(path, { method, headers, credentials: "include", body: body ? JSON.stringify(body) : undefined });
      } catch {
        this.record(method, path, "network error", now() - started);
        throw new TriageError("transient", "Network error.");
      }
      this.record(method, path, resp.status, now() - started);

      if (resp.status === 429) {
        const until = this.hitLimit(parseRetryAfter(resp.headers.get("retry-after")));
        throw new TriageError("ratelimit", "ChatGPT said: too many requests.", { until });
      }
      if ((resp.status === 401 || resp.status === 403) && retryAuth) {
        await this.session();
        return this.request(method, path, { body, retryAuth: false });
      }
      if (resp.status === 401 || resp.status === 403) {
        throw new TriageError("auth", `ChatGPT refused the request (HTTP ${resp.status}). Reload the page and check you're signed in.`);
      }
      if (resp.status === 404) throw new TriageError("notfound", "Chat not found.");
      if (resp.status >= 500) throw new TriageError("transient", `ChatGPT had a server error (HTTP ${resp.status}).`);

      const text = await resp.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      if (!resp.ok) {
        const detail = data && data.detail ? `: ${String(typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail)).slice(0, 140)}` : "";
        throw new TriageError("http", `HTTP ${resp.status}${detail}`);
      }
      if (data && data.success === false) throw new TriageError("http", "ChatGPT said the change didn't go through.");

      this.calm += 1;
      if (this.calm >= CFG.calmAfter && Store.data.strikes) {
        Store.data.strikes = 0;
        Store.save();
      }
      return data;
    },

    // ChatGPT said "too many requests". Stop everything until it's safe.
    hitLimit(hintedMs) {
      const d = Store.data;
      const ladder = CFG.cooldownLadder;
      // ChatGPT's own number is always honoured in full; only Triage's fallback ladder is scaled in tests.
      const wait = hintedMs != null ? clamp(hintedMs + SEC, SEC, CFG.retryAfterMax) : scaled(ladder[Math.min(d.strikes, ladder.length - 1)]);
      d.strikes += 1;
      this.calm = 0;
      d.cooldownUntil = Math.max(d.cooldownUntil, now() + wait);
      Store.flush();
      note(hintedMs != null
        ? `ChatGPT asked Triage to wait ${fmtDuration(wait)}.`
        : `ChatGPT said "too many requests" without saying how long to wait. Waiting ${fmtDuration(wait)}.`);
      ui.onCooldown();
      return d.cooldownUntil;
    },
  };

  async function waitForCooldown(signal) {
    while (Api.cooldownLeft() > 0) await sleep(Math.min(SEC, Api.cooldownLeft()), signal);
  }

  // ---------------------------------------------------------------------------
  // Chats
  // ---------------------------------------------------------------------------

  const Data = {
    active: [],
    archived: [],
    byId: new Map(),
    archivedLoaded: false,
    loading: null, // { scope, n, total, waiting }
    compatOk: true,
    index() {
      this.byId = new Map();
      for (const c of this.active) this.byId.set(c.id, c);
      for (const c of this.archived) this.byId.set(c.id, c);
    },
  };

  const cache = new Map(); // id -> { title, messages, search }

  function normalize(item, archived) {
    const tpl = String(item.conversation_template_id || "");
    const gizmo = String(item.gizmo_id || "");
    const projectId = tpl.startsWith("g-p-") ? tpl : gizmo.startsWith("g-p-") ? gizmo : null;
    const gptId = projectId ? null : gizmo.startsWith("g-") ? gizmo : tpl.startsWith("g-") ? tpl : null;
    return {
      id: item.id,
      title: typeof item.title === "string" ? item.title.trim() : "",
      created: toMs(item.create_time),
      updated: toMs(item.update_time),
      projectId,
      gptId,
      pinned: Boolean(item.pinned_time || item.is_starred),
      archived: archived || item.is_archived === true,
    };
  }

  // Refuse to work with a list that doesn't look like ChatGPT's.
  function checkList(data) {
    if (!data || !Array.isArray(data.items) || !data.items.every((it) => it && typeof it.id === "string")) {
      throw new TriageError("compat", "ChatGPT's chat list looks different from what Triage expects, so Triage stopped. Check for an update.");
    }
    if (data.items.length && data.items.filter((it) => !("title" in it) || !("create_time" in it)).length > data.items.length / 2) {
      Data.compatOk = false;
    }
  }

  // Loads every chat, page by page. Waits out "too many requests" and carries on.
  async function loadList(scope, onProgress) {
    const found = new Map();
    let offset = 0;
    let total = null;
    let tries = 0;
    for (let page = 0; page < CFG.maxPages; page += 1) {
      const query = `offset=${offset}&limit=${CFG.pageSize}&order=updated${scope === "archived" ? "&is_archived=true" : ""}`;
      let data;
      try {
        data = await Api.request("GET", `/backend-api/conversations?${query}`);
      } catch (e) {
        if (e.kind === "ratelimit" || e.kind === "cooldown") {
          if (onProgress) onProgress(found.size, total, true);
          await waitForCooldown();
          page -= 1;
          continue;
        }
        if (e.kind === "transient" && tries < CFG.transientBackoff.length) {
          await sleep(scaled(CFG.transientBackoff[tries]));
          tries += 1;
          page -= 1;
          continue;
        }
        throw e;
      }
      tries = 0;
      checkList(data);
      const before = found.size;
      for (const item of data.items) {
        const c = normalize(item, scope === "archived");
        found.set(c.id, c);
      }
      if (Number.isFinite(data.total)) total = data.total;
      if (onProgress) onProgress(found.size, total, false);
      // Stop on an empty page. Don't trust `total` or the page size: either can be off.
      if (!data.items.length || found.size === before) break;
      offset += data.items.length;
    }
    return [...found.values()];
  }

  function textOf(content) {
    if (!content || !["text", "multimodal_text"].includes(content.content_type)) return "";
    const parts = Array.isArray(content.parts) ? content.parts : [];
    return parts
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object") {
          if (typeof p.text === "string") return p.text;
          if (typeof p.transcript === "string") return p.transcript;
          if (/image/.test(String(p.content_type || ""))) return "[image]";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  // Follows the branch you actually see in ChatGPT, not edited-away alternatives.
  function parseConversation(data) {
    const map = (data && data.mapping) || {};
    const chain = [];
    const guard = new Set();
    let node = data && data.current_node ? map[data.current_node] : null;
    while (node && !guard.has(node.id)) {
      guard.add(node.id);
      chain.push(node);
      node = node.parent ? map[node.parent] : null;
    }
    chain.reverse();
    if (!chain.length) {
      chain.push(...Object.values(map).sort((a, b) => ((a.message && a.message.create_time) || 0) - ((b.message && b.message.create_time) || 0)));
    }
    const messages = chain
      .map((n) => n && n.message)
      .filter((m) => m && m.author && (m.author.role === "user" || m.author.role === "assistant"))
      .filter((m) => !(m.metadata && m.metadata.is_visually_hidden_from_conversation))
      .map((m) => ({ role: m.author.role, text: textOf(m.content), time: toMs(m.create_time) }))
      .filter((m) => m.text.trim());
    const search = messages.map((m) => m.text).join("\n").toLowerCase().slice(0, 200000);
    return { title: (data && data.title) || "", messages, search };
  }

  async function getConversation(id) {
    if (cache.has(id)) return cache.get(id);
    const data = await Api.request("GET", `/backend-api/conversation/${encodeURIComponent(id)}`);
    const conv = parseConversation(data);
    cache.set(id, conv);
    if (cache.size > 400) cache.delete(cache.keys().next().value);
    return conv;
  }

  function toMarkdown(chats) {
    const out = [`# ChatGPT backup`, ``, `Saved by Triage on ${new Date().toLocaleString()}. ${plural(chats.length, "chat")}.`, ``];
    for (const c of chats) {
      out.push(`---`, ``, `## ${c.title || "Untitled"}`, ``);
      out.push(`Created ${c.created ? new Date(c.created).toLocaleString() : "unknown"} · https://chatgpt.com/c/${c.id}`, ``);
      if (c.error) {
        out.push(`_Couldn't back up this chat: ${c.error}_`, ``);
        continue;
      }
      for (const m of c.messages) out.push(`**${m.role === "user" ? "You" : "ChatGPT"}**`, ``, m.text, ``);
    }
    return out.join("\n");
  }

  // ---------------------------------------------------------------------------
  // Marks
  // ---------------------------------------------------------------------------

  function whyNot(c, action) {
    if (!Data.compatOk) return "Changes are switched off because ChatGPT's data looks unfamiliar.";
    if (Store.data.protect[c.id]) return "That chat is protected. Press P to unprotect it first.";
    if (action === "archive" && c.archived) return "That chat is already archived.";
    if (action === "unarchive" && !c.archived) return "Only archived chats can be unarchived.";
    return null;
  }

  function queueCounts() {
    const q = { delete: 0, archive: 0, unarchive: 0, rename: 0, total: 0 };
    for (const [id, m] of Object.entries(Store.data.marks)) {
      if (Store.data.protect[id] || !(m.a in q)) continue;
      q[m.a] += 1;
      q.total += 1;
    }
    return q;
  }

  // ---------------------------------------------------------------------------
  // The queue runner
  // ---------------------------------------------------------------------------

  const ACTIVE = ["backup", "running", "waiting", "verifying"];

  const Runner = {
    looping: false,
    wake: null,
    backup: [],
    lastBeat: 0,
    tabId: (() => {
      try {
        let id = sessionStorage.getItem(`${APP}:tab`);
        if (!id) {
          id = Math.random().toString(36).slice(2);
          sessionStorage.setItem(`${APP}:tab`, id);
        }
        return id;
      } catch {
        return Math.random().toString(36).slice(2);
      }
    })(),

    get run() {
      return Store.data.run;
    },

    isActive() {
      const r = this.run;
      return Boolean(r && ACTIVE.includes(r.status));
    },

    buildJobs() {
      const order = new Map();
      [...Data.active, ...Data.archived].sort((a, b) => a.created - b.created).forEach((c, i) => order.set(c.id, i));
      return Object.entries(Store.data.marks)
        .filter(([id, m]) => !Store.data.protect[id] && ACTION[m.a] && m.a !== "protect")
        .map(([id, m]) => {
          const c = Data.byId.get(id);
          return { id, action: m.a, newTitle: m.t || null, title: c ? c.title : m.title || "" };
        })
        .sort((a, b) => (order.has(a.id) ? order.get(a.id) : 1e9) - (order.has(b.id) ? order.get(b.id) : 1e9));
    },

    start({ backup }) {
      const jobs = this.buildJobs();
      if (!jobs.length) return;
      const wantBackup = backup && jobs.some((j) => j.action === "delete");
      Store.data.run = {
        id: now().toString(36),
        status: wantBackup ? "backup" : "running",
        phase: wantBackup ? "backup" : "write",
        jobs,
        i: 0,
        results: [],
        startedAt: now(),
        owner: this.tabId,
        beat: now(),
        lastWriteAt: 0,
        nextAt: 0,
        fails: 0,
        note: "",
        current: null,
      };
      this.backup = [];
      Store.flush();
      note(`Started: ${plural(jobs.length, "change")}.`);
      this.loop();
    },

    resume() {
      const r = this.run;
      if (!r || r.status !== "paused") return;
      if (this.looping) {
        // The previous loop is still finishing its last request. Resume as soon as it's out.
        this.resumeAfter = true;
        return;
      }
      r.owner = this.tabId;
      r.status = r.phase === "backup" ? "backup" : "running";
      r.note = "";
      r.fails = 0;
      Store.flush();
      note("Resumed.");
      this.loop();
    },

    pause(reason) {
      const r = this.run;
      if (!r || !ACTIVE.includes(r.status)) return;
      r.status = "paused";
      r.note = reason || "";
      r.nextAt = 0;
      Store.flush();
      if (this.wake) this.wake.abort();
      note(reason ? `Paused: ${reason}` : "Paused.");
      ui.renderRun(true);
    },

    stop() {
      const r = this.run;
      if (!r) return;
      this.resumeAfter = false;
      r.status = "stopped";
      r.note = "";
      r.nextAt = 0;
      r.finishedAt = now();
      Store.flush();
      if (this.wake) this.wake.abort();
      note("Stopped. Chats that weren't reached keep their marks.");
      ui.renderAll();
    },

    dismiss() {
      Store.data.run = null;
      Store.flush();
      ui.renderAll();
    },

    record(job, status, detail = "") {
      this.run.results.push({ id: job.id, action: job.action, title: job.title, newTitle: job.newTitle, status, note: detail, at: now() });
    },

    async loop() {
      if (this.looping) return;
      this.looping = true;
      const wake = (this.wake = new AbortController());
      const r = this.run;
      const set = (status) => {
        if (!wake.signal.aborted) r.status = status;
      };
      try {
        if (r.phase === "backup") {
          await this.doBackup(r, wake.signal);
          r.phase = "write";
          set("running");
          Store.flush();
        }
        while (r.i < r.jobs.length) {
          if (wake.signal.aborted) return;
          const job = r.jobs[r.i];
          r.current = job.id;
          if (Api.cooldownLeft() > 0) {
            set("waiting");
            r.nextAt = 0;
            ui.renderRun(true);
            await waitForCooldown(wake.signal);
          }
          const gap = r.lastWriteAt + scaled(Store.data.settings.gap * SEC) - now();
          if (gap > 0) {
            set("running");
            r.nextAt = now() + gap;
            ui.renderRun(true);
            await sleep(gap, wake.signal);
          }
          set("running");
          r.nextAt = 0;
          r.current = job.id;
          ui.renderRun(true);
          try {
            await writeChange(job);
            r.lastWriteAt = now();
            applyLocally(job);
            this.record(job, "done");
            r.i += 1;
            r.fails = 0;
            job.tries = 0;
          } catch (e) {
            r.lastWriteAt = now();
            if (e.kind === "ratelimit" || e.kind === "cooldown") continue; // same chat again, after the wait
            if (e.kind === "notfound") {
              if (job.action === "delete" || job.action === "archive") {
                applyLocally(job);
                this.record(job, "done", "It was already gone.");
              } else {
                this.record(job, "failed", "Chat not found.");
              }
              r.i += 1;
              continue;
            }
            if (e.kind === "auth") {
              this.pause(e.message);
              return;
            }
            job.tries = (job.tries || 0) + 1;
            if (e.kind === "transient" && job.tries <= CFG.transientBackoff.length) {
              r.note = `${e.message} Trying again shortly.`;
              ui.renderRun(true);
              await sleep(scaled(CFG.transientBackoff[job.tries - 1]), wake.signal);
              r.note = "";
              continue;
            }
            this.record(job, "failed", e.message);
            r.i += 1;
            r.fails += 1;
            if (r.fails >= 3) {
              this.pause("Three changes in a row failed. Check that ChatGPT is working, then resume.");
              return;
            }
          } finally {
            Store.save();
            ui.renderAll();
          }
        }
        if (wake.signal.aborted) return;
        set("verifying");
        r.current = null;
        ui.renderRun(true);
        await this.verify(r);
        r.status = "done";
        r.finishedAt = now();
        Store.flush();
        const failed = r.results.filter((x) => x.status !== "done").length;
        note(`Finished. ${plural(r.results.length - failed, "change")} made${failed ? `, ${failed} need attention` : ""}.`);
      } catch (e) {
        if (e.kind !== "aborted") this.pause(e.message || String(e));
      } finally {
        this.looping = false;
        if (this.wake === wake) this.wake = null;
        Store.flush();
        ui.renderAll();
        if (this.resumeAfter) {
          this.resumeAfter = false;
          setTimeout(() => this.resume(), 0);
        }
      }
    },

    // Saves a readable copy of every chat about to be deleted, before anything is deleted.
    async doBackup(r, signal) {
      const targets = r.jobs.filter((j) => j.action === "delete");
      const out = [];
      let tries = 0;
      for (let k = 0; k < targets.length; k += 1) {
        if (signal.aborted) throw new TriageError("aborted", "Stopped.");
        const job = targets[k];
        r.status = "backup";
        r.current = job.id;
        r.note = `Backing up chat ${k + 1} of ${targets.length} before deleting anything.`;
        ui.renderRun(true);
        try {
          const cached = cache.has(job.id);
          const conv = await getConversation(job.id);
          const c = Data.byId.get(job.id);
          out.push({ id: job.id, title: job.title, created: c ? c.created : 0, messages: conv.messages });
          tries = 0;
          if (!cached && k < targets.length - 1) await sleep(scaled(CFG.backupGap), signal);
        } catch (e) {
          if (e.kind === "aborted") throw e;
          if (e.kind === "ratelimit" || e.kind === "cooldown") {
            r.status = "waiting";
            ui.renderRun(true);
            await waitForCooldown(signal);
            k -= 1;
            continue;
          }
          if (e.kind === "transient" && tries < CFG.transientBackoff.length) {
            await sleep(scaled(CFG.transientBackoff[tries]), signal);
            tries += 1;
            k -= 1;
            continue;
          }
          if (e.kind === "auth") throw e;
          if (e.kind !== "notfound") out.push({ id: job.id, title: job.title, created: 0, error: e.message });
        }
      }
      this.backup = out;
      r.note = "";
      r.backupCount = out.length;
      if (out.length) {
        download(`chatgpt-triage-backup-${fileStamp()}.md`, toMarkdown(out), "text/markdown");
        note(`Backed up ${plural(out.length, "chat")} to your Downloads folder.`);
      }
    },

    // Reloads the list once at the end and checks that deleted and archived chats are really gone.
    async verify(r) {
      const gone = r.results.filter((x) => x.status === "done" && (x.action === "delete" || x.action === "archive"));
      if (!gone.length) return;
      r.note = "Double-checking with ChatGPT.";
      ui.renderRun(true);
      let fresh;
      try {
        fresh = await loadList("active", (n, total, waiting) => {
          r.note = waiting ? "Waiting for ChatGPT before double-checking." : `Double-checking: ${n}${total ? ` of ${total}` : ""} chats.`;
          ui.renderRun(true);
        });
      } catch (e) {
        r.note = `Couldn't double-check: ${e.message}`;
        return;
      }
      // ChatGPT's list can lag behind a change: an archived chat may stay listed for a while even
      // though the chat itself is archived. So a chat that's still listed is checked on its own
      // before it's called a failure.
      const present = new Set(fresh.map((c) => c.id));
      const suspects = gone.filter((res) => present.has(res.id));
      const stuck = new Set();
      for (let k = 0; k < suspects.length; k += 1) {
        const res = suspects[k];
        r.note = `Double-checking ${suspects.length === 1 ? "one chat" : `chat ${k + 1} of ${suspects.length}`} directly.`;
        ui.renderRun(true);
        if (await changeStuck(res)) {
          stuck.add(res.id);
          continue;
        }
        res.status = "unconfirmed";
        res.note = "ChatGPT still shows this chat unchanged. It's marked again so you can retry.";
        Store.data.marks[res.id] = { a: res.action, title: res.title, at: now() };
      }
      Data.active = fresh.filter((c) => !stuck.has(c.id));
      Data.index();
      r.note = "";
    },
  };

  // Asks ChatGPT about one chat: did the delete or archive really happen?
  async function changeStuck(res) {
    try {
      const data = await Api.request("GET", `/backend-api/conversation/${encodeURIComponent(res.id)}`);
      if (res.action === "archive") return Boolean(data && data.is_archived === true);
      return Boolean(data && data.is_visible === false);
    } catch (e) {
      // A deleted chat can't be loaded any more. Anything else: can't tell, so it's flagged for a look.
      return e.kind === "notfound" && res.action === "delete";
    }
  }

  function writeChange(job) {
    const body = {
      delete: { is_visible: false },
      archive: { is_archived: true },
      unarchive: { is_archived: false },
      rename: { title: job.newTitle },
    }[job.action];
    if (!body) return Promise.reject(new TriageError("http", `Unknown action ${job.action}.`));
    return Api.request("PATCH", `/backend-api/conversation/${encodeURIComponent(job.id)}`, { body });
  }

  function applyLocally(job) {
    delete Store.data.marks[job.id];
    const c = Data.byId.get(job.id);
    if (!c) return;
    if (job.action === "delete") {
      Data.active = Data.active.filter((x) => x.id !== c.id);
      Data.archived = Data.archived.filter((x) => x.id !== c.id);
    } else if (job.action === "archive") {
      Data.active = Data.active.filter((x) => x.id !== c.id);
      c.archived = true;
      if (Data.archivedLoaded) Data.archived.push(c);
    } else if (job.action === "unarchive") {
      Data.archived = Data.archived.filter((x) => x.id !== c.id);
      c.archived = false;
      Data.active.push(c);
    } else if (job.action === "rename") {
      c.title = job.newTitle;
      const conv = cache.get(c.id);
      if (conv) conv.title = job.newTitle;
    }
    Data.index();
    if (ui.readerId === c.id && (job.action === "delete" || job.action === "archive" || job.action === "unarchive")) ui.readerId = null;
  }

  // ---------------------------------------------------------------------------
  // Activity notes
  // ---------------------------------------------------------------------------

  const activity = [];
  function note(message) {
    activity.push({ at: now(), message });
    if (activity.length > 300) activity.shift();
    ui.onActivity();
  }

  // ---------------------------------------------------------------------------
  // Interface
  //
  // Design rules, so the whole thing reads as one piece:
  //   - Both columns share the same horizontal bands, so lines run straight across.
  //   - Each column has one left edge. In the reader, the buttons, details, title
  //     and conversation all sit in the same centred column.
  //   - One control height (32px), one corner radius (8px), four text sizes.
  //   - Words are sans-serif; dates and numbers are monospace.
  //   - Black and white. Red means "this deletes"; green and amber are status lights.
  // ---------------------------------------------------------------------------

  const CSS = `
    :host { all: initial; }
    .root {
      --sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif;
      --mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, "Liberation Mono", monospace;
      --ease: cubic-bezier(.22, 1, .36, 1);
      --ease-in: cubic-bezier(.55, 0, .75, .2);
      --top: 56px; --band1: 52px; --band2: 40px; --gutter: 20px;
      --bg: #ffffff; --raised: #ffffff; --fill: #f2f2f4; --fill2: #e8e8eb; --line: #ebebee;
      --fg: #111113; --fg2: #505055; --fg3: #6e6e73;
      --red: #d70015; --red-on-sel: #c50013; --pill: #d70015; --green: #1f9d4c; --amber: #b86e00;
      --focus: #111113; --on-focus: #ffffff; --focus-ring: none;
      --veil: rgba(255, 255, 255, .72);
      --tick: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.6 6.3 5 8.6 9.4 3.9' fill='none' stroke='%23fff' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
      --tick-inv: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.6 6.3 5 8.6 9.4 3.9' fill='none' stroke='%23111113' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
      --shadow: 0 1px 2px rgba(0, 0, 0, .04), 0 28px 70px -18px rgba(0, 0, 0, .28);
      color-scheme: light;
      font: 13px/1.45 var(--sans);
      color: var(--fg);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    .root.dark {
      --bg: #000000; --raised: #0c0c0d; --fill: #151517; --fill2: #202023; --line: #2c2c30;
      --fg: #f5f5f7; --fg2: #a1a1a6; --fg3: #8a8a8f;
      --red: #ff453a; --red-on-sel: #ff453a; --pill: #d70015; --green: #30d158; --amber: #ffb340;
      /* A dark grey cursor with a hairline edge: a white bar on black outweighed everything else. */
      --focus: #2a2a2d; --on-focus: #f5f5f7; --focus-ring: inset 0 0 0 1px #55555a;
      --veil: rgba(0, 0, 0, .68);
      --tick: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.6 6.3 5 8.6 9.4 3.9' fill='none' stroke='%23000' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
      --tick-inv: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.6 6.3 5 8.6 9.4 3.9' fill='none' stroke='%232a2a2d' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
      --shadow: 0 0 0 1px rgba(255, 255, 255, .04), 0 40px 90px -24px rgba(0, 0, 0, .95);
      color-scheme: dark;
    }
    .root.no-anim *, .root.no-anim *::before, .root.no-anim *::after { transition: none !important; }
    * { box-sizing: border-box; scrollbar-width: thin; scrollbar-color: var(--fill2) transparent; }
    [hidden] { display: none !important; }
    :where(button, input, select) { font: inherit; color: inherit; }
    a { color: inherit; text-decoration: none; }
    ::selection { background: var(--fg); color: var(--bg); }
    :focus { outline: none; }
    :focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
    svg { flex-shrink: 0; }

    @keyframes rise { from { opacity: 0; transform: translateY(10px) scale(.992); } }
    @keyframes sink { to { opacity: 0; transform: translateY(6px) scale(.996); } }
    @keyframes fade { from { opacity: 0; } }
    @keyframes fade-out { to { opacity: 0; } }
    @keyframes pop { from { opacity: 0; transform: translateY(-4px) scale(.98); } }
    @keyframes up { from { opacity: 0; transform: translateY(6px); } }
    @keyframes slide { from { opacity: 0; transform: translateX(-6px); } }
    @keyframes strike { from { transform: scaleX(0); } }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes bump { 40% { transform: scale(1.3); } }
    @keyframes turn { from { opacity: 0; transform: rotate(-90deg) scale(.6); } }
    @keyframes toast { from { opacity: 0; transform: translate(-50%, 10px) scale(.98); } }
    @keyframes toast-out { to { opacity: 0; transform: translate(-50%, 6px); } }

    /* Launcher on chatgpt.com */
    .launcher {
      position: fixed; right: 20px; bottom: 88px; display: inline-flex; align-items: center; gap: 9px;
      height: 34px; padding: 0 14px 0 12px; border-radius: 999px; border: 1px solid #2a2a2c;
      background: #0b0b0c; color: #f5f5f7; cursor: pointer; font: 600 12.5px/1 var(--sans);
      box-shadow: 0 10px 28px -10px rgba(0, 0, 0, .5);
      transition: transform .2s var(--ease), box-shadow .2s var(--ease); animation: rise .45s var(--ease) both;
    }
    .launcher:hover { transform: translateY(-1px); box-shadow: 0 14px 32px -10px rgba(0, 0, 0, .6); }
    .launcher:active { transform: scale(.97); }
    .launcher .info { font: 12px/1 var(--mono); color: #9a9a9f; font-variant-numeric: tabular-nums; }
    .launcher .dot { width: 6px; height: 6px; border-radius: 50%; background: #6c6c70; transition: background-color .3s; }
    .launcher .dot.go, .launcher .dot.ok { background: #30d158; }
    .launcher .dot.wait { background: #ffb340; }
    .launcher .dot.live { animation: pulse 1.6s var(--ease) infinite; }

    /* Frame */
    .panel { position: fixed; inset: 0; display: flex; flex-direction: column; background: var(--bg); color: var(--fg); outline: none; animation: rise .3s var(--ease) both; }
    .panel.leaving { animation: sink .16s var(--ease-in) both; pointer-events: none; }
    .top { height: var(--top); flex-shrink: 0; display: flex; align-items: center; gap: 28px; padding: 0 var(--gutter); border-bottom: 1px solid var(--line); }
    .brand { font: 600 15px/1 var(--sans); letter-spacing: -.01em; user-select: none; }
    .tabs { position: relative; align-self: stretch; display: flex; }
    .tabbtns { display: flex; gap: 22px; }
    .tab { border: 0; background: none; padding: 0; cursor: pointer; display: flex; align-items: center; gap: 6px; color: var(--fg3); transition: color .2s; }
    .tab:hover { color: var(--fg2); }
    .tab.on { color: var(--fg); }
    /* Words and numbers use different fonts, so centring their boxes puts the digits ~1px high. Align on the baseline instead. */
    .tl { display: inline-flex; align-items: baseline; gap: 6px; }
    .btn .tl { gap: 8px; }
    .tab .n { font: 12px/1 var(--mono); color: var(--fg3); font-variant-numeric: tabular-nums; }
    .tabind { position: absolute; left: 0; bottom: -1px; height: 2px; width: 0; border-radius: 2px; background: var(--fg); opacity: 0; pointer-events: none; transition: transform .35s var(--ease), width .35s var(--ease), opacity .2s; }
    .instant { transition: none !important; }
    .spacer { flex: 1; }
    .queue { display: flex; gap: 14px; color: var(--fg3); white-space: nowrap; }
    .queue b { margin-left: 4px; font: 600 12px/1 var(--mono); color: var(--fg); font-variant-numeric: tabular-nums; }
    .queue .q-delete b { color: var(--red); }
    .actions { display: flex; align-items: center; gap: 4px; }

    /* Controls: one height, one radius */
    .btn {
      height: 32px; display: inline-flex; align-items: center; gap: 8px; padding: 0 10px; border: 0; border-radius: 8px;
      background: transparent; cursor: pointer; color: var(--fg); white-space: nowrap;
      transition: background-color .15s, color .15s, opacity .15s;
    }
    .btn:hover:not(:disabled) { background: var(--fill); }
    .btn:active:not(:disabled) { transform: scale(.98); }
    .btn:disabled { opacity: .35; cursor: default; }
    .btn.icon { width: 32px; padding: 0; justify-content: center; color: var(--fg2); }
    .btn.icon:hover:not(:disabled) { color: var(--fg); }
    .btn.quiet { color: var(--fg2); }
    .btn.quiet:hover:not(:disabled) { color: var(--fg); }
    .btn.danger { color: var(--red); }
    .btn.on { background: var(--fill2); }
    .btn.primary { padding: 0 14px; background: var(--fg); color: var(--bg); font-weight: 600; }
    .btn.primary:hover:not(:disabled) { background: var(--fg); opacity: .86; }
    .btn.icon.theme svg { animation: turn .5s var(--ease) both; }
    .key { font: 12px/1 var(--mono); color: var(--fg3); }
    .fcount { min-width: 18px; height: 18px; padding: 0 5px; border-radius: 5px; background: var(--fg); color: var(--bg); font: 600 11px/18px var(--mono); text-align: center; }
    .run { height: 32px; display: inline-flex; align-items: baseline; padding: 0; margin: 0 8px 0 4px; border: 0; border-radius: 8px; background: var(--fg); color: var(--bg); cursor: pointer; font-weight: 600; transition: opacity .15s; }
    .run:hover:not(:disabled) { opacity: .88; }
    .run:disabled { opacity: .3; cursor: default; }
    .run .go { display: block; padding: 0 12px; line-height: 32px; white-space: nowrap; }
    .run .go svg { margin-right: 8px; vertical-align: -1px; transition: transform .3s var(--ease); }
    .run:hover:not(:disabled) .go svg { transform: translateX(2px); }
    .run .count { display: block; min-width: 38px; padding: 0 10px; text-align: center; border-left: 1px solid color-mix(in srgb, var(--bg) 22%, transparent); font: 600 12px/32px var(--mono); font-variant-numeric: tabular-nums; }
    .run .count.bump span { display: inline-block; animation: bump .4s var(--ease); }

    .banner { display: flex; align-items: center; gap: 12px; padding: 10px var(--gutter); border-bottom: 1px solid var(--line); background: var(--fill); color: var(--fg2); animation: up .3s var(--ease) both; }
    .banner b { color: var(--fg); font-weight: 600; }
    .banner.bad, .banner.bad b { color: var(--red); }
    .banner .clock { margin-left: auto; font: 600 12px/1 var(--mono); color: var(--fg); font-variant-numeric: tabular-nums; }

    /* Two columns that share the same bands */
    .main { flex: 1; display: flex; min-height: 0; position: relative; }
    .left { width: min(600px, 44vw); min-width: 420px; display: flex; flex-direction: column; border-right: 1px solid var(--line); min-height: 0; }
    .reader { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
    .band { flex-shrink: 0; display: flex; align-items: center; border-bottom: 1px solid var(--line); }
    .b1 { height: var(--band1); }
    .b2 { height: var(--band2); }
    .left .band { padding: 0 var(--gutter); gap: 8px; }
    .left .b2 { gap: 12px; }
    .left .b2 .grp { display: flex; align-items: center; gap: 2px; margin-left: auto; overflow: hidden; }
    .head-label { color: var(--fg2); white-space: nowrap; }
    .head-label b { color: var(--fg); font-weight: 600; }

    .search { flex: 1; min-width: 0; height: 32px; display: flex; align-items: center; gap: 8px; padding: 0 10px; border-radius: 8px; background: var(--fill); color: var(--fg3); cursor: text; transition: box-shadow .15s; }
    .search:focus-within { box-shadow: inset 0 0 0 1.5px var(--fg); }
    .search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; font: 13px/1 var(--sans); color: var(--fg); }
    .search input::placeholder { color: var(--fg3); }
    .pop { position: relative; }
    .menu {
      position: absolute; top: 38px; z-index: 6; min-width: 230px; padding: 6px; border-radius: 12px;
      background: var(--raised); border: 1px solid var(--line); box-shadow: var(--shadow); animation: pop .22s var(--ease) both;
    }
    .menu.right { right: 0; }
    .menu .mh { padding: 8px 10px 4px; font-size: 12px; color: var(--fg3); }
    .menu .opt { width: 100%; height: 32px; display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 0 10px; border: 0; border-radius: 8px; background: transparent; cursor: pointer; text-align: left; }
    .menu .opt:hover { background: var(--fill); }
    .menu .opt svg { visibility: hidden; }
    .menu .opt.on svg { visibility: visible; }
    .menu hr { margin: 6px 4px; border: 0; border-top: 1px solid var(--line); }

    .gut { position: relative; width: 16px; height: 16px; display: grid; place-items: center; flex-shrink: 0; align-self: center; }
    .row .gut::after { content: ""; position: absolute; inset: -10px -8px -10px -12px; } /* a 36px-tall target for a 14px checkbox */
    .cb {
      appearance: none; -webkit-appearance: none; margin: 0; width: 14px; height: 14px; flex-shrink: 0; cursor: pointer;
      border: 1.5px solid var(--fg3); border-radius: 4px; background: transparent;
      transition: background-color .15s, border-color .15s, box-shadow .15s;
    }
    .cb:hover { border-color: var(--fg2); }
    .cb:checked { background: var(--fg) var(--tick) center / 12px no-repeat; border-color: var(--fg); }
    .cb:indeterminate { background: var(--fg3); border-color: var(--fg3); box-shadow: inset 0 0 0 3.5px var(--bg); }
    .cb:disabled { opacity: .3; cursor: default; }

    .list { flex: 1; position: relative; overflow: auto; overscroll-behavior: contain; outline: none; padding: 6px 0 28px; }
    .cursor { position: absolute; top: 0; left: 8px; right: 8px; height: 36px; border-radius: 8px; background: var(--focus); box-shadow: var(--focus-ring); opacity: 0; pointer-events: none; transition: transform .22s var(--ease), height .22s var(--ease), opacity .18s; }
    .rows { position: relative; }
    .note.more { padding: 16px 24px; }
    .row {
      position: absolute; left: 8px; right: 8px; height: 36px; padding: 0 12px; display: grid; grid-template-columns: 16px 92px minmax(0, 1fr) auto;
      column-gap: 12px; align-items: baseline; align-content: center; border-radius: 8px; transition: background-color .15s, color .15s;
    }
    .row:hover { background: var(--fill); }
    .row.sel { background: var(--fill2); }
    .row.focus, .row.focus:hover { background: transparent; color: var(--on-focus); }
    .row .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--fg); }
    .row.focus .dot { background: var(--on-focus); }
    /* The dot and the checkbox share one cell and swap by visibility, so selecting doesn't re-lay-out every row. */
    .gut > * { grid-area: 1 / 1; }
    .row .cb { visibility: hidden; }
    .row:hover .cb, .row.sel .cb, .list.selecting .row .cb { visibility: visible; }
    .row:hover .dot, .row.sel .dot, .list.selecting .row .dot { visibility: hidden; }
    .row.focus .cb { border-color: var(--on-focus); }
    .row.focus .cb:checked { background-color: var(--on-focus); background-image: var(--tick-inv); }
    .row .date { font: 12px/1 var(--mono); color: var(--fg3); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .row.focus .date { color: color-mix(in srgb, var(--on-focus) 62%, transparent); }
    .row .title { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .row .t { position: relative; }
    .row.seen .t { color: var(--fg2); }
    .row.focus .t { color: var(--on-focus); }
    .row.m-delete .t { color: var(--fg3); }
    .row.m-delete .t::after { content: ""; position: absolute; left: 0; right: 0; top: 55%; height: 1px; background: currentColor; transform-origin: left center; }
    .row.m-delete.fresh .t::after { animation: strike .38s var(--ease) both; }
    .row.focus.m-delete .t { color: color-mix(in srgb, var(--on-focus) 55%, transparent); }
    .chip { display: inline-block; margin-right: 8px; padding: 0 6px; border-radius: 4px; background: var(--fill2); font-size: 12px; line-height: 18px; color: var(--fg2); vertical-align: 1px; }
    .row.focus .chip { background: color-mix(in srgb, var(--on-focus) 18%, transparent); color: var(--on-focus); }
    .end { position: relative; display: flex; align-items: baseline; justify-content: flex-end; }
    .end::before { content: "\\200b"; } /* an empty status slot still has a text line, so the hover buttons centre on it */
    .mark { max-width: 120px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 12px; color: var(--fg2); transition: opacity .15s; }
    .mark.delete { color: var(--red); }
    .mark svg { margin-right: 5px; vertical-align: -2px; }
    .mark.prot { color: var(--fg3); }
    .row .to { color: var(--fg); }
    .row.focus .to { color: var(--on-focus); }
    .mark.fresh { animation: slide .26s var(--ease) both; }
    .row.focus .mark { color: var(--on-focus); }
    .row.focus .mark.delete { padding: 2px 7px; border-radius: 5px; background: var(--pill); color: #fff; }
    .row.sel:not(.focus) .mark.delete { color: var(--red-on-sel); }
    .acts {
      position: absolute; right: -6px; top: 50%; transform: translateY(-50%); display: flex; gap: 2px; padding-left: 28px;
      opacity: 0; pointer-events: none; transition: opacity .15s; background: linear-gradient(to right, transparent, var(--fill) 24px);
    }
    .row:hover .acts { opacity: 1; pointer-events: auto; }
    .end:has(.mark) .acts { right: calc(100% + 6px); } /* hover buttons sit beside the mark, never over it */
    .row.sel .acts { background: linear-gradient(to right, transparent, var(--fill2) 24px); }
    .row.focus .acts { background: linear-gradient(to right, transparent, var(--focus) 24px); }
    .mini { width: 28px; height: 28px; border: 0; border-radius: 8px; background: transparent; color: var(--fg2); cursor: pointer; display: grid; place-items: center; transition: background-color .12s, color .12s; }
    .mini:hover { background: var(--fill2); color: var(--fg); }
    .mini.on { color: var(--fg); }
    .row.focus .mini { color: color-mix(in srgb, var(--on-focus) 70%, transparent); }
    .row.focus .mini:hover { background: color-mix(in srgb, var(--on-focus) 16%, transparent); color: var(--on-focus); }

    .note { padding: 48px 24px; text-align: center; color: var(--fg3); animation: fade .3s var(--ease) both; }
    .note .btn { margin-top: 14px; }
    .spin { display: inline-block; width: 12px; height: 12px; margin-right: 8px; vertical-align: -1px; border-radius: 50%; border: 1.5px solid var(--fill2); border-top-color: var(--fg); animation: spin .8s linear infinite; }

    /* Reader */
    .col { width: 100%; max-width: 744px; margin: 0 auto; padding: 0 32px; display: flex; align-items: center; gap: 4px; min-width: 0; }
    .reader .b1 .col > .btn:first-child { margin-left: -10px; }
    .reader.idle-state .band { border-bottom-color: transparent; }
    .meta { gap: 18px; color: var(--fg3); white-space: nowrap; overflow: hidden; }
    .meta .num { font: 12px/1 var(--mono); font-variant-numeric: tabular-nums; }
    .meta .state { margin-left: auto; font-weight: 600; color: var(--fg2); overflow: hidden; text-overflow: ellipsis; }
    .meta .state.delete { color: var(--red); }
    .meta .state .v { font-weight: 400; color: var(--fg); }
    .scroll { flex: 1; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable both-edges; }
    .scroll .col { display: block; padding-top: 36px; padding-bottom: 96px; }
    .scroll h1 { margin: 0 0 28px; font: 600 24px/1.25 var(--sans); letter-spacing: -.02em; overflow-wrap: anywhere; }
    .msg { margin-bottom: 28px; }
    .msg .who { margin-bottom: 8px; font-size: 12px; font-weight: 600; color: var(--fg3); }
    .msg .txt { font: 15px/1.65 var(--sans); white-space: pre-wrap; overflow-wrap: anywhere; }
    .msg.user .txt { padding: 12px 16px; border-radius: 12px; background: var(--fill); }
    .enter h1, .enter .msg { animation: up .4s var(--ease) both; }
    .idle { height: 100%; display: grid; place-items: center; padding: 32px; animation: fade .4s var(--ease) both; }
    .legend .h { margin-bottom: 22px; text-align: center; font-size: 15px; font-weight: 600; }
    .legend .grid { display: grid; grid-template-columns: auto auto auto auto; gap: 12px 10px; align-items: center; justify-content: center; }
    .legend .k { justify-self: end; font: 12px/1 var(--mono); color: var(--fg3); }
    .legend .l { margin-right: 28px; color: var(--fg2); }
    .legend .f { margin-top: 24px; text-align: center; color: var(--fg3); }

    /* Run */
    .runlayer {
      position: absolute; inset: 0; z-index: 3; display: grid; place-items: center; padding: 20px; background: var(--veil);
      -webkit-backdrop-filter: blur(10px) saturate(120%); backdrop-filter: blur(10px) saturate(120%); animation: fade .28s var(--ease) both;
    }
    .card { width: min(560px, 100%); max-height: 100%; overflow: auto; padding: 24px; background: var(--raised); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); animation: pop .36s var(--ease) both; }
    .card .head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .card .state { display: flex; align-items: center; gap: 9px; font-size: 15px; font-weight: 600; }
    .card .state i { width: 7px; height: 7px; border-radius: 50%; background: var(--fg3); }
    .card .state.go i { background: var(--green); animation: pulse 1.2s var(--ease) infinite; }
    .card .state.wait i { background: var(--amber); animation: pulse 1.2s var(--ease) infinite; }
    .card .state.hold i { background: var(--amber); }
    .card .state.ok i { background: var(--green); }
    .card .state.bad { color: var(--red); }
    .card .state.bad i { background: var(--red); }
    .card .frac { font: 12px/1 var(--mono); color: var(--fg3); font-variant-numeric: tabular-nums; }
    .card .frac b { color: var(--fg); font-weight: 600; }
    .bar { height: 3px; margin: 18px 0 20px; border-radius: 3px; background: var(--fill2); overflow: hidden; }
    .bar i { display: block; height: 100%; width: 0; border-radius: 3px; background: var(--fg); transition: width .7s var(--ease); }
    .card .big { margin: 0 0 6px; font: 300 44px/1.1 var(--mono); letter-spacing: -.03em; font-variant-numeric: tabular-nums; }
    .card .explain, .card .say { color: var(--fg2); line-height: 1.55; }
    .card .say { min-height: 40px; }
    .fold { display: grid; grid-template-rows: 0fr; opacity: 0; transition: grid-template-rows .45s var(--ease), opacity .3s var(--ease); }
    .fold.open { grid-template-rows: 1fr; opacity: 1; }
    .fold > div { min-height: 0; overflow: hidden; }
    .wheel {
      position: relative; height: 196px; margin: 4px -12px 0; perspective: 2000px; overflow: hidden; outline: none; cursor: grab; touch-action: none; user-select: none;
      -webkit-mask-image: linear-gradient(to bottom, transparent, #000 14%, #000 86%, transparent); mask-image: linear-gradient(to bottom, transparent, #000 14%, #000 86%, transparent);
    }
    .wheel.dragging { cursor: grabbing; }
    .wheel::before { content: ""; position: absolute; left: 0; right: 0; top: 50%; height: 36px; margin-top: -18px; border-radius: 8px; background: var(--fill); }
    .wheel:focus-visible::before { box-shadow: inset 0 0 0 1.5px var(--fg3); }
    .drum { position: absolute; inset: 0; transform-style: preserve-3d; transition: transform .6s var(--ease); }
    .wheel.dragging .drum, .wheel.dragging .wi { transition-duration: .18s; }
    .drum.instant, .drum.instant .wi { transition: none; }
    .wi {
      position: absolute; left: 0; right: 0; top: 50%; height: 36px; margin-top: -18px; display: flex; align-items: center; gap: 12px; padding: 0 12px;
      white-space: nowrap; opacity: .72; backface-visibility: hidden; -webkit-backface-visibility: hidden; transition: opacity .6s var(--ease);
    }
    .wi.mid { opacity: 1; }
    .wi .g { width: 14px; flex-shrink: 0; display: grid; place-items: center; color: var(--fg3); }
    .wi .g .spin { margin: 0; width: 10px; height: 10px; }
    .wi .v { width: 84px; flex-shrink: 0; color: var(--fg3); font-variant-numeric: tabular-nums; }
    .wi .ttl { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--fg2); }
    .wi.mid .v { color: var(--fg2); }
    .wi.mid .ttl { color: var(--fg); }
    .wi.ok .g { color: var(--green); }
    .wi.bad .g, .wi.bad .v, .wi.bad .ttl { color: var(--red); }
    .wi.unsure .g { color: var(--amber); }
    .card .why { min-height: 18px; margin-top: 4px; font-size: 12px; color: var(--fg3); text-align: center; }
    .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    .card .btns { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 22px; }
    .card .tip { margin-top: 16px; color: var(--fg3); line-height: 1.55; }

    /* Status bar */
    .foot { height: 36px; flex-shrink: 0; display: flex; align-items: center; gap: 18px; padding: 0 var(--gutter); border-top: 1px solid var(--line); font-size: 12px; color: var(--fg3); }
    .foot .state { display: flex; align-items: center; gap: 8px; color: var(--fg); white-space: nowrap; font-variant-numeric: tabular-nums; }
    .foot .state .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--fg3); transition: background-color .3s, box-shadow .3s; }
    .foot .state.ready .dot { background: var(--green); box-shadow: 0 0 0 3px color-mix(in srgb, var(--green) 22%, transparent); }
    .foot .state.busy .dot { background: var(--green); animation: pulse 1.2s var(--ease) infinite; }
    .foot .state.wait .dot { background: var(--amber); animation: pulse 1.2s var(--ease) infinite; }
    .foot .state.hold .dot { background: var(--amber); }
    .foot .state.bad { color: var(--red); }
    .foot .state.bad .dot { background: var(--red); }
    .foot .status { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .foot .links { margin-left: auto; display: flex; gap: 2px; }
    .demo-tag { flex-shrink: 0; padding: 2px 8px; border-radius: 6px; background: var(--fill); color: var(--fg2); white-space: nowrap; }
    .foot .btn { height: 26px; padding: 0 8px; font-size: 12px; color: var(--fg3); }
    .foot .btn:hover:not(:disabled) { color: var(--fg); }
    .foot .btn.on { color: var(--fg); background: var(--fill); }
    .drawer { height: 210px; overflow: auto; padding: 12px var(--gutter); border-top: 1px solid var(--line); background: var(--raised); font: 12px/1.7 var(--mono); color: var(--fg2); animation: up .24s var(--ease) both; }
    .drawer .head { margin-bottom: 8px; font-family: var(--sans); color: var(--fg3); }
    .drawer .s429 { color: var(--amber); font-weight: 600; }
    .drawer .sbad { color: var(--red); }

    /* Dialogs */
    .modal-wrap {
      position: fixed; inset: 0; z-index: 5; display: grid; place-items: center; padding: 20px; background: var(--veil);
      -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); animation: fade .22s var(--ease) both;
    }
    .modal-wrap.leaving { animation: fade-out .15s var(--ease-in) both; pointer-events: none; }
    .modal-wrap.leaving .modal { animation: sink .15s var(--ease-in) both; }
    .review { margin-top: 12px; }
    .review summary { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; color: var(--fg2); list-style: none; border-radius: 6px; }
    .review summary::-webkit-details-marker { display: none; }
    .review summary:hover { color: var(--fg); }
    .review summary svg { transform: rotate(-90deg); transition: transform .2s var(--ease); }
    .review[open] summary svg { transform: none; }
    .review .items { max-height: 188px; overflow: auto; margin-top: 8px; padding: 2px 0 6px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
    .review .grp { margin: 8px 0 2px; font-size: 12px; color: var(--fg3); }
    .review .grp.del { color: var(--red); }
    .review .it { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 12px; align-items: baseline; padding: 3px 0; }
    .review .it .d { font: 12px/1.5 var(--mono); color: var(--fg3); font-variant-numeric: tabular-nums; }
    .review .it .t { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .review .all { margin: 4px 0 0 -10px; }
    .modal { width: min(500px, 100%); max-height: calc(100vh - 48px); overflow: auto; padding: 24px; background: var(--raised); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); animation: rise .32s var(--ease) both; }
    .modal h2 { margin: 0 0 16px; font: 600 18px/1.3 var(--sans); letter-spacing: -.015em; }
    .modal p { margin: 0 0 12px; color: var(--fg2); line-height: 1.55; }
    .modal .hint { margin: 0 0 12px; font-size: 12px; color: var(--fg3); line-height: 1.5; }
    .modal .lbl { margin: 20px 0 8px; font-size: 12px; font-weight: 600; color: var(--fg3); }
    .modal .mfoot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 24px; }
    .modal input[type=text], .modal input[type=number] {
      width: 100%; height: 32px; padding: 0 10px; border: 0; border-radius: 8px; background: var(--fill); font: 13px/1 var(--sans);
      outline: none; box-shadow: inset 0 0 0 1.5px transparent; transition: box-shadow .15s;
    }
    .modal input[type=number] { width: 72px; font-family: var(--mono); }
    .modal input:focus { box-shadow: inset 0 0 0 1.5px var(--fg); }
    .check { display: flex; gap: 12px; align-items: flex-start; margin: 12px 0; cursor: pointer; }
    .check .cb { margin-top: 2px; }
    .check .h { margin-top: 2px; font-size: 12px; color: var(--fg3); }
    .table div { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; padding: 10px 0; border-bottom: 1px solid var(--line); }
    .table div:first-child { border-top: 1px solid var(--line); }
    .table .n { font: 600 12px/1 var(--mono); font-variant-numeric: tabular-nums; }
    .table .x { margin-left: 10px; font-size: 12px; color: var(--fg3); }
    .table .del, .table .del .x { color: var(--red); }
    .eta { margin: 12px 0 4px; color: var(--fg3); }
    .eta .num { font-family: var(--mono); color: var(--fg2); }
    .keys { display: grid; grid-template-columns: 112px 1fr; gap: 8px 16px; align-items: baseline; }
    .keys .k { font: 12px/1.4 var(--mono); color: var(--fg); }
    .keys .d { color: var(--fg2); }
    .inline { display: flex; align-items: center; gap: 10px; color: var(--fg2); }
    .stack { display: flex; flex-wrap: wrap; gap: 2px; margin-left: -10px; }
    .seg { display: inline-flex; gap: 2px; padding: 2px; border-radius: 10px; background: var(--fill); }
    .seg button { height: 28px; padding: 0 12px; border: 0; border-radius: 8px; background: transparent; cursor: pointer; color: var(--fg2); transition: background-color .2s var(--ease), color .2s; }
    .seg button:hover { color: var(--fg); }
    .seg button.on { background: var(--raised); color: var(--fg); box-shadow: 0 1px 3px rgba(0, 0, 0, .14); }
    .root.dark .seg button.on { background: var(--fill2); }

    .toast {
      position: fixed; left: 50%; bottom: 56px; z-index: 9; transform: translateX(-50%); max-width: min(560px, calc(100vw - 32px));
      padding: 10px 16px; border-radius: 10px; background: var(--fg); color: var(--bg); line-height: 1.45;
      box-shadow: var(--shadow); animation: toast .32s var(--ease) both;
    }
    .toast.leaving { animation: toast-out .2s var(--ease-in) both; }
    @media (min-width: 981px) {
      .toast { left: calc(clamp(420px, 44vw, 600px) / 2); max-width: calc(clamp(420px, 44vw, 600px) - 32px); }
    }

    @media (max-width: 980px) {
      .queue { display: none; }
      .main { flex-direction: column; }
      .left { width: auto; min-width: 0; height: 50%; border-right: 0; border-bottom: 1px solid var(--line); }
      .col { padding: 0 20px; }
    }
    @media (max-width: 640px) {
      /* Phones: the tabs get their own row, so the buttons on the right stay on screen. */
      .top { height: auto; flex-wrap: wrap; gap: 0 12px; padding: 12px 12px 0; }
      .tabs { order: 5; flex-basis: 100%; height: 40px; overflow-x: auto; scrollbar-width: none; }
      .tabbtns { height: 100%; gap: 18px; }
      .actions .run { margin-left: 0; }
      /* No keyboard on a phone: drop the shortcut hints so the reader's actions fit. */
      .reader .b1 .key, .search .key { display: none; }
      .reader .b1 .lbl { display: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration: 1ms !important; animation-iteration-count: 1 !important; transition-duration: 1ms !important; }
    }
  `;

  // The reveal needs a few rules on the page itself, because the browser draws
  // the theme-switch snapshots outside Triage's own shadow DOM.
  const PAGE_CSS = `
    html.${APP}-reveal::view-transition-old(root), html.${APP}-reveal::view-transition-new(root) { animation: none; mix-blend-mode: normal; }
    html.${APP}-reveal::view-transition-old(root) { z-index: 1; }
    html.${APP}-reveal::view-transition-new(root) { z-index: 2; }
    html.${APP}-fade::view-transition-old(root), html.${APP}-fade::view-transition-new(root) { animation-duration: .18s; }
  `;

  const spinner = () => h("span", { class: "spin", "aria-hidden": "true" });
  const pad2 = (n) => String(n).padStart(2, "0");
  const num = (n) => h("span", { class: "num" }, String(n));

  function isoDate(t) {
    if (!t) return "—";
    const d = new Date(t);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function clock(ms) {
    const s = Math.max(0, Math.ceil(ms / SEC));
    const hours = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    return hours ? `${hours}:${pad2(mins)}:${pad2(s % 60)}` : `${pad2(mins)}:${pad2(s % 60)}`;
  }

  // replaceChildren turns null into the text "null", so drop empty slots first.
  function put(parent, ...kids) {
    parent.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  }

  const ui = {
    root: null,
    host: null,
    panel: null,
    launcher: null,
    el: {},
    isOpen: false,
    booted: false,
    fatal: null,
    lockedElsewhere: false,
    filters: { scope: "main", q: "", age: 0, unread: false, untitled: false, marked: false, sort: "oldest" },
    sel: new Set(),
    fresh: new Set(), // chats marked a moment ago, so only they animate
    anchor: null,
    focusId: null,
    readerId: null,
    reader: null, // { id, status: "loading" | "ok" | "error", error }
    readerBody: null,
    order: [],
    rowEls: new Map(),
    rowSigs: new Map(),
    shownOrder: null,
    indexOf: new Map(), // chat id -> position in the list
    winRaf: 0,
    actsEl: null,
    drawer: null, // "activity" | "network" | null
    menu: null, // { which, el, anchor }
    modal: null,
    modalClose: null,
    runSig: "",
    rv: null,
    lastQueueTotal: null,
    themeOverride: null,
    themeBusy: false,
    previewTimer: null,
    closeTimer: null,
    toastEl: null,
    toastTimer: null,

    onNetwork() {
      if (ui.drawer === "network") ui.renderDrawer();
    },
    onActivity() {
      if (ui.drawer === "activity") ui.renderDrawer();
      if (ui.el.status) ui.renderStatus();
    },
    onCooldown() {
      if (!ui.booted) return;
      ui.renderBanners();
      ui.renderLauncher();
      renderState();
    },
  };

  ui.mount = function mount() {
    const host = document.createElement("div");
    host.id = APP;
    host.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;z-index:2147483646;";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;
    shadow.append(style);
    const root = h("div", { class: "root" });
    shadow.append(root);
    ui.host = host;
    ui.root = root;

    if (!document.getElementById(`${APP}-page`)) {
      const pageStyle = document.createElement("style");
      pageStyle.id = `${APP}-page`;
      pageStyle.textContent = PAGE_CSS;
      (document.head || document.documentElement).append(pageStyle);
    }

    ui.launcher = h("button", { class: "launcher", type: "button", title: "Open Triage (Alt+Shift+T)", "aria-label": "Open Triage", onclick: () => ui.open() });
    ui.renderLauncher();
    root.append(ui.launcher, buildPanel());
    root.addEventListener("keydown", onKey);
    root.addEventListener("mousedown", (e) => {
      if (ui.menu && !e.composedPath().some((n) => n === ui.menu.el || n === ui.menu.anchor)) closeMenu();
    });
    // Keep ChatGPT's own shortcuts from reacting to keys typed inside Triage.
    for (const type of ["keydown", "keyup", "keypress"]) {
      host.addEventListener(type, (e) => {
        if (ui.isOpen || ui.modal) e.stopPropagation();
      });
    }
    document.body.append(host);
    setInterval(() => {
      if (!host.isConnected) document.body.append(host);
    }, 2000);

    paintTheme(wantDark());
    new MutationObserver(() => ui.syncTheme()).observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    if (window.matchMedia) window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => ui.syncTheme());
  };

  // ---------------------------------------------------------------------------
  // Theme: follows ChatGPT unless you pick light or dark. Switching by hand
  // grows the new theme as a circle from the button you pressed, so every pixel
  // changes on the same clock instead of in patches.
  // ---------------------------------------------------------------------------

  const THEME_KEY = `${APP}:theme`;
  function themePref() {
    if (ui.themeOverride) return ui.themeOverride;
    try {
      return localStorage.getItem(THEME_KEY) || "auto";
    } catch {
      return "auto";
    }
  }

  function wantDark() {
    const pref = themePref();
    const de = document.documentElement;
    if (pref === "dark") return true;
    if (pref === "light") return false;
    if (de.classList.contains("dark")) return true;
    if (de.classList.contains("light")) return false;
    return Boolean(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }

  function paintTheme(dark) {
    ui.root.classList.toggle("dark", dark);
    const b = ui.el.themeBtn;
    if (b && b.dataset.dark !== String(dark)) {
      const label = dark ? "Switch to light mode" : "Switch to dark mode";
      b.dataset.dark = String(dark);
      b.title = label;
      b.setAttribute("aria-label", label);
      b.replaceChildren(icon(dark ? "sun" : "moon", 16));
    }
  }

  // Changes the theme in one frame, with hover transitions paused so nothing lags behind.
  function snapTheme(dark) {
    ui.root.classList.add("no-anim");
    paintTheme(dark);
    requestAnimationFrame(() => requestAnimationFrame(() => ui.root.classList.remove("no-anim")));
  }

  function applyTheme(origin) {
    const dark = wantDark();
    if (ui.root.classList.contains("dark") === dark) {
      paintTheme(dark);
      return;
    }
    if (!origin || !ui.isOpen || document.hidden || typeof document.startViewTransition !== "function") {
      snapTheme(dark);
      return;
    }
    // With reduced motion, a short fade instead of the moving circle: nothing travels across the screen.
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const mode = reduce ? `${APP}-fade` : `${APP}-reveal`;
    const box = origin.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    const de = document.documentElement;
    ui.themeBusy = true;
    de.classList.add(mode);
    let transition;
    try {
      transition = document.startViewTransition(() => snapTheme(dark));
    } catch {
      de.classList.remove(mode);
      ui.themeBusy = false;
      snapTheme(dark);
      return;
    }
    if (!reduce) transition.ready.then(() => {
      de.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 560, easing: "cubic-bezier(.22, 1, .36, 1)", pseudoElement: "::view-transition-new(root)" },
      );
    }).catch(() => {});
    transition.finished.finally(() => {
      de.classList.remove(mode);
      ui.themeBusy = false;
    });
  }

  function setThemePref(value, origin) {
    try {
      if (value === "auto") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, value);
    } catch {
      /* storage blocked: the choice lasts until reload */
    }
    ui.themeOverride = value;
    applyTheme(origin);
  }

  function toggleTheme(e) {
    setThemePref(ui.root.classList.contains("dark") ? "light" : "dark", e && e.currentTarget);
  }

  // Called when ChatGPT's own theme changes. Our own reveal also touches <html>, so skip that.
  ui.syncTheme = function syncTheme() {
    if (!ui.themeBusy) applyTheme(null);
  };

  // ---------------------------------------------------------------------------
  // Building the panel
  // ---------------------------------------------------------------------------

  function iconBtn(name, title, onclick, cls = "") {
    return h("button", { class: `btn icon ${cls}`.trim(), type: "button", title, "aria-label": title, onclick }, icon(name, 16));
  }

  function buildPanel() {
    const el = ui.el;
    el.tabBtns = h("div", { class: "tabbtns", role: "tablist", "aria-label": "Which chats" });
    el.tabInd = h("span", { class: "tabind instant", "aria-hidden": "true" });
    el.tabs = h("div", { class: "tabs" }, el.tabBtns, el.tabInd);
    // Keep the underline under the active tab when the layout changes, e.g. into the phone layout.
    if (typeof ResizeObserver === "function") new ResizeObserver(() => placeTabIndicator()).observe(el.tabs);
    el.queue = h("div", { class: "queue", "aria-live": "polite" });
    el.runBtn = h("button", { class: "run", type: "button", title: "Review the queue, then run it", onclick: () => confirmRun() });
    el.themeBtn = h("button", { class: "btn icon theme", type: "button", onclick: toggleTheme });
    const top = h("div", { class: "top" },
      h("div", { class: "brand", title: `Triage ${VERSION}` }, "Triage"),
      el.tabs,
      h("div", { class: "spacer" }),
      el.queue,
      h("div", { class: "actions" },
        el.runBtn,
        el.themeBtn,
        iconBtn("sliders", "Settings", () => openSettings()),
        iconBtn("x", "Close. Your marks are saved.", () => ui.close())));

    el.banners = h("div", { class: "banners" });

    // Left column
    el.search = h("input", {
      type: "text", placeholder: "Search titles and opened chats", "aria-label": "Search",
      title: "Searches every title, plus the text of chats you've opened in Triage",
      oninput: (e) => {
        ui.filters.q = e.target.value;
        ui.renderList();
      },
    });
    el.filterBtn = h("button", { class: "btn quiet", type: "button", "aria-haspopup": "menu", onclick: () => toggleMenu("filter", el.filterBtn) });
    el.refresh = iconBtn("refresh", "Reload the chat list", () => reloadLists());
    el.listhead = h("div", { class: "band b2" });
    el.cursor = h("div", { class: "cursor instant", "aria-hidden": "true" });
    el.rows = h("div", { class: "rows" });
    el.more = h("div", { class: "note more", hidden: true });
    el.list = h("div", {
      class: "list", tabindex: "0", role: "listbox", "aria-label": "Chats", onclick: onListClick,
      onmouseover: (e) => {
        const row = e.target.closest(".row");
        if (row && !(ui.actsEl && row.contains(ui.actsEl))) attachActs(row);
      },
      onscroll: () => {
        if (ui.winRaf) return;
        ui.winRaf = requestAnimationFrame(() => {
          ui.winRaf = 0;
          renderWindow();
        });
      },
    }, el.cursor, el.rows, el.more);
    if (typeof ResizeObserver === "function") new ResizeObserver(() => renderWindow()).observe(el.list);
    el.left = h("div", { class: "left" },
      h("div", { class: "band b1" },
        h("label", { class: "search" }, icon("search", 16), el.search, h("span", { class: "key" }, "/")),
        h("div", { class: "pop" }, el.filterBtn)),
      el.listhead,
      el.list);

    // Right column: every part shares one centred column
    el.actionsCol = h("div", { class: "col" });
    el.metaCol = h("div", { class: "col meta" });
    el.scroll = h("div", { class: "scroll" });
    el.reader = h("div", { class: "reader" },
      h("div", { class: "band b1" }, el.actionsCol),
      h("div", { class: "band b2" }, el.metaCol),
      el.scroll);
    el.runLayer = h("div", { class: "runlayer", hidden: true });
    el.main = h("div", { class: "main" }, el.left, el.reader, el.runLayer);

    el.state = h("div", { class: "state" });
    el.status = h("div", { class: "status" });
    el.activityBtn = h("button", { class: "btn", type: "button", onclick: () => toggleDrawer("activity") }, "Activity");
    el.networkBtn = h("button", { class: "btn", type: "button", title: "Every request Triage has sent", onclick: () => toggleDrawer("network") }, "Network");
    el.drawerEl = h("div", { class: "drawer", hidden: true });
    const demoTag = TEST.demo && !TEST.shot
      ? h("span", { class: "demo-tag", title: `A made-up ChatGPT account; nothing real is touched.${SCALE === 1 ? "" : ` Every wait runs ${SPEEDUP}× faster than on chatgpt.com.`}` }, SCALE === 1 ? "Demo" : `Demo · ${SPEEDUP}× Speed`)
      : null;
    const foot = h("div", { class: "foot" }, el.state, el.status, demoTag,
      h("div", { class: "links" }, el.activityBtn, el.networkBtn,
        h("a", { class: "btn", href: HOMEPAGE, target: "_blank", rel: "noopener noreferrer" }, "GitHub ↗"),
        h("button", { class: "btn", type: "button", onclick: () => openHelp() }, "? Shortcuts")));

    ui.panel = h("div", { class: "panel", hidden: true, tabindex: "-1", role: "dialog", "aria-label": "Triage" }, top, el.banners, el.main, el.drawerEl, foot);
    renderFilterButton();
    return ui.panel;
  }

  function check(input, label, help) {
    input.classList.add("cb");
    return h("label", { class: "check" }, input, h("div", null, h("div", null, label), help ? h("div", { class: "h" }, help) : null));
  }

  // ---------------------------------------------------------------------------
  // Filter and sort menus
  // ---------------------------------------------------------------------------

  const AGES = [[0, "Any age"], [7 * DAY, "Older than 1 week"], [30 * DAY, "Older than 1 month"], [90 * DAY, "Older than 3 months"], [180 * DAY, "Older than 6 months"], [365 * DAY, "Older than 1 year"]];
  const SORTS = [["oldest", "Oldest first"], ["newest", "Newest first"], ["updated", "Recently used"]];

  function activeFilters() {
    const f = ui.filters;
    return (f.unread ? 1 : 0) + (f.untitled ? 1 : 0) + (f.marked ? 1 : 0) + (f.age ? 1 : 0);
  }

  function renderFilterButton() {
    const n = activeFilters();
    put(ui.el.filterBtn, icon("filter", 16), "Filter", n ? h("span", { class: "fcount" }, String(n)) : null);
  }

  function menuOpt(label, on, group, onPick, title) {
    return h("button", {
      class: `opt${on ? " on" : ""}`, type: "button", role: "menuitemcheckbox", "aria-checked": String(Boolean(on)), title, "data-group": group,
      onclick: (e) => {
        e.stopPropagation();
        const b = e.currentTarget;
        if (group === "toggle") b.classList.toggle("on");
        else for (const sib of b.parentElement.querySelectorAll(`[data-group="${group}"]`)) sib.classList.toggle("on", sib === b);
        b.setAttribute("aria-checked", String(b.classList.contains("on")));
        onPick();
      },
    }, h("span", null, label), icon("check", 15));
  }

  function toggleMenu(which, anchor) {
    if (ui.menu && ui.menu.which === which) {
      closeMenu();
      return;
    }
    closeMenu();
    const f = ui.filters;
    const after = () => {
      renderFilterButton();
      ui.renderList();
    };
    let menu;
    if (which === "filter") {
      const toggle = (key, label, title) => menuOpt(label, f[key], "toggle", () => {
        f[key] = !f[key];
        after();
      }, title);
      menu = h("div", { class: "menu right", role: "menu" },
        h("div", { class: "mh" }, "Show only"),
        toggle("unread", "Unread", "Chats you haven't opened in Triage"),
        toggle("untitled", "Untitled", "Chats called “New chat” or with no title"),
        toggle("marked", "Marked", "Chats with a queued change"),
        h("hr"),
        h("div", { class: "mh" }, "Age"),
        AGES.map(([ms, label]) => menuOpt(label, f.age === ms, "age", () => {
          f.age = ms;
          after();
        })));
    } else {
      menu = h("div", { class: "menu right", role: "menu" },
        h("div", { class: "mh" }, "Sort"),
        SORTS.map(([key, label]) => menuOpt(label, f.sort === key, "sort", () => {
          f.sort = key;
          closeMenu();
          ui.renderList();
        })));
    }
    anchor.parentElement.append(menu);
    ui.menu = { which, el: menu, anchor };
  }

  function closeMenu() {
    if (!ui.menu) return;
    ui.menu.el.remove();
    ui.menu = null;
  }

  // ---------------------------------------------------------------------------
  // Opening, closing, booting
  // ---------------------------------------------------------------------------

  ui.open = function open() {
    clearTimeout(ui.closeTimer);
    ui.panel.classList.remove("leaving");
    ui.panel.hidden = false;
    ui.launcher.hidden = true;
    ui.isOpen = true;
    ui.el.list.focus({ preventScroll: true });
    if (!ui.booted) boot();
    else ui.renderAll();
  };

  ui.close = function close() {
    closeModal();
    closeMenu();
    ui.isOpen = false;
    ui.panel.classList.add("leaving");
    clearTimeout(ui.closeTimer);
    ui.closeTimer = setTimeout(() => {
      ui.panel.hidden = true;
      ui.panel.classList.remove("leaving");
    }, 160);
    ui.launcher.hidden = false;
    ui.renderLauncher();
  };

  async function boot() {
    ui.booted = true;
    Data.loading = { scope: "active", n: 0, total: null, waiting: false, message: "Connecting to ChatGPT" };
    ui.renderAll();
    try {
      await Api.session();
    } catch (e) {
      ui.fatal = e.message;
      Data.loading = null;
      ui.renderAll();
      return;
    }
    Store.open(Api.accountId);
    const r = Store.data.run;
    if (r && ACTIVE.includes(r.status)) {
      if (r.owner !== Runner.tabId && now() - (r.beat || 0) < CFG.staleBeat) {
        ui.lockedElsewhere = true;
      } else {
        r.status = "paused";
        r.note = "Triage was closed or the page reloaded mid-run. Nothing was lost.";
        Store.flush();
      }
    }
    await loadActive();
  }

  async function loadActive() {
    Data.loading = { scope: "active", n: 0, total: null, waiting: false };
    ui.renderAll();
    try {
      Data.active = await loadList("active", (n, total, waiting) => {
        Data.loading = { scope: "active", n, total, waiting };
        ui.renderList();
        ui.renderTabs();
        renderState();
      });
      Data.index();
      Data.loading = null;
      ui.fatal = null;
      note(`Loaded ${plural(Data.active.length, "chat")}.`);
    } catch (e) {
      Data.loading = null;
      ui.fatal = e.message;
    }
    ui.renderAll();
  }

  async function loadArchived() {
    if (Data.loading) return;
    Data.loading = { scope: "archived", n: 0, total: null, waiting: false };
    ui.renderAll();
    try {
      Data.archived = await loadList("archived", (n, total, waiting) => {
        Data.loading = { scope: "archived", n, total, waiting };
        ui.renderList();
        renderState();
      });
      Data.archivedLoaded = true;
      Data.index();
      note(`Loaded ${plural(Data.archived.length, "archived chat")}.`);
    } catch (e) {
      ui.toast(e.message);
    }
    Data.loading = null;
    ui.renderAll();
  }

  async function reloadLists() {
    if (Runner.isActive() || Data.loading) return;
    await loadActive();
    if (Data.archivedLoaded) {
      Data.archivedLoaded = false;
      await loadArchived();
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  ui.renderAll = function renderAll() {
    if (!ui.booted) return;
    ui.renderTabs();
    ui.renderTop();
    ui.renderBanners();
    // While a run is going, the list sits blurred behind the run card. Redrawing
    // it after every change only makes the blur shimmer, so it waits until the end.
    const running = Store.data.run && ACTIVE.includes(Store.data.run.status);
    if (!running) {
      ui.renderList();
      ui.renderReader();
    }
    ui.renderRun();
    ui.renderStatus();
    ui.renderLauncher();
    if (ui.drawer) ui.renderDrawer();
  };

  function counts() {
    let main = 0;
    let projects = 0;
    for (const c of Data.active) {
      if (c.projectId) projects += 1;
      else main += 1;
    }
    return { main, projects, archived: Data.archivedLoaded ? Data.archived.length : null, all: Data.active.length };
  }

  const TAB_LABEL = { main: "Main", projects: "Projects", archived: "Archived", all: "All" };

  ui.renderTabs = function renderTabs() {
    const n = counts();
    const tabs = [
      ["main", n.main, "Your regular chats. Project chats are left out so a cleanup can't empty a project by accident."],
      ["projects", n.projects, "Chats that live inside Projects"],
      ["archived", n.archived, "Chats you've archived. They load when you open this tab."],
      ["all", n.all, "Main and project chats together"],
    ];
    put(ui.el.tabBtns, tabs.map(([key, count, title]) => h("button", {
      class: `tab${ui.filters.scope === key ? " on" : ""}`, type: "button", role: "tab", title,
      "aria-selected": String(ui.filters.scope === key),
      onclick: () => setScope(key),
    }, h("span", { class: "tl" }, h("span", null, TAB_LABEL[key]), count == null ? null : h("span", { class: "n" }, String(count))))));
    requestAnimationFrame(placeTabIndicator);
  };

  // The underline glides to the active tab.
  function placeTabIndicator() {
    const ind = ui.el.tabInd;
    const on = ui.el.tabBtns.querySelector(".tab.on");
    if (!on || !on.offsetWidth) {
      ind.style.opacity = "0";
      return;
    }
    const first = ind.style.opacity !== "1";
    ind.classList.toggle("instant", first);
    ind.style.width = `${on.offsetWidth}px`;
    ind.style.transform = `translateX(${on.offsetLeft}px)`;
    ind.style.opacity = "1";
    if (first) requestAnimationFrame(() => ind.classList.remove("instant"));
  }

  function setScope(scope) {
    if (Runner.isActive()) return;
    ui.filters.scope = scope;
    ui.sel.clear();
    ui.renderTabs();
    ui.renderList();
    if (scope === "archived" && !Data.archivedLoaded) loadArchived();
  }

  ui.renderTop = function renderTop() {
    const q = queueCounts();
    const parts = [];
    for (const a of ["delete", "archive", "unarchive", "rename"]) {
      if (q[a]) parts.push(h("span", { class: `q-${a}` }, ACTION[a].label, h("b", null, String(q[a]))));
    }
    put(ui.el.queue, parts.length ? parts : h("span", null, "Queue Empty"));
    renderRunButton(q.total);
    ui.el.runBtn.disabled = !q.total || Runner.isActive() || Boolean(Store.data.run) || ui.lockedElsewhere || !Data.compatOk || Boolean(Data.loading);
    ui.el.refresh.disabled = Runner.isActive() || Boolean(Data.loading);
  };

  function renderRunButton(total) {
    const btn = ui.el.runBtn;
    const bump = ui.lastQueueTotal !== null && total !== ui.lastQueueTotal && total > 0;
    ui.lastQueueTotal = total;
    put(btn,
      h("span", { class: "go" }, icon("play", 11), "Run Queue"),
      total ? h("span", { class: `count${bump ? " bump" : ""}` }, h("span", null, String(total))) : null);
  }

  ui.renderBanners = function renderBanners() {
    const out = [];
    const left = Api.cooldownLeft();
    if (left > 0 && !Runner.isActive()) {
      out.push(h("div", { class: "banner" }, h("b", null, "Waiting"),
        h("span", null, `ChatGPT asked Triage to slow down. Reading and running resume at ${fmtClock(Store.data.cooldownUntil)}.`),
        h("span", { class: "clock", "data-countdown": "" }, clock(left))));
    }
    if (ui.lockedElsewhere) {
      out.push(h("div", { class: "banner" }, h("b", null, "Busy"), h("span", null, "Triage is running a queue in another tab. Use that tab, or close it and reload this one.")));
    }
    if (!Data.compatOk) {
      out.push(h("div", { class: "banner bad" }, h("b", null, "Changes Off"), h("span", null, "ChatGPT's data looks different from what Triage expects, so changes are switched off. Reading still works. Check GitHub for an update.")));
    }
    put(ui.el.banners, out);
  };

  function visibleChats() {
    const f = ui.filters;
    const d = Store.data;
    let rows;
    if (f.scope === "archived") rows = Data.archived;
    else if (f.scope === "projects") rows = Data.active.filter((c) => c.projectId);
    else if (f.scope === "all") rows = Data.active;
    else rows = Data.active.filter((c) => !c.projectId);
    const q = f.q.trim().toLowerCase();
    const cutoff = f.age ? now() - f.age : 0;
    rows = rows.filter((c) => {
      if (q && !(c.title || "").toLowerCase().includes(q)) {
        const conv = cache.get(c.id);
        if (!conv || !conv.search.includes(q)) return false;
      }
      if (cutoff && !(c.created && c.created < cutoff)) return false;
      if (f.unread && d.seen[c.id]) return false;
      if (f.untitled && !isUntitled(c)) return false;
      if (f.marked && !d.marks[c.id]) return false;
      return true;
    });
    const by = {
      oldest: (a, b) => a.created - b.created,
      newest: (a, b) => b.created - a.created,
      updated: (a, b) => b.updated - a.updated,
    }[f.sort];
    return rows.slice().sort(by);
  }

  const selectable = (c) => !Store.data.protect[c.id] && (Store.data.settings.pinnedInSelectAll || !c.pinned);

  // Every row is exactly this tall, which is what makes the virtual list simple.
  const ROW_H = 36;
  const ROW_BUFFER = 8; // rows kept on the page above and below the visible ones

  ui.renderList = function renderList() {
    const el = ui.el;
    el.list.classList.toggle("selecting", ui.sel.size > 0);
    const dropRows = () => {
      ui.rowEls = new Map();
      ui.rowSigs = new Map();
      ui.shownOrder = null;
    };
    if (ui.fatal) {
      dropRows();
      ui.order = [];
      put(el.listhead);
      put(el.rows, h("div", { class: "note" }, h("div", null, ui.fatal), h("button", { class: "btn", type: "button", onclick: () => retryBoot() }, "Try Again")));
      placeCursor(false);
      return;
    }
    const L = Data.loading;
    const loadingHere = L && (L.scope === "archived") === (ui.filters.scope === "archived");
    const rows = visibleChats();
    ui.order = rows.map((c) => c.id);
    // What you see is what you act on: a chat hidden by search, a filter or a tab
    // leaves the selection, so a bulk action never reaches chats off screen.
    if (ui.sel.size && !loadingHere) {
      const shown = new Set(ui.order);
      for (const id of ui.sel) if (!shown.has(id)) ui.sel.delete(id);
      el.list.classList.toggle("selecting", ui.sel.size > 0);
    }

    if (loadingHere && !rows.length) {
      put(el.listhead);
      const text = L.message || (L.waiting
        ? `ChatGPT asked Triage to slow down. Carrying on at ${fmtClock(Store.data.cooldownUntil)}.`
        : `Loading chats  ${L.n}${L.total ? ` / ~${L.total}` : ""}`);
      dropRows();
      put(el.rows, h("div", { class: "note" }, spinner(), text));
      placeCursor(false);
      return;
    }

    renderListHead(rows);
    if (!rows.length) {
      const filtered = ui.filters.q || activeFilters();
      dropRows();
      put(el.rows, h("div", { class: "note" }, h("div", null, filtered ? "No chats match these filters." : "No chats here."),
        filtered ? h("button", { class: "btn", type: "button", onclick: clearFilters }, "Clear Filters") : null));
      placeCursor(false);
      return;
    }
    // A virtual list: only the rows in view, plus a few either side, exist on the page, so 3,000 chats
    // cost about the same as 30. The full order lives in ui.shownOrder; renderWindow() draws the rows.
    const prev = ui.shownOrder;
    const same = prev && prev.length === rows.length && rows.every((c, i) => prev[i] === c.id);
    if (!same) {
      dropRows();
      put(el.rows);
      ui.shownOrder = ui.order.slice();
      ui.indexOf = new Map(ui.order.map((id, i) => [id, i]));
    }
    el.rows.style.height = `${rows.length * ROW_H}px`;
    el.more.hidden = !loadingHere;
    if (loadingHere) put(el.more, spinner(), L.waiting ? "Waiting for ChatGPT" : `Loading  ${L.n}${L.total ? ` / ~${L.total}` : ""}`);
    if (ui.focusId && !ui.indexOf.has(ui.focusId)) ui.focusId = null;
    renderWindow();
    ui.fresh.clear();
    placeCursor(false);
    ui.renderStatus();
  };

  // Draws the rows in view (plus a few either side, and the highlighted one) and removes the rest.
  // A row that hasn't changed is left alone; a row whose look changed is rebuilt in place.
  function renderWindow() {
    const el = ui.el;
    const order = ui.shownOrder;
    if (!order || !order.length) return;
    const n = order.length;
    const top = el.list.scrollTop - el.rows.offsetTop;
    const first = clamp(Math.floor(top / ROW_H) - ROW_BUFFER, 0, n - 1);
    const last = clamp(Math.ceil((top + (el.list.clientHeight || 800)) / ROW_H) + ROW_BUFFER, 0, n - 1);
    const want = [];
    for (let i = first; i <= last; i += 1) want.push(i);
    // Screen readers point at the highlighted row, so it stays on the page even when scrolled away.
    const fi = ui.focusId ? ui.indexOf.get(ui.focusId) : undefined;
    if (fi !== undefined && (fi < first || fi > last)) want.push(fi);
    want.sort((a, b) => a - b);
    const keep = new Set(want.map((i) => order[i]));
    for (const [id, node] of ui.rowEls) {
      if (keep.has(id)) continue;
      node.remove();
      ui.rowEls.delete(id);
      ui.rowSigs.delete(id);
    }
    let before = null;
    for (const i of want) {
      const id = order[i];
      const c = Data.byId.get(id);
      if (!c) continue;
      const sig = rowSig(c);
      let node = ui.rowEls.get(id);
      if (!node || ui.rowSigs.get(id) !== sig) {
        const row = rowEl(c, i, n);
        if (node) node.replaceWith(row);
        else if (before) before.after(row);
        else el.rows.prepend(row);
        node = row;
        ui.rowEls.set(id, row);
        ui.rowSigs.set(id, sig);
      }
      before = node;
    }
    const hovered = el.rows.querySelector(".row:hover");
    if (hovered && !(ui.actsEl && hovered.contains(ui.actsEl))) attachActs(hovered);
  }
  ui.renderWindow = renderWindow;

  function renderListHead(rows) {
    const pickable = rows.filter(selectable);
    const selectedHere = pickable.filter((c) => ui.sel.has(c.id)).length;
    const all = h("input", { type: "checkbox", class: "cb", title: "Select all shown (skips protected and pinned chats)", "aria-label": "Select all shown" });
    all.checked = pickable.length > 0 && selectedHere === pickable.length;
    all.indeterminate = selectedHere > 0 && selectedHere < pickable.length;
    all.addEventListener("change", () => {
      if (all.checked) for (const c of pickable) ui.sel.add(c.id);
      else for (const c of pickable) ui.sel.delete(c.id);
      ui.renderList();
    });
    let label;
    let group;
    if (ui.sel.size) {
      const archivedScope = ui.filters.scope === "archived";
      label = h("span", { class: "head-label" }, h("b", null, String(ui.sel.size)), " Selected");
      group = h("div", { class: "grp" },
        bulkBtn("delete"),
        archivedScope ? bulkBtn("unarchive") : bulkBtn("archive"),
        h("button", { class: "btn", type: "button", title: "Protect the selected chats (P)", onclick: () => applyAction("protect", selectedChats()) }, "Protect"),
        h("button", { class: "btn quiet", type: "button", title: "Remove queued changes from the selected chats (C)", onclick: () => applyAction("clear", selectedChats()) }, "Clear"),
        h("button", { class: "btn quiet", type: "button", title: "Select the shown chats that aren't selected", onclick: invertSelection }, "Invert"),
        h("button", { class: "btn quiet", type: "button", onclick: () => { ui.sel.clear(); ui.renderList(); } }, "Deselect"));
    } else {
      label = h("span", { class: "head-label" }, `${rows.length} ${rows.length === 1 ? "Chat" : "Chats"}`);
      const sortLabel = SORTS.find(([k]) => k === ui.filters.sort)[1];
      const sortBtn = h("button", { class: "btn quiet", type: "button", "aria-haspopup": "menu", onclick: (e) => toggleMenu("sort", e.currentTarget) }, sortLabel, icon("chevron", 14));
      group = h("div", { class: "grp" }, h("div", { class: "pop" }, sortBtn), ui.el.refresh);
    }
    put(ui.el.listhead, h("span", { class: "gut" }, all), label, group);
  }

  function bulkBtn(action) {
    const a = ACTION[action];
    return h("button", { class: `btn t-${action}${action === "delete" ? " danger" : ""}`, type: "button", title: `${a.label} the selected chats (${a.key})`, onclick: () => applyAction(action, selectedChats()) }, a.label);
  }

  // Everything a row's look depends on. Same signature, same row: no need to rebuild it.
  function rowSig(c) {
    const d = Store.data;
    const m = d.marks[c.id];
    return [c.title, c.created, c.pinned ? 1 : 0, c.projectId ? 1 : 0, c.gptId ? 1 : 0, c.archived ? 1 : 0, m ? `${m.a}:${m.t || ""}` : "",
      d.protect[c.id] ? 1 : 0, ui.sel.has(c.id) ? 1 : 0, d.seen[c.id] ? 1 : 0, c.id === ui.focusId ? 1 : 0, ui.fresh.has(c.id) ? 1 : 0,
      ui.filters.scope === "projects" ? 1 : 0].join("\u0001");
  }

  // The hover buttons are built only for the row under the pointer, not for every row in the list.
  function attachActs(row) {
    const c = row && Data.byId.get(row.dataset.id);
    if (!c) return;
    const d = Store.data;
    const mark = d.marks[c.id];
    const prot = Boolean(d.protect[c.id]);
    const archiveAction = c.archived ? "unarchive" : "archive";
    if (ui.actsEl) ui.actsEl.remove();
    ui.actsEl = h("span", { class: "acts" },
      miniBtn(archiveAction, Boolean(mark && mark.a === archiveAction)),
      miniBtn("delete", Boolean(mark && mark.a === "delete")),
      miniBtn("rename", Boolean(mark && mark.a === "rename")),
      miniBtn("protect", prot));
    row.querySelector(".end").append(ui.actsEl);
  }

  function rowEl(c, i = 0, n = 0) {
    const d = Store.data;
    const mark = d.marks[c.id];
    const prot = Boolean(d.protect[c.id]);
    const fresh = ui.fresh.has(c.id);
    const cls = ["row"];
    if (c.id === ui.focusId) cls.push("focus");
    if (ui.sel.has(c.id)) cls.push("sel");
    if (d.seen[c.id]) cls.push("seen");
    if (mark) cls.push(`m-${mark.a}`);
    if (fresh) cls.push("fresh");
    const chips = [];
    if (c.pinned) chips.push(h("span", { class: "chip", title: "Pinned" }, "Pinned"));
    if (c.projectId && ui.filters.scope !== "projects") chips.push(h("span", { class: "chip", title: "In a project" }, "Project"));
    if (c.gptId) chips.push(h("span", { class: "chip", title: "Chat with a custom GPT" }, "GPT"));
    const cb = h("input", { type: "checkbox", class: "cb", tabindex: "-1", "aria-label": "Select", disabled: prot });
    cb.checked = ui.sel.has(c.id);
    let tag = null;
    if (prot) tag = h("span", { class: `mark prot${fresh ? " fresh" : ""}`, title: "Protected: Triage won't change this chat" }, icon("shield", 13), "Protected");
    else if (mark && mark.a === "rename") tag = h("span", { class: `mark${fresh ? " fresh" : ""}`, title: `Rename to ${quote(mark.t)}` }, "Rename");
    else if (mark) tag = h("span", { class: `mark ${mark.a}${fresh ? " fresh" : ""}` }, mark.a === "delete" ? null : icon(ACTION[mark.a].icon, 13), ACTION[mark.a].label);
    // The new name sits right after the old one, so the pair reads as one change.
    const renameTo = !prot && mark && mark.a === "rename" ? mark.t : null;
    return h("div", {
      class: cls.join(" "), id: `r-${c.id}`, "data-id": c.id, style: `top:${i * ROW_H}px`,
      role: "option", "aria-selected": String(c.id === ui.focusId), "aria-posinset": i + 1, "aria-setsize": n,
    },
      h("span", { class: "gut" }, d.seen[c.id] ? null : h("span", { class: "dot", title: "Not opened yet" }), cb),
      h("span", { class: "date", title: c.created ? new Date(c.created).toLocaleString() : "" }, isoDate(c.created)),
      h("span", { class: "title", dir: "auto", title: renameTo ? `${c.title || "Untitled"} → ${renameTo}` : c.title || "Untitled" },
        chips, h("span", { class: "t" }, c.title || "Untitled"), renameTo ? h("span", { class: "to" }, ` → ${renameTo}`) : null),
      h("span", { class: "end" }, tag));
  }

  function miniBtn(action, on) {
    const a = ACTION[action];
    const label = action === "protect" && on ? "Unprotect" : a.label;
    return h("button", { class: `mini${on ? " on" : ""}`, type: "button", tabindex: "-1", "data-act": action, title: `${label} (${a.key})`, "aria-label": label }, icon(a.icon, 15));
  }

  // The inverted bar that glides to the focused chat.
  function placeCursor(animate) {
    const cur = ui.el.cursor;
    if (!cur) return;
    const i = ui.focusId && ui.shownOrder ? ui.indexOf.get(ui.focusId) : undefined;
    if (i === undefined) {
      cur.style.opacity = "0";
      return;
    }
    const y = i * ROW_H + ui.el.rows.offsetTop;
    // Glide between nearby rows; jump straight there when the move is longer than a screen (Home, End).
    const far = Math.abs(y - (ui.cursorY || 0)) > ui.el.list.clientHeight;
    const snap = !animate || far || cur.style.opacity !== "1";
    ui.cursorY = y;
    cur.classList.toggle("instant", snap);
    cur.style.transform = `translateY(${y}px)`;
    cur.style.height = `${ROW_H}px`;
    cur.style.opacity = "1";
    if (snap) requestAnimationFrame(() => cur.classList.remove("instant"));
  }

  function idleLegend() {
    const pair = (k, label) => [h("span", { class: "k" }, k), h("span", { class: "l" }, label)];
    const any = Data.active.length || Data.archived.length;
    return h("div", { class: "idle" }, h("div", { class: "legend" },
      h("div", { class: "h" }, any ? "Pick a chat to read it here" : "Your chats will show up here"),
      h("div", { class: "grid" },
        pair("↑ ↓", "Move"), pair("D", "Delete"),
        pair("⏎", "Read"), pair("A", "Archive"),
        pair("Space", "Select"), pair("R", "Rename"),
        pair("/", "Search"), pair("P", "Protect")),
      h("div", { class: "f" }, "Nothing changes in ChatGPT until you run the queue.")));
  }

  ui.renderReader = function renderReader() {
    const el = ui.el;
    const c = ui.readerId ? Data.byId.get(ui.readerId) : null;
    el.reader.classList.toggle("idle-state", !c);
    if (!c) {
      put(el.actionsCol);
      put(el.metaCol);
      const key = `idle:${Data.active.length || Data.archived.length ? 1 : 0}`;
      if (ui.readerBody !== key) put(el.scroll, idleLegend());
      ui.readerBody = key;
      return;
    }
    const d = Store.data;
    const mark = d.marks[c.id];
    const prot = Boolean(d.protect[c.id]);
    const conv = cache.get(c.id);

    const actionBtn = (action) => {
      const a = ACTION[action];
      const on = action === "protect" ? prot : Boolean(mark && mark.a === action);
      const label = action === "protect" ? (prot ? "Unprotect" : "Protect") : on ? `Unmark ${a.label}` : a.label;
      return h("button", { class: `btn${on ? " on" : ""}${action === "delete" ? " danger" : ""}`, type: "button", title: `${label} (${a.key})`, onclick: () => applyAction(action, [c]) },
        h("span", { class: "tl" }, label, h("span", { class: "key" }, a.key)));
    };
    const open = TEST.demo
      ? h("button", { class: "btn quiet", type: "button", title: "Open in ChatGPT", onclick: () => ui.toast("In the demo, chats don't open in ChatGPT.") }, h("span", { class: "lbl" }, "Open in ChatGPT"), icon("external", 15))
      : h("a", { class: "btn quiet", href: `/c/${encodeURIComponent(c.id)}`, target: "_blank", rel: "noopener noreferrer", title: "Open in ChatGPT" }, h("span", { class: "lbl" }, "Open in ChatGPT"), icon("external", 15));
    put(el.actionsCol, actionBtn("delete"), c.archived ? actionBtn("unarchive") : actionBtn("archive"), actionBtn("rename"), actionBtn("protect"), h("div", { class: "spacer" }), open);

    let state = null;
    if (prot) state = h("span", { class: "state" }, "Protected");
    else if (mark && mark.a === "rename") state = h("span", { class: "state" }, "Queued: Rename → ", h("span", { class: "v" }, mark.t));
    else if (mark) state = h("span", { class: `state ${mark.a}` }, `Queued: ${ACTION[mark.a].label}${mark.a === "delete" ? " · Can't be undone" : ""}`);
    put(el.metaCol,
      h("span", null, "Created ", num(isoDate(c.created))),
      c.updated ? h("span", null, "Last Used ", num(isoDate(c.updated))) : null,
      conv ? h("span", null, num(conv.messages.length), conv.messages.length === 1 ? " Message" : " Messages") : null,
      c.projectId ? h("span", null, "Project") : null,
      c.gptId ? h("span", null, "Custom GPT") : null,
      c.pinned ? h("span", null, "Pinned") : null,
      c.archived ? h("span", null, "Archived") : null,
      state);

    // Only rebuild the conversation when it's a different chat or it just arrived, so marking doesn't make it jump.
    const rs = ui.reader && ui.reader.id === c.id ? ui.reader : null;
    const bodyKey = conv ? `ok:${c.id}:${c.title}` : rs && rs.status === "error" ? `err:${c.id}:${rs.error && rs.error.kind}` : `load:${c.id}`;
    if (ui.readerBody === bodyKey) return;
    ui.readerBody = bodyKey;
    if (conv) {
      const column = h("div", { class: "col enter" },
        h("h1", { dir: "auto" }, c.title || "Untitled"),
        conv.messages.length
          ? conv.messages.map((m, i) => {
            const msg = h("div", { class: `msg ${m.role}` }, h("div", { class: "who" }, m.role === "user" ? "You" : "ChatGPT"), h("div", { class: "txt", dir: "auto" }, m.text));
            msg.style.animationDelay = `${Math.min(i + 1, 6) * 45}ms`;
            return msg;
          })
          : h("div", { class: "note" }, "This chat has no text messages to show."));
      setTimeout(() => column.classList.remove("enter"), 900);
      put(el.scroll, column);
      el.scroll.scrollTop = 0;
    } else if (rs && rs.status === "error") {
      const e = rs.error || {};
      const text = e.kind === "cooldown" || e.kind === "ratelimit"
        ? `ChatGPT asked Triage to slow down. You can read chats again at ${fmtClock(Store.data.cooldownUntil)}.`
        : e.kind === "notfound" ? "This chat doesn't exist in ChatGPT any more." : `Couldn't load this chat. ${e.message || ""}`;
      put(el.scroll, h("div", { class: "col", style: "display:block" }, h("h1", { dir: "auto" }, c.title || "Untitled"),
        h("div", { class: "note" }, h("div", null, text), e.kind === "notfound" ? null : h("button", { class: "btn", type: "button", onclick: () => openReader(c.id, true) }, "Try Again"))));
    } else {
      put(el.scroll, h("div", { class: "col", style: "display:block" }, h("h1", { dir: "auto" }, c.title || "Untitled"), h("div", { class: "note" }, spinner(), "Loading chat")));
    }
  };

  function renderState() {
    const el = ui.el.state;
    if (!el) return;
    const r = ui.booted ? Store.data.run : null;
    const waiting = () => `Waiting ${clock(Api.cooldownLeft())}`;
    let cls = "ready";
    let text = "Ready";
    if (ui.fatal) {
      cls = "bad";
      text = "Error";
    } else if (Data.loading) {
      cls = Data.loading.waiting ? "wait" : "busy";
      text = Data.loading.waiting ? waiting() : `Loading ${Data.loading.n}${Data.loading.total ? `/${Data.loading.total}` : ""}`;
    } else if (r && ACTIVE.includes(r.status)) {
      cls = r.status === "waiting" ? "wait" : "busy";
      text = { waiting: waiting(), backup: "Backing Up", verifying: "Checking" }[r.status] || `Running ${r.i}/${r.jobs.length}`;
    } else if (r && r.status === "paused") {
      cls = "hold";
      text = "Paused";
    } else if (Api.cooldownLeft() > 0) {
      cls = "wait";
      text = waiting();
    }
    el.className = `state ${cls}`;
    put(el, h("span", { class: "dot" }), text);
  }

  ui.renderStatus = function renderStatus() {
    if (!ui.el.status) return;
    renderState();
    const d = Store.data;
    const bits = [];
    if (Data.active.length || Data.archived.length) {
      bits.push(`${ui.order.length} Shown`);
      bits.push(`${Object.keys(d.seen).filter((id) => Data.byId.has(id)).length} Read`);
      const prot = Object.keys(d.protect).length;
      if (prot) bits.push(`${prot} Protected`);
    }
    const last = activity[activity.length - 1];
    if (last) bits.push(last.message);
    ui.el.status.textContent = bits.join("  ·  ");
  };

  ui.renderLauncher = function renderLauncher() {
    if (!ui.launcher) return;
    const r = ui.booted ? Store.data.run : null;
    let info = null;
    let dot = "";
    if (r && ACTIVE.includes(r.status)) {
      dot = r.status === "waiting" ? "wait live" : "go live";
      info = r.status === "waiting" ? `Wait ${clock(Api.cooldownLeft())}` : `${r.i}/${r.jobs.length}`;
    } else if (r && r.status === "paused") {
      dot = "wait";
      info = "Paused";
    } else if (r) {
      dot = "ok";
      info = "Done";
    }
    put(ui.launcher, h("span", { class: `dot ${dot}` }), "Triage", info ? h("span", { class: "info" }, info) : null);
  };

  ui.renderDrawer = function renderDrawer() {
    const el = ui.el;
    el.drawerEl.hidden = !ui.drawer;
    el.activityBtn.classList.toggle("on", ui.drawer === "activity");
    el.networkBtn.classList.toggle("on", ui.drawer === "network");
    if (!ui.drawer) return;
    const time = (t) => new Date(t).toLocaleTimeString([], { hour12: false });
    let lines;
    if (ui.drawer === "network") {
      lines = [h("div", { class: "head" }, "Every request Triage has sent. They all go to chatgpt.com. Your sign-in token is never shown or stored.")];
      for (const x of Api.log.slice(-200)) {
        const cls = x.status === 429 ? "s429" : typeof x.status !== "number" || x.status >= 400 ? "sbad" : "";
        lines.push(h("div", { class: cls }, `${time(x.at)}  ${x.method.padEnd(5)} ${x.status}  ${x.path}${x.ms ? `  ${x.ms}ms` : ""}`));
      }
    } else {
      lines = [h("div", { class: "head" }, "What Triage has done in this tab.")];
      for (const x of activity.slice(-200)) lines.push(h("div", null, `${time(x.at)}  ${x.message}`));
    }
    put(el.drawerEl, lines);
    el.drawerEl.scrollTop = el.drawerEl.scrollHeight;
  };

  function toggleDrawer(which) {
    ui.drawer = ui.drawer === which ? null : which;
    ui.renderDrawer();
  }

  // The card that covers the workspace while the queue runs.
  // The run card is built once per run and then updated in place, so nothing
  // flickers between changes. Its log is a wheel, like the picker in Apple's
  // Clock app: the current chat sits in the middle, finished ones roll away
  // above, the next ones wait below. Scroll, drag or use the arrow keys on it
  // to look back.
  const WHEEL = { row: 36, radius: 160, reach: 8 };
  WHEEL.step = (2 * Math.atan(WHEEL.row / 2 / WHEEL.radius) * 180) / Math.PI;
  const setText = (node, text) => {
    if (node.textContent !== text) node.textContent = text;
  };

  ui.renderRun = function renderRun() {
    const el = ui.el;
    if (!el.runLayer) return;
    const r = ui.booted ? Store.data.run : null;
    const busy = Boolean(r);
    el.runLayer.hidden = !busy;
    el.left.inert = busy;
    el.reader.inert = busy;
    el.tabs.inert = busy;
    if (!r) {
      ui.runSig = "";
      ui.rv = null;
      return;
    }
    if (ui.lockedElsewhere) {
      if (ui.runSig !== "elsewhere") {
        ui.runSig = "elsewhere";
        ui.rv = null;
        put(el.runLayer, h("div", { class: "card" },
          h("div", { class: "head" }, h("div", { class: "state hold" }, h("i"), "Busy in Another Tab")),
          h("div", { class: "bar" }, h("i")),
          h("div", { class: "explain" }, "Triage is working through a queue in another ChatGPT tab. Only one tab can run the queue at a time."),
          h("div", { class: "btns" }, h("button", { class: "btn primary", type: "button", onclick: recheckOtherTab }, "Check Again"))));
      }
      return;
    }
    if (!ui.rv || ui.rv.run !== r) buildRunCard(r);
    updateRunCard(r);
  };

  function buildRunCard(r) {
    const v = { run: r, items: new Map(), shown: -1, browse: null, browseAt: 0, btnSig: "", said: r.results.length, label: "", sawIssue: false };
    v.labelEl = h("span");
    v.state = h("div", { class: "state" }, h("i"), v.labelEl);
    v.doneEl = h("b");
    v.totalEl = h("span");
    v.bar = h("i");
    v.big = h("div", { class: "big" });
    v.fold = h("div", { class: "fold" }, h("div", null, v.big));
    v.say = h("div", { class: "say" });
    v.drum = h("div", { class: "drum instant" });
    v.wheel = h("div", { class: "wheel", tabindex: "0", role: "group", "aria-label": "This run, one chat per row. Use the arrow keys to look back." }, v.drum);
    v.why = h("div", { class: "why" });
    v.btns = h("div", { class: "btns" });
    v.tip = h("div", { class: "tip" }, "Keep this tab open. You can close this panel and keep using ChatGPT; the button in the corner shows progress. Other ChatGPT tabs and the desktop app share the same limit, so close them if you can.");
    v.live = h("div", { class: "sr", role: "status", "aria-live": "polite" });
    v.card = h("div", { class: "card" },
      h("div", { class: "head" }, v.state, h("div", { class: "frac" }, v.doneEl, v.totalEl)),
      h("div", { class: "bar" }, v.bar),
      v.fold, v.say, v.wheel, v.why, v.btns, v.tip, v.live);
    wireWheel(v);
    ui.rv = v;
    ui.runSig = "card";
    put(ui.el.runLayer, v.card);
  }

  function wireWheel(v) {
    const go = (to) => {
      const max = v.run.jobs.length - 1;
      v.browse = clamp(Math.round(to), 0, max);
      v.browseAt = now();
      updateRunCard(v.run);
    };
    const at = () => (v.browse == null ? v.shown : v.browse);
    let acc = 0;
    v.wheel.addEventListener("wheel", (e) => {
      e.preventDefault();
      acc += e.deltaMode === 1 ? e.deltaY * WHEEL.row : e.deltaY;
      const steps = Math.trunc(acc / 40);
      if (!steps) return;
      acc -= steps * 40;
      go(at() + steps);
    }, { passive: false });
    v.wheel.addEventListener("keydown", (e) => {
      const to = { ArrowUp: at() - 1, ArrowDown: at() + 1, PageUp: at() - 5, PageDown: at() + 5, Home: 0, End: v.run.jobs.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      go(to);
    });
    v.wheel.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const startY = e.clientY;
      const from = at();
      v.wheel.setPointerCapture(e.pointerId);
      v.wheel.classList.add("dragging");
      const moveTo = (ev) => go(from + (startY - ev.clientY) / WHEEL.row);
      const end = () => {
        v.wheel.classList.remove("dragging");
        v.wheel.removeEventListener("pointermove", moveTo);
      };
      v.wheel.addEventListener("pointermove", moveTo);
      v.wheel.addEventListener("pointerup", end, { once: true });
      v.wheel.addEventListener("pointercancel", end, { once: true });
    });
  }

  function updateRunCard(r) {
    const v = ui.rv;
    const total = r.jobs.length;
    const results = new Map(r.results.map((x) => [x.id, x]));
    const done = r.results.filter((x) => x.status === "done").length;
    const failed = r.results.filter((x) => x.status === "failed").length;
    const unconfirmed = r.results.filter((x) => x.status === "unconfirmed").length;
    const live = ACTIVE.includes(r.status);
    const finished = r.status === "done" || r.status === "stopped";
    const trouble = failed || unconfirmed;
    const [label, light] = {
      backup: ["Backing Up", "go"], running: ["Running", "go"], waiting: ["Waiting", "wait"], verifying: ["Checking", "go"],
      paused: ["Paused", "hold"], done: trouble ? ["Done, Needs a Look", "bad"] : ["Done", "ok"], stopped: ["Stopped", "hold"],
    }[r.status] || ["Queue", ""];

    setText(v.labelEl, label);
    const stateCls = `state ${light}`;
    if (v.state.className !== stateCls) v.state.className = stateCls;
    setText(v.doneEl, String(r.i));
    setText(v.totalEl, ` / ${total}`);
    v.bar.style.width = `${total ? Math.round((r.i / total) * 100) : 0}%`;

    const waiting = r.status === "waiting";
    v.fold.classList.toggle("open", waiting);
    if (waiting) setText(v.big, clock(Api.cooldownLeft()));

    let say = "";
    if (waiting) say = `ChatGPT asked Triage to slow down. It carries on by itself at ${fmtClock(Store.data.cooldownUntil)}.`;
    else if (r.status === "backup") say = r.note;
    else if (r.status === "verifying") say = r.note || "Double-checking with ChatGPT.";
    else if (r.status === "running") {
      const gap = Store.data.settings.gap;
      say = r.note || `One change every ${paceHere(gap)}${paceNote(gap)}. ${timeLeft((total - r.i) * gap * SCALE)} to go.`;
    } else if (r.status === "paused") say = r.note || "Nothing else changes until you resume.";
    else if (finished) {
      const bits = [`${plural(done, "change")} made`];
      if (failed) bits.push(`${failed} failed`);
      if (unconfirmed) bits.push(`${unconfirmed} didn't stick and ${unconfirmed === 1 ? "is" : "are"} marked again`);
      if (r.status === "stopped" && r.i < total) bits.push(`${total - r.i} not reached, still marked`);
      say = `${bits.join(". ")}.`;
    }
    setText(v.say, say);

    // Which row sits in the middle: the current chat, unless someone is looking back.
    if (v.browse != null && live && now() - v.browseAt > 6 * SEC) v.browse = null;
    if (finished && trouble && !v.sawIssue) {
      v.sawIssue = true;
      const first = r.jobs.findIndex((j) => results.has(j.id) && results.get(j.id).status !== "done");
      if (first >= 0) v.browse = first;
    }
    const c = v.browse != null ? v.browse : clamp(r.i, 0, total - 1);
    renderWheel(v, r, results, c);
    const mid = r.jobs[c] && results.get(r.jobs[c].id);
    let why = "";
    if (mid && mid.status !== "done" && mid.note) why = mid.note;
    else if (v.browse != null && live) why = "Looking back. It returns to the current chat in a moment.";
    setText(v.why, why);

    const btnSig = live ? "live" : r.status === "paused" ? `paused:${ui.lockedElsewhere}` : `end:${Runner.backup.length}`;
    if (btnSig !== v.btnSig) {
      v.btnSig = btnSig;
      const btns = [];
      if (live) {
        btns.push(h("button", { class: "btn primary", type: "button", onclick: () => Runner.pause() }, "Pause"));
        btns.push(h("button", { class: "btn quiet", type: "button", onclick: () => Runner.stop() }, "Stop"));
      } else if (r.status === "paused") {
        btns.push(h("button", { class: "btn primary", type: "button", disabled: ui.lockedElsewhere, onclick: () => Runner.resume() }, "Resume"));
        btns.push(h("button", { class: "btn quiet", type: "button", onclick: () => Runner.stop() }, "Stop"));
      } else {
        btns.push(h("button", { class: "btn primary", type: "button", onclick: () => Runner.dismiss() }, "Close"));
        btns.push(h("button", { class: "btn quiet", type: "button", onclick: downloadReport }, "Download Report"));
        if (Runner.backup.length) btns.push(h("button", { class: "btn quiet", type: "button", onclick: () => download(`chatgpt-triage-backup-${fileStamp()}.json`, JSON.stringify(Runner.backup, null, 2), "application/json") }, "Download Backup"));
      }
      put(v.btns, btns);
    }
    v.tip.hidden = !live;

    // Screen readers hear each finished chat and each change of state, once.
    if (r.results.length > v.said) {
      const x = r.results[r.results.length - 1];
      v.said = r.results.length;
      v.live.textContent = `${x.status === "failed" ? "Failed" : ACTION[x.action].past}: ${x.title || "Untitled"}. ${r.i} of ${total}.`;
    } else if (label !== v.label) {
      v.live.textContent = `${label}. ${say}`;
    }
    v.label = label;
  }

  function renderWheel(v, r, results, c) {
    const lo = Math.max(0, c - WHEEL.reach);
    const hi = Math.min(r.jobs.length - 1, c + WHEEL.reach);
    for (const [i, node] of v.items) {
      if (i < lo || i > hi) {
        node.remove();
        v.items.delete(i);
      }
    }
    for (let i = lo; i <= hi; i += 1) {
      let node = v.items.get(i);
      if (!node) {
        node = h("div", { class: "wi" }, h("span", { class: "g" }), h("span", { class: "v" }), h("span", { class: "ttl", dir: "auto" }));
        node.style.transform = `rotateX(${-i * WHEEL.step}deg) translateZ(${WHEEL.radius}px)`;
        v.items.set(i, node);
        v.drum.append(node);
      }
      paintWheelRow(node, r, i, results, i === c);
    }
    if (v.shown !== c) {
      v.shown = c;
      v.drum.style.transform = `translateZ(${-WHEEL.radius}px) rotateX(${c * WHEEL.step}deg)`;
    }
    if (v.drum.classList.contains("instant")) requestAnimationFrame(() => requestAnimationFrame(() => v.drum.classList.remove("instant")));
  }

  function paintWheelRow(node, r, i, results, mid) {
    const job = r.jobs[i];
    const a = ACTION[job.action];
    const x = results.get(job.id);
    let kind = "todo";
    let glyph = "";
    let verb = a.label;
    if (x) {
      kind = x.status === "failed" ? "bad" : x.status === "unconfirmed" ? "unsure" : "ok";
      glyph = { done: "✓", failed: "✕", unconfirmed: "~" }[x.status] || "·";
      verb = x.status === "failed" ? "Failed" : x.status === "unconfirmed" ? "Check" : x.note === "It was already gone." ? "Gone" : a.past;
    } else if (i === r.i && r.status === "running") {
      kind = "now";
      if (r.nextAt) verb = `In ${Math.max(0, Math.ceil((r.nextAt - now()) / SEC))}s`;
      else {
        verb = a.verb;
        glyph = "spin";
      }
    } else if (i === r.i && r.status === "waiting") {
      kind = "now";
      verb = "Waiting";
    }
    const cls = `wi ${kind}${mid ? " mid" : ""}`;
    if (node.className !== cls) node.className = cls;
    const [g, vb, ttl] = node.children;
    if (g.dataset.g !== glyph) {
      g.dataset.g = glyph;
      put(g, glyph === "spin" ? spinner() : glyph);
    }
    setText(vb, verb);
    setText(ttl, `${job.title || "Untitled"}${job.action === "rename" && job.newTitle ? ` → ${job.newTitle}` : ""}`);
  }

  // ---------------------------------------------------------------------------
  // Actions from the list, reader and keyboard
  // ---------------------------------------------------------------------------

  function selectedChats() {
    return [...ui.sel].map((id) => Data.byId.get(id)).filter(Boolean);
  }

  function applyAction(action, targets, { advance = false } = {}) {
    if (Runner.isActive() || Store.data.run || !targets.length) return;
    const d = Store.data;
    if (action === "protect") {
      const turnOn = targets.some((c) => !d.protect[c.id]);
      for (const c of targets) {
        if (turnOn) {
          d.protect[c.id] = { title: c.title, at: now() };
          delete d.marks[c.id];
          ui.sel.delete(c.id);
          ui.fresh.add(c.id);
        } else {
          delete d.protect[c.id];
        }
      }
      Store.save();
      ui.toast(turnOn ? `Protected ${plural(targets.length, "chat")}. Triage won't change ${targets.length === 1 ? "it" : "them"}.` : `Unprotected ${plural(targets.length, "chat")}.`);
      ui.renderAll();
      if (advance && targets.length === 1 && turnOn) move(1);
      return;
    }
    if (action === "clear") {
      for (const c of targets) delete d.marks[c.id];
      Store.save();
      ui.renderAll();
      return;
    }
    if (action === "rename") {
      if (targets.length !== 1) {
        ui.toast("Rename one chat at a time.");
        return;
      }
      const why = whyNot(targets[0], "rename");
      if (why) ui.toast(why);
      else openRename(targets[0]);
      return;
    }
    if (targets.length === 1 && d.marks[targets[0].id] && d.marks[targets[0].id].a === action) {
      delete d.marks[targets[0].id];
      Store.save();
      ui.renderAll();
      return;
    }
    let applied = 0;
    let blocked = null;
    for (const c of targets) {
      const why = whyNot(c, action);
      if (why) {
        blocked = why;
        continue;
      }
      d.marks[c.id] = { a: action, title: c.title, at: now() };
      ui.fresh.add(c.id);
      applied += 1;
    }
    Store.save();
    if (targets.length > 1) {
      ui.sel.clear();
      ui.toast(applied
        ? `Queued ${plural(applied, "chat")} to ${ACTION[action].label.toLowerCase()}.${blocked ? ` ${targets.length - applied} skipped.` : ""}`
        : blocked);
    } else if (blocked) {
      ui.toast(blocked);
    }
    ui.renderAll();
    if (advance && applied && targets.length === 1) move(1);
  }

  function invertSelection() {
    for (const id of ui.order) {
      const c = Data.byId.get(id);
      if (!c || !selectable(c)) continue;
      if (ui.sel.has(id)) ui.sel.delete(id);
      else ui.sel.add(id);
    }
    ui.renderList();
  }

  function toggleSelect(id, range) {
    const c = Data.byId.get(id);
    if (!c || Store.data.protect[id]) return;
    if (range && ui.anchor && ui.order.includes(ui.anchor)) {
      const a = ui.order.indexOf(ui.anchor);
      const b = ui.order.indexOf(id);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      const on = !ui.sel.has(id) || ui.sel.has(ui.anchor);
      for (let i = lo; i <= hi; i += 1) {
        const x = Data.byId.get(ui.order[i]);
        if (!x || Store.data.protect[x.id]) continue;
        if (on) ui.sel.add(x.id);
        else ui.sel.delete(x.id);
      }
    } else {
      if (ui.sel.has(id)) ui.sel.delete(id);
      else ui.sel.add(id);
      ui.anchor = id;
    }
    ui.renderList();
  }

  function clearFilters() {
    Object.assign(ui.filters, { q: "", age: 0, unread: false, untitled: false, marked: false });
    ui.el.search.value = "";
    closeMenu();
    renderFilterButton();
    ui.renderList();
  }

  function onListClick(e) {
    const row = e.target.closest(".row");
    if (!row) return;
    const id = row.dataset.id;
    const c = Data.byId.get(id);
    if (!c) return;
    const act = e.target.closest("[data-act]");
    if (act) {
      e.stopPropagation();
      setFocus(id, false);
      applyAction(act.dataset.act, [c]);
      return;
    }
    if (e.target.closest(".cb, .gut")) {
      toggleSelect(id, e.shiftKey);
      return;
    }
    if (e.shiftKey) {
      toggleSelect(id, true);
      return;
    }
    ui.anchor = id;
    setFocus(id, false);
    openReader(id, true);
  }

  function setFocus(id, scroll = true) {
    ui.focusId = id;
    const i = id ? ui.indexOf.get(id) : undefined;
    if (scroll && i !== undefined) scrollToRow(i);
    // Redraws the old and new highlighted rows, and makes sure the new one is on the page.
    renderWindow();
    const row = id && ui.rowEls.get(id);
    // Screen readers follow the highlighted row while focus stays on the list.
    if (row) ui.el.list.setAttribute("aria-activedescendant", row.id);
    else ui.el.list.removeAttribute("aria-activedescendant");
    placeCursor(true);
  }

  // Scrolls just enough to show a row, like scrollIntoView({ block: "nearest" }) on a row that may not exist yet.
  function scrollToRow(i) {
    const list = ui.el.list;
    const top = ui.el.rows.offsetTop + i * ROW_H;
    if (top - 6 < list.scrollTop) list.scrollTop = top - 6;
    else if (top + ROW_H + 6 > list.scrollTop + list.clientHeight) list.scrollTop = top + ROW_H + 6 - list.clientHeight;
  }

  function move(delta, extend) {
    if (!ui.order.length) return;
    let i = ui.focusId ? ui.order.indexOf(ui.focusId) : -1;
    i = i < 0 ? (delta > 0 ? 0 : ui.order.length - 1) : clamp(i + delta, 0, ui.order.length - 1);
    const id = ui.order[i];
    if (extend) {
      if (ui.focusId && !Store.data.protect[ui.focusId]) ui.sel.add(ui.focusId);
      if (!Store.data.protect[id]) ui.sel.add(id);
      ui.focusId = id;
      ui.renderList();
      setFocus(id);
      return;
    }
    setFocus(id);
    openReader(id, false);
  }

  function openReader(id, immediate) {
    ui.readerId = id;
    clearTimeout(ui.previewTimer);
    if (cache.has(id)) {
      markSeen(id);
      ui.reader = { id, status: "ok" };
      ui.renderReader();
      return;
    }
    ui.reader = { id, status: "loading" };
    ui.renderReader();
    ui.previewTimer = setTimeout(() => fetchReader(id), immediate ? 0 : CFG.previewDelay);
  }

  async function fetchReader(id) {
    if (ui.readerId !== id) return;
    try {
      await getConversation(id);
      if (ui.readerId !== id) return;
      markSeen(id);
      ui.reader = { id, status: "ok" };
    } catch (e) {
      if (ui.readerId !== id) return;
      ui.reader = { id, status: "error", error: e };
    }
    ui.renderReader();
  }

  function markSeen(id) {
    if (Store.data.seen[id]) return;
    Store.data.seen[id] = 1;
    Store.save();
    const row = ui.rowEls.get(id);
    if (row) {
      row.classList.add("seen");
      const dot = row.querySelector(".dot");
      if (dot) dot.remove();
    }
    ui.renderStatus();
  }

  function isTyping(e) {
    const t = e.composedPath()[0];
    if (!t || !t.tagName) return false;
    const tag = t.tagName.toLowerCase();
    return tag === "textarea" || tag === "select" || t.isContentEditable || (tag === "input" && !["checkbox", "radio", "button"].includes(t.type));
  }

  function onKey(e) {
    if (ui.menu && e.key === "Escape") {
      e.preventDefault();
      closeMenu();
      return;
    }
    if (ui.modal) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeModal();
      } else if (e.key === "Enter" && isTyping(e) && e.composedPath()[0].tagName.toLowerCase() === "input") {
        const primary = ui.modal.querySelector(".mfoot .btn.primary");
        if (primary && !primary.disabled) {
          e.preventDefault();
          primary.click();
        }
      }
      return;
    }
    if (!ui.isOpen) return;
    if (isTyping(e)) {
      const t = e.composedPath()[0];
      if (e.key === "Escape" || (e.key === "Enter" && t === ui.el.search) || (e.key === "ArrowDown" && t === ui.el.search)) {
        e.preventDefault();
        ui.el.list.focus({ preventScroll: true });
        if (e.key === "ArrowDown") move(1);
      }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (Store.data.run) {
      if (e.key === "Escape") ui.close();
      return;
    }
    const focused = ui.focusId ? Data.byId.get(ui.focusId) : null;
    const targets = () => (ui.sel.size ? selectedChats() : focused ? [focused] : []);
    const single = () => ui.sel.size === 0;
    const handled = () => e.preventDefault();
    switch (e.key) {
      case "ArrowDown":
      case "j":
        handled();
        move(1, e.shiftKey);
        break;
      case "ArrowUp":
      case "k":
        handled();
        move(-1, e.shiftKey);
        break;
      case "J":
        handled();
        move(1, true);
        break;
      case "K":
        handled();
        move(-1, true);
        break;
      case "Home":
        handled();
        if (ui.order.length) move(-ui.order.length);
        break;
      case "End":
        handled();
        if (ui.order.length) move(ui.order.length);
        break;
      case "PageDown":
        handled();
        move(12);
        break;
      case "PageUp":
        handled();
        move(-12);
        break;
      case "Enter":
      case "o":
        handled();
        if (focused) openReader(focused.id, true);
        break;
      case " ":
      case "x":
        handled();
        if (focused) toggleSelect(focused.id, e.shiftKey);
        break;
      case "d":
        handled();
        applyAction("delete", targets(), { advance: single() });
        break;
      case "a":
        handled();
        applyAction(focused && focused.archived && single() ? "unarchive" : "archive", targets(), { advance: single() });
        break;
      case "u":
        handled();
        applyAction("unarchive", targets(), { advance: single() });
        break;
      case "r":
        handled();
        applyAction("rename", targets());
        break;
      case "p":
        handled();
        applyAction("protect", targets(), { advance: single() });
        break;
      case "c":
        handled();
        applyAction("clear", targets());
        break;
      case "/":
        handled();
        ui.el.search.focus();
        ui.el.search.select();
        break;
      case "?":
        handled();
        openHelp();
        break;
      case "Escape":
        handled();
        if (ui.sel.size) {
          ui.sel.clear();
          ui.renderList();
        }
        break;
      default:
    }
  }

  // Alt+Shift+T opens and closes Triage from anywhere on chatgpt.com.
  window.addEventListener("keydown", (e) => {
    if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === "KeyT") {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (ui.isOpen) ui.close();
      else ui.open();
      return;
    }
    // If focus drifted out of Triage (for example onto the page body), keep keys inside Triage.
    if (ui.isOpen && !ui.modal && e.target !== ui.host && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.stopImmediatePropagation();
      ui.el.list.focus({ preventScroll: true });
      onKey(e);
    }
  }, true);

  // ---------------------------------------------------------------------------
  // Dialogs
  // ---------------------------------------------------------------------------

  function modal(title, body, buttons, { onClose } = {}) {
    closeModal();
    closeMenu();
    const wrap = h("div", { class: "modal-wrap" });
    wrap.addEventListener("mousedown", (e) => {
      if (e.target === wrap) closeModal();
    });
    const foot = h("div", { class: "mfoot" }, buttons.map(([label, kind, fn]) => h("button", {
      class: `btn ${kind || "quiet"}`, type: "button",
      onclick: async () => {
        const keepOpen = fn ? await fn() : false;
        if (keepOpen !== true) closeModal();
      },
    }, label)));
    const box = h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": title }, h("h2", null, title), body, foot);
    wrap.append(box);
    ui.root.append(wrap);
    ui.modal = wrap;
    ui.modalClose = onClose || null;
    const first = box.querySelector("input[type=text], input[type=number]") || box.querySelector(".mfoot .btn.primary") || box.querySelector("button");
    if (first) first.focus();
    return box;
  }

  function closeModal() {
    if (!ui.modal) return;
    const wrap = ui.modal;
    ui.modal = null;
    wrap.classList.add("leaving");
    setTimeout(() => wrap.remove(), 150);
    const cb = ui.modalClose;
    ui.modalClose = null;
    if (cb) cb();
    if (ui.isOpen) ui.el.list.focus({ preventScroll: true });
  }

  function openRename(c) {
    const mark = Store.data.marks[c.id];
    const input = h("input", { type: "text", "aria-label": "New name", maxlength: "200" });
    input.value = mark && mark.a === "rename" ? mark.t : c.title;
    modal("Rename Chat", [
      h("div", { class: "lbl", style: "margin-top:0" }, "Now"),
      h("p", null, c.title || "Untitled"),
      h("div", { class: "lbl" }, "New Name"),
      input,
      h("p", { class: "hint", style: "margin-top:12px" }, "The new name is queued. ChatGPT only changes when you run the queue."),
    ], [
      ["Cancel"],
      ["Queue Rename", "primary", () => {
        const t = input.value.trim();
        if (!t || t === c.title) delete Store.data.marks[c.id];
        else {
          Store.data.marks[c.id] = { a: "rename", title: c.title, t, at: now() };
          ui.fresh.add(c.id);
        }
        Store.save();
        ui.renderAll();
      }],
    ]);
    input.select();
  }

  function confirmRun() {
    if (Runner.isActive() || Store.data.run) return;
    if (Api.cooldownLeft() > 0) {
      ui.toast(`ChatGPT asked Triage to slow down. Try again at ${fmtClock(Store.data.cooldownUntil)}.`);
      return;
    }
    const jobs = Runner.buildJobs();
    if (!jobs.length) return;
    const n = { delete: 0, archive: 0, unarchive: 0, rename: 0 };
    for (const j of jobs) n[j.action] += 1;
    const gap = Store.data.settings.gap;
    const rows = ["delete", "archive", "unarchive", "rename"].filter((a) => n[a]).map((a) => h("div", { class: a === "delete" ? "del" : "" },
      h("span", null, ACTION[a].label, a === "delete" ? h("span", { class: "x" }, "Permanent · ChatGPT can't restore deleted chats") : null),
      h("span", { class: "n" }, String(n[a]))));
    // Counts alone can't catch the wrong chat, so the dialog lists them. Deletes can't be undone, so they come first and open.
    const review = h("details", { class: "review" },
      h("summary", null, icon("chevron", 14), `Review the ${plural(jobs.length, "chat")}`),
      h("div", { class: "items" }, ["delete", "archive", "unarchive", "rename"].filter((a) => n[a]).map((a) => {
        const group = jobs.filter((j) => j.action === a);
        const item = (j) => {
          const c = Data.byId.get(j.id);
          const name = `${j.title || "Untitled"}${a === "rename" ? ` → ${j.newTitle}` : ""}`;
          return h("div", { class: "it" }, h("span", { class: "d" }, isoDate(c && c.created)), h("span", { class: "t", dir: "auto", title: name }, name));
        };
        // Thousands of names would slow the dialog down, so long groups show 100 until asked.
        const box = h("div", null, group.slice(0, 100).map(item));
        if (group.length > 100) {
          const more = h("button", {
            class: "btn quiet all", type: "button",
            onclick: () => {
              more.remove();
              box.append(...group.slice(100).map(item));
            },
          }, `Show All ${group.length}`);
          box.append(more);
        }
        return [h("div", { class: `grp${a === "delete" ? " del" : ""}` }, `${ACTION[a].label} · ${n[a]}`), box];
      })));
    review.open = n.delete > 0;
    const backup = h("input", { type: "checkbox" });
    backup.checked = Store.data.settings.backup;
    const typed = h("input", { type: "text", placeholder: String(n.delete), "aria-label": "Type the number of chats to delete" });
    const body = [
      h("div", { class: "table" }, rows),
      review,
      h("div", { class: "eta" }, "One change every ", h("span", { class: "num" }, paceHere(gap)), paceNote(gap), ` · ${timeLeft(jobs.length * gap * SCALE)}`),
      h("p", { class: "hint" }, "If ChatGPT says \"too many requests\", Triage waits as long as it asks and carries on by itself."),
    ];
    if (n.delete) body.push(check(backup, `Back up the ${plural(n.delete, "chat")} being deleted first`, "Saves one Markdown file before anything is deleted."));
    if (n.delete >= CFG.typeToConfirm) body.push(h("div", { class: "lbl" }, `Type ${n.delete} to Confirm`), typed);
    body.push(h("p", { class: "hint", style: "margin-top:16px" }, "Close other ChatGPT tabs and the desktop app while this runs. They share the same limit."));
    const box = modal("Run the Queue?", body, [
      ["Cancel"],
      [`Run ${jobs.length} ${jobs.length === 1 ? "Change" : "Changes"}`, "primary", () => {
        Store.data.settings.backup = backup.checked;
        Store.save();
        Runner.start({ backup: backup.checked });
        ui.renderAll();
      }],
    ]);
    if (n.delete >= CFG.typeToConfirm) {
      const run = box.querySelector(".mfoot .btn.primary");
      run.disabled = true;
      typed.addEventListener("input", () => {
        run.disabled = typed.value.trim() !== String(n.delete);
      });
      typed.focus();
    }
  }

  function themeSeg() {
    const current = themePref();
    const seg = h("div", { class: "seg", role: "group", "aria-label": "Theme" });
    for (const [value, label] of [["auto", "Match ChatGPT"], ["light", "Light"], ["dark", "Dark"]]) {
      seg.append(h("button", {
        class: current === value ? "on" : "", type: "button",
        onclick: (e) => {
          const b = e.currentTarget;
          for (const x of seg.children) x.classList.toggle("on", x === b);
          setThemePref(value, b);
        },
      }, label));
    }
    return seg;
  }

  function openSettings() {
    const s = Store.data.settings;
    const gap = h("input", { type: "number", min: String(CFG.gapMin), max: String(CFG.gapMax), step: "1", "aria-label": "Seconds between changes" });
    gap.value = String(s.gap);
    const backup = h("input", { type: "checkbox" });
    backup.checked = s.backup;
    const pinned = h("input", { type: "checkbox" });
    pinned.checked = s.pinnedInSelectAll;
    const small = (label, fn) => h("button", { class: "btn quiet", type: "button", onclick: fn }, label);
    modal("Settings", [
      h("div", { class: "lbl", style: "margin-top:0" }, "Pace"),
      h("div", { class: "inline" }, h("span", null, "Wait"), gap, h("span", null, "seconds between changes")),
      h("p", { class: "hint", style: "margin-top:10px" }, `Slower is safer. Minimum ${CFG.gapMin}, default ${CFG.gapDefault}. After a "too many requests", Triage also waits however long ChatGPT asks.${SCALE === 1 ? "" : ` In this demo, every wait runs ${SPEEDUP}× faster.`}`),
      h("div", { class: "lbl" }, "Appearance"),
      themeSeg(),
      h("div", { class: "lbl" }, "Safety"),
      check(backup, "Back up chats before deleting them", "Saves a Markdown file of the chats in the delete queue before anything is deleted."),
      check(pinned, "Include pinned chats in Select All", "Off by default, so select all never picks up pinned chats."),
      h("div", { class: "lbl" }, "Data"),
      h("div", { class: "stack" },
        small("Download Chat List (CSV)", exportList),
        small("Clear All Marks", () => resetState("marks", "Clear every queued change?")),
        small("Forget What I've Read", () => resetState("seen", "Mark every chat as unread again?")),
        small("Unprotect Everything", () => resetState("protect", "Remove protection from every chat?"))),
      h("p", { class: "hint", style: "margin:18px 0 0" }, `Triage ${VERSION}`),
    ], [
      ["Cancel"],
      ["Save", "primary", () => {
        s.gap = clamp(Math.round(Number(gap.value)) || CFG.gapDefault, CFG.gapMin, CFG.gapMax);
        s.backup = backup.checked;
        s.pinnedInSelectAll = pinned.checked;
        Store.save();
        ui.renderAll();
      }],
    ]);
  }

  function resetState(key, question) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(question)) return;
    Store.data[key] = {};
    Store.save();
    closeModal();
    ui.renderAll();
    ui.toast("Done.");
  }

  function openHelp() {
    const keys = [
      ["↑ ↓", "Move; the chat opens on the right"],
      ["J K", "Move, the Vim way"],
      ["Shift ↑ ↓", "Select while moving"],
      ["Space", "Select or unselect"],
      ["D", "Queue delete, then go to the next chat"],
      ["A", "Queue archive (unarchive in Archived)"],
      ["R", "Queue a new name"],
      ["P", "Protect, so it's never touched"],
      ["C", "Clear the queued change"],
      ["/", "Search"],
      ["Esc", "Clear the selection"],
      ["Alt Shift T", "Open or close Triage"],
    ];
    modal("Shortcuts and How It Works", [
      h("p", null, "Read your chats, mark what should happen to each one, then run the queue. ChatGPT doesn't change until you do, and your marks are saved in this browser."),
      h("div", { class: "lbl" }, "Keys"),
      h("div", { class: "keys" }, keys.map(([k, d]) => [h("span", { class: "k" }, k), h("span", { class: "d" }, d)])),
      h("div", { class: "lbl" }, "The Limit"),
      h("p", null, "One change at a time, with a pause between each. If ChatGPT says \"too many requests\", Triage stops every request, waits as long as ChatGPT asks (longer each time if it doesn't say), then carries on with the same chat."),
      h("div", { class: "lbl" }, "Safety"),
      h("p", null, "Project and pinned chats stay out of Main and select all. Deletes can be backed up first, and big deletes ask you to type the number. At the end, Triage reloads your list to check the changes stuck."),
      h("div", { class: "lbl" }, "Privacy"),
      h("p", null, "Triage runs in your browser and only talks to chatgpt.com. The Network button shows every request it sends."),
      h("p", { class: "hint" }, `Triage ${VERSION} · `, h("a", { href: HOMEPAGE, target: "_blank", rel: "noopener noreferrer", style: "text-decoration:underline" }, "Source on GitHub"), " · Not affiliated with OpenAI"),
    ], [["Close", "primary"]]);
  }

  function exportList() {
    const d = Store.data;
    const rows = [["id", "title", "created", "last_used", "where", "archived", "pinned", "queued", "new_title", "protected", "read"]];
    for (const c of [...Data.active, ...Data.archived]) {
      const m = d.marks[c.id];
      rows.push([c.id, c.title, c.created ? new Date(c.created).toISOString() : "", c.updated ? new Date(c.updated).toISOString() : "",
        c.projectId ? "project" : c.gptId ? "custom GPT" : "main", c.archived ? "yes" : "", c.pinned ? "yes" : "",
        m ? m.a : "", m && m.t ? m.t : "", d.protect[c.id] ? "yes" : "", d.seen[c.id] ? "yes" : ""]);
    }
    download(`chatgpt-chat-list-${fileStamp()}.csv`, csv(rows), "text/csv");
  }

  function downloadReport() {
    const r = Store.data.run;
    if (!r) return;
    const rows = [["id", "title", "action", "new_title", "result", "note", "time"]];
    for (const x of r.results) rows.push([x.id, x.title, x.action, x.newTitle || "", x.status, x.note || "", new Date(x.at).toISOString()]);
    for (const j of r.jobs.slice(r.i)) rows.push([j.id, j.title, j.action, j.newTitle || "", "not reached", "", ""]);
    download(`chatgpt-triage-report-${fileStamp()}.csv`, csv(rows), "text/csv");
  }

  ui.toast = function toast(message) {
    if (!ui.root || !message) return;
    if (ui.toastEl) ui.toastEl.remove();
    const t = h("div", { class: "toast", role: "status" }, message);
    ui.root.append(t);
    ui.toastEl = t;
    clearTimeout(ui.toastTimer);
    ui.toastTimer = setTimeout(() => {
      t.classList.add("leaving");
      setTimeout(() => t.remove(), 200);
    }, 3200);
  };

  function recheckOtherTab() {
    Store.open(Api.accountId);
    const r = Store.data.run;
    ui.lockedElsewhere = Boolean(r && ACTIVE.includes(r.status) && r.owner !== Runner.tabId && now() - (r.beat || 0) < CFG.staleBeat);
    if (!ui.lockedElsewhere && r && ACTIVE.includes(r.status)) {
      r.status = "paused";
      r.note = "The other tab stopped mid-run. Nothing was lost.";
      Store.flush();
    }
    ui.runSig = "";
    ui.renderAll();
  }

  async function retryBoot() {
    ui.fatal = null;
    if (!Api.token) {
      ui.booted = false;
      boot();
    } else {
      await loadActive();
    }
  }

  // ---------------------------------------------------------------------------
  // Clock: countdowns and heartbeat
  // ---------------------------------------------------------------------------

  let hadCooldown = false;
  setInterval(() => {
    if (!ui.booted) return;
    const r = Store.data.run;
    if (Runner.looping && r && now() - Runner.lastBeat > 5 * SEC) {
      Runner.lastBeat = now();
      r.beat = now();
      Store.save();
    }
    const cooling = Api.cooldownLeft() > 0;
    if (ui.isOpen) {
      if (r) ui.renderRun();
      if (cooling || hadCooldown) {
        const cd = ui.el.banners.querySelector("[data-countdown]");
        if (cd && cooling) cd.textContent = clock(Api.cooldownLeft());
        else ui.renderBanners();
        if (!cooling) ui.renderTop();
      }
      renderState();
    }
    hadCooldown = cooling;
    if (!ui.isOpen) ui.renderLauncher();
  }, 500);

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  ui.mount();
  window.__chatgptTriage = {
    version: VERSION,
    open: () => ui.open(),
    close: () => ui.close(),
  };
  if (TEST.expose) {
    window.__chatgptTriage.debug = { Store, Data, Api: { cooldownLeft: () => Api.cooldownLeft(), log: Api.log }, Runner, ui, cache, CFG };
  }
  // Pasted into the console: open right away. As a userscript: wait for a click.
  if (!IS_USERSCRIPT) ui.open();
})();
