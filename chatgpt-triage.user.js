// ==UserScript==
// @name         Triage
// @namespace    https://github.com/NASIRCISSISTIC/chatgpt-triage
// @version      1.0.0
// @description  Read every chat before you decide. Queue deletes, archives and renames, and let them run at a pace ChatGPT tolerates.
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

  const VERSION = "1.0.0";
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

  const fileStamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");

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
      const present = new Set(fresh.map((c) => c.id));
      for (const res of gone) {
        if (!present.has(res.id)) continue;
        res.status = "unconfirmed";
        res.note = "Still in your chat list afterwards. It's marked again so you can retry.";
        Store.data.marks[res.id] = { a: res.action, title: res.title, at: now() };
      }
      Data.active = fresh;
      Data.index();
      r.note = "";
    },
  };

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
  // One rule for type: anything the machine says (labels, dates, counts, keys,
  // status) is monospace; anything a person wrote (chats, titles, sentences) is
  // sans-serif. Black and white throughout. Red only means "this deletes".
  // ---------------------------------------------------------------------------

  const CSS = `
    :host { all: initial; }
    .root {
      --mono: ui-monospace, "SF Mono", "Cascadia Mono", "Cascadia Code", "JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace;
      --sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif;
      --ease: cubic-bezier(.22, 1, .36, 1);
      --ease-in: cubic-bezier(.55, 0, .75, .2);
      --bg: #ffffff; --bg1: #ffffff; --bg2: #f4f4f4; --bg3: #ebebeb;
      --line: #ededed; --line2: #d6d6d6;
      --fg: #0a0a0a; --fg2: #4f4f4f; --fg3: #8a8a8a; --fg4: #bcbcbc;
      --red: #d70015; --red-bg: rgba(215, 0, 21, .07);
      --green: #1fa04b; --amber: #d98300;
      --veil: rgba(255, 255, 255, .74);
      --shadow: 0 1px 2px rgba(0, 0, 0, .04), 0 28px 70px -18px rgba(0, 0, 0, .28);
      color-scheme: light;
      font: 14px/1.5 var(--sans);
      color: var(--fg);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    .root.dark {
      --bg: #000000; --bg1: #0a0a0a; --bg2: #121212; --bg3: #1b1b1b;
      --line: #1a1a1a; --line2: #2c2c2c;
      --fg: #f4f4f4; --fg2: #a6a6a6; --fg3: #6c6c6c; --fg4: #414141;
      --red: #ff453a; --red-bg: rgba(255, 69, 58, .12);
      --green: #30d158; --amber: #ffb340;
      --veil: rgba(0, 0, 0, .7);
      --shadow: 0 0 0 1px rgba(255, 255, 255, .03), 0 40px 90px -24px rgba(0, 0, 0, .95);
      color-scheme: dark;
    }
    * { box-sizing: border-box; scrollbar-width: thin; scrollbar-color: var(--line2) transparent; }
    [hidden] { display: none !important; }
    button, input, select { font: inherit; color: inherit; }
    a { color: inherit; text-decoration: none; }
    ::selection { background: var(--fg); color: var(--bg); }
    :focus { outline: none; }
    :focus-visible { outline: 1px solid var(--fg); outline-offset: 2px; }

    @keyframes rise { from { opacity: 0; transform: translateY(10px) scale(.992); } }
    @keyframes sink { to { opacity: 0; transform: translateY(6px) scale(.996); } }
    @keyframes fade { from { opacity: 0; } }
    @keyframes fade-out { to { opacity: 0; } }
    @keyframes pop { from { opacity: 0; transform: translateY(8px) scale(.985); } }
    @keyframes up { from { opacity: 0; transform: translateY(6px); } }
    @keyframes slide { from { opacity: 0; transform: translateX(-6px); } }
    @keyframes strike { from { transform: scaleX(0); } }
    @keyframes blink { 50% { opacity: 0; } }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
    @keyframes toast { from { opacity: 0; transform: translate(-50%, 10px) scale(.98); } }
    @keyframes toast-out { to { opacity: 0; transform: translate(-50%, 6px); } }

    /* Launcher on chatgpt.com */
    .launcher {
      position: fixed; right: 20px; bottom: 88px; display: inline-flex; align-items: center; gap: 10px;
      height: 34px; padding: 0 15px 0 13px; border-radius: 999px; border: 1px solid #2a2a2a;
      background: #0a0a0a; color: #f4f4f4; cursor: pointer; box-shadow: 0 10px 28px -10px rgba(0, 0, 0, .5);
      transition: transform .2s var(--ease), box-shadow .2s var(--ease); animation: rise .45s var(--ease) both;
    }
    .launcher:hover { transform: translateY(-1px); box-shadow: 0 14px 32px -10px rgba(0, 0, 0, .6); }
    .launcher:active { transform: scale(.97); }
    .launcher .word { font: 600 10.5px/1 var(--sans); letter-spacing: .34em; margin-right: -.34em; }
    .launcher .info { font: 11px/1 var(--mono); color: #9a9a9a; font-variant-numeric: tabular-nums; }
    .launcher .dot { width: 6px; height: 6px; border-radius: 50%; background: #6c6c6c; transition: background-color .3s; }
    .launcher .dot.go, .launcher .dot.ok { background: #30d158; }
    .launcher .dot.wait { background: #ffb340; }
    .launcher .dot.live { animation: pulse 1.6s var(--ease) infinite; }

    /* Frame */
    .panel { position: fixed; inset: 0; display: flex; flex-direction: column; background: var(--bg); color: var(--fg); outline: none; animation: rise .3s var(--ease) both; transition: background-color .35s var(--ease), color .35s var(--ease); }
    .panel.leaving { animation: sink .16s var(--ease-in) both; pointer-events: none; }
    .top { display: flex; align-items: stretch; gap: 18px; height: 56px; padding: 0 20px; border-bottom: 1px solid var(--line); flex-shrink: 0; }
    .brand { display: flex; align-items: center; gap: 12px; user-select: none; }
    .brand .word { font: 600 12.5px/1 var(--sans); letter-spacing: .36em; margin-right: -.36em; }
    .brand .caret { width: 7px; height: 13px; background: var(--fg); margin-left: 3px; animation: blink 1.15s steps(1) infinite; }
    .brand .ver { font: 11px/1 var(--mono); color: var(--fg3); }
    .tabs { position: relative; display: flex; margin-left: 10px; }
    .tabbtns { display: flex; gap: 2px; }
    .tab { border: 0; background: none; padding: 0 10px; cursor: pointer; display: flex; align-items: center; gap: 7px; font: 12.5px/1 var(--mono); color: var(--fg3); transition: color .18s; }
    .tab:hover { color: var(--fg2); }
    .tab.on { color: var(--fg); }
    .tab .n { font-size: 11px; color: var(--fg4); font-variant-numeric: tabular-nums; transition: color .18s; }
    .tab.on .n { color: var(--fg3); }
    .tabind { position: absolute; left: 0; bottom: -1px; height: 1.5px; width: 0; background: var(--fg); opacity: 0; pointer-events: none; transition: transform .34s var(--ease), width .34s var(--ease), opacity .2s; }
    .instant { transition: none !important; }
    .spacer { flex: 1; }
    .queue { display: flex; align-items: center; gap: 16px; font: 12px/1 var(--mono); color: var(--fg3); white-space: nowrap; }
    .queue b { color: var(--fg); font-weight: 600; font-variant-numeric: tabular-nums; }
    .queue .q-delete b { color: var(--red); }
    .actions { display: flex; align-items: center; gap: 6px; }

    .btn {
      height: 30px; padding: 0 11px; border-radius: 7px; border: 1px solid var(--line2); background: transparent; cursor: pointer;
      display: inline-flex; align-items: center; gap: 8px; font: 12px/1 var(--mono); color: var(--fg); white-space: nowrap;
      transition: background-color .15s, border-color .15s, color .15s, opacity .15s, transform .12s var(--ease);
    }
    .btn:hover:not(:disabled) { background: var(--bg2); border-color: var(--fg4); }
    .btn:active:not(:disabled) { transform: scale(.97); }
    .btn:disabled { opacity: .32; cursor: default; }
    .btn.primary { background: var(--fg); color: var(--bg); border-color: var(--fg); font-weight: 600; }
    .btn.primary:hover:not(:disabled) { background: var(--fg); border-color: var(--fg); opacity: .86; }
    .btn.run { height: 32px; padding: 0 15px 0 13px; border-radius: 999px; gap: 8px; }
    .btn.run.has-count { padding-right: 5px; }
    .btn.run svg { transition: transform .28s var(--ease); }
    .btn.run:hover:not(:disabled) svg { transform: translateX(2px); }
    .btn.run .count {
      display: inline-grid; place-items: center; min-width: 22px; height: 22px; padding: 0 7px; border-radius: 999px;
      background: var(--bg); color: var(--fg); font: 600 11px/1 var(--mono); font-variant-numeric: tabular-nums;
    }
    .btn.run .count.bump { animation: bump .4s var(--ease); }
    @keyframes bump { 40% { transform: scale(1.22); } }
    .btn.icon.theme svg { animation: turn .5s var(--ease) both; }
    @keyframes turn { from { opacity: 0; transform: rotate(-90deg) scale(.6); } }
    .seg { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--line2); border-radius: 9px; }
    .seg button { height: 28px; padding: 0 12px; border: 0; border-radius: 7px; background: transparent; cursor: pointer; font: 12px/1 var(--mono); color: var(--fg2); transition: background-color .2s var(--ease), color .2s; }
    .seg button:hover { color: var(--fg); }
    .seg button.on { background: var(--fg); color: var(--bg); }
    .btn.icon { width: 30px; padding: 0; justify-content: center; color: var(--fg2); border-color: transparent; }
    .btn.icon:hover:not(:disabled) { color: var(--fg); background: var(--bg2); border-color: transparent; }
    .btn.ghost { border-color: transparent; color: var(--fg2); }
    .btn.ghost:hover:not(:disabled) { color: var(--fg); border-color: transparent; }
    .btn.danger { color: var(--red); }
    .btn.on { background: var(--bg3); border-color: var(--fg4); }
    .btn.small { height: 26px; padding: 0 9px; font-size: 11.5px; }
    .k, .kbd {
      display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 4px; border-radius: 4px;
      border: 1px solid var(--line2); font: 10.5px/1 var(--mono); color: var(--fg3);
    }
    .btn.on .k { border-color: var(--fg4); color: var(--fg2); }

    .banner { display: flex; align-items: center; gap: 14px; padding: 11px 20px; border-bottom: 1px solid var(--line); font: 12px/1.5 var(--sans); color: var(--fg2); animation: up .3s var(--ease) both; }
    .banner .lbl { font: 600 10.5px/1 var(--mono); letter-spacing: .14em; color: var(--fg); }
    .banner.bad, .banner.bad .lbl { color: var(--red); }
    .banner .clock { margin-left: auto; font: 12px/1 var(--mono); color: var(--fg); font-variant-numeric: tabular-nums; }

    /* List */
    .main { flex: 1; display: flex; min-height: 0; position: relative; }
    .left { width: min(640px, 48vw); min-width: 430px; display: flex; flex-direction: column; border-right: 1px solid var(--line); min-height: 0; }
    .tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 16px 16px 14px; }
    .search {
      flex: 1 1 220px; min-width: 0; height: 32px; padding: 0 12px; border-radius: 7px; border: 1px solid var(--line2);
      background: transparent; font: 12.5px/1 var(--mono); outline: none; transition: border-color .18s;
    }
    .search::placeholder { color: var(--fg3); }
    .search:focus { border-color: var(--fg); }
    .select { height: 32px; border-radius: 7px; border: 1px solid var(--line2); background: var(--bg); padding: 0 8px; font: 12px/1 var(--mono); cursor: pointer; }
    .chips { display: flex; gap: 6px; }
    .chip {
      height: 28px; padding: 0 11px; border-radius: 999px; border: 1px solid var(--line2); background: transparent; cursor: pointer;
      font: 11.5px/1 var(--mono); color: var(--fg2); transition: background-color .2s var(--ease), color .2s, border-color .2s;
    }
    .chip:hover { color: var(--fg); border-color: var(--fg4); }
    .chip.on { background: var(--fg); color: var(--bg); border-color: var(--fg); }

    .listhead {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-height: 42px; padding: 6px 18px;
      border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); font: 11.5px/1 var(--mono); color: var(--fg3);
    }
    .listhead .grow { flex: 1; }
    .listhead b { color: var(--fg); font-weight: 600; }

    .cb {
      appearance: none; -webkit-appearance: none; margin: 0; width: 13px; height: 13px; flex-shrink: 0; cursor: pointer;
      border: 1px solid var(--fg4); border-radius: 3px; background: transparent;
      transition: background-color .15s, border-color .15s, box-shadow .15s;
    }
    .cb:hover { border-color: var(--fg2); }
    .cb:checked { background: var(--fg); border-color: var(--fg); box-shadow: inset 0 0 0 2.5px var(--bg); }
    .cb:indeterminate { background: var(--fg3); border-color: var(--fg3); box-shadow: inset 0 0 0 3.5px var(--bg); }
    .cb:disabled { opacity: .28; cursor: default; }

    .list { flex: 1; position: relative; overflow: auto; overscroll-behavior: contain; outline: none; padding: 6px 0 28px; }
    .cursor {
      position: absolute; top: 0; left: 8px; right: 8px; height: 34px; border-radius: 7px; background: var(--fg); opacity: 0;
      pointer-events: none; transition: transform .22s var(--ease), height .22s var(--ease), opacity .18s;
    }
    .rows { position: relative; }
    .row {
      position: relative; display: grid; grid-template-columns: 13px 82px minmax(0, 1fr) auto; align-items: center; column-gap: 14px;
      height: 34px; margin: 0 8px; padding: 0 10px; border-radius: 7px; font: 12.5px/1 var(--mono); color: var(--fg);
      transition: color .18s, background-color .18s;
    }
    .row:hover { background: var(--bg2); }
    .row.sel { background: var(--bg3); }
    .row.focus, .row.focus:hover { background: transparent; color: var(--bg); }
    .row .date { font-size: 11.5px; color: var(--fg3); font-variant-numeric: tabular-nums; white-space: nowrap; transition: color .18s; }
    .row .title { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .row .t { position: relative; }
    .row.seen .t { color: var(--fg2); }
    .row.m-delete .t { color: var(--fg3); }
    .row.m-delete .t::after {
      content: ""; position: absolute; left: 0; right: 0; top: 55%; height: 1px; background: currentColor; transform-origin: left center;
    }
    .row.m-delete.fresh .t::after { animation: strike .38s var(--ease) both; }
    .row.focus .t, .row.focus.seen .t { color: var(--bg); }
    .row.focus.m-delete .t { color: color-mix(in srgb, var(--bg) 58%, transparent); }
    .row.focus .date { color: color-mix(in srgb, var(--bg) 58%, transparent); }
    .row.focus .cb { border-color: color-mix(in srgb, var(--bg) 45%, transparent); }
    .row.focus .cb:checked { background: var(--bg); border-color: var(--bg); box-shadow: inset 0 0 0 2.5px var(--fg); }
    .badge {
      display: inline-block; margin-right: 8px; padding: 0 5px; border-radius: 4px; border: 1px solid var(--line2);
      font: 10.5px/16px var(--mono); color: var(--fg3); vertical-align: 1px;
    }
    .row.focus .badge { border-color: color-mix(in srgb, var(--bg) 30%, transparent); color: color-mix(in srgb, var(--bg) 62%, transparent); }
    .end { position: relative; display: flex; align-items: center; justify-content: flex-end; }
    .tag {
      max-width: 240px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; padding: 0 6px; border-radius: 4px;
      font: 600 10px/18px var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--fg2);
      transition: opacity .14s, color .18s, background-color .18s;
    }
    .tag.fresh { animation: slide .24s var(--ease) both; }
    .tag.delete { color: var(--red); }
    .tag.prot { color: var(--fg3); }
    .tag .v { text-transform: none; letter-spacing: 0; font-weight: 500; color: var(--fg); }
    .row.focus .tag, .row.focus .tag .v { color: var(--bg); }
    .row.focus .tag.delete { color: #fff; background: var(--red); }
    .acts {
      position: absolute; right: -6px; top: 50%; transform: translateY(-50%); display: flex; gap: 2px; padding-left: 30px;
      opacity: 0; pointer-events: none; transition: opacity .15s; background: linear-gradient(to right, transparent, var(--bg2) 26px);
    }
    .row:hover .acts { opacity: 1; pointer-events: auto; }
    .row:hover .tag { opacity: 0; }
    .row.sel .acts { background: linear-gradient(to right, transparent, var(--bg3) 26px); }
    .row.focus .acts { background: linear-gradient(to right, transparent, var(--fg) 26px); }
    .mini {
      width: 26px; height: 26px; border: 0; border-radius: 6px; background: transparent; color: var(--fg2); cursor: pointer;
      display: grid; place-items: center; transition: background-color .12s, color .12s;
    }
    .mini:hover { background: var(--bg3); color: var(--fg); }
    .mini.on { color: var(--fg); }
    .row.focus .mini { color: color-mix(in srgb, var(--bg) 70%, transparent); }
    .row.focus .mini:hover { background: color-mix(in srgb, var(--bg) 16%, transparent); color: var(--bg); }

    .note { padding: 48px 24px; text-align: center; font: 12.5px/1.9 var(--mono); color: var(--fg3); animation: fade .3s var(--ease) both; }
    .note b { color: var(--fg); font-weight: 500; }
    .note .btn { margin-top: 16px; }
    .spin { display: inline-block; width: 1ch; margin-right: 1ch; color: var(--fg); }

    /* Reader */
    .reader { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
    .rhead { padding: 28px 44px 20px; border-bottom: 1px solid var(--line); }
    .rhead.fresh > * { animation: up .32s var(--ease) both; }
    .rhead.fresh > :nth-child(2) { animation-delay: .03s; }
    .rhead.fresh > :nth-child(3) { animation-delay: .06s; }
    .rhead.fresh > :nth-child(4) { animation-delay: .09s; }
    .rtitle { margin: 0 0 10px; font: 600 23px/1.25 var(--sans); letter-spacing: -.018em; overflow-wrap: anywhere; }
    .rmeta { display: flex; flex-wrap: wrap; gap: 4px 16px; font: 11.5px/1.5 var(--mono); color: var(--fg3); }
    .rstate { margin-top: 14px; font: 600 10.5px/1.5 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--fg2); }
    .rstate.delete { color: var(--red); }
    .rstate .v { text-transform: none; letter-spacing: 0; font-weight: 500; color: var(--fg); }
    .ractions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 18px; }
    .msgs { flex: 1; overflow: auto; overscroll-behavior: contain; padding: 32px 44px 72px; }
    .msg { max-width: 700px; margin: 0 auto 30px; }
    .msgs.enter .msg { animation: up .4s var(--ease) both; }
    .msg .who { margin-bottom: 10px; font: 600 10px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--fg3); }
    .msg .txt { font: 15px/1.72 var(--sans); white-space: pre-wrap; overflow-wrap: anywhere; color: var(--fg); }
    .msg.user .txt { padding-left: 15px; border-left: 1px solid var(--fg4); }
    .idle { height: 100%; display: grid; place-items: center; padding: 32px; animation: fade .4s var(--ease) both; }
    .legend { font: 12px/1 var(--mono); color: var(--fg3); }
    .legend .h { margin-bottom: 26px; text-align: center; font: 500 15px/1.4 var(--sans); color: var(--fg); letter-spacing: -.01em; }
    .legend .grid { display: grid; grid-template-columns: auto auto auto auto; gap: 14px 12px; align-items: center; justify-content: center; }
    .legend .grid .kbd { justify-self: end; }
    .legend .grid .l { margin-right: 26px; }
    .legend .f { margin-top: 28px; text-align: center; font: 12.5px/1.6 var(--sans); color: var(--fg3); }

    /* Run */
    .runlayer {
      position: absolute; inset: 0; z-index: 3; display: grid; place-items: center; padding: 20px;
      background: var(--veil); -webkit-backdrop-filter: blur(10px) saturate(120%); backdrop-filter: blur(10px) saturate(120%);
      animation: fade .28s var(--ease) both;
    }
    .card { width: min(580px, 100%); max-height: 100%; overflow: auto; padding: 24px 26px 22px; background: var(--bg1); border: 1px solid var(--line2); border-radius: 16px; box-shadow: var(--shadow); animation: pop .36s var(--ease) both; }
    .card .head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .card .state { display: flex; align-items: center; font: 600 10.5px/1 var(--mono); letter-spacing: .16em; color: var(--fg); }
    .card .state.bad { color: var(--red); }
    .card .frac { font: 12px/1 var(--mono); color: var(--fg3); font-variant-numeric: tabular-nums; }
    .card .frac b { color: var(--fg); font-weight: 600; }
    .bar { height: 2px; margin: 18px 0 20px; border-radius: 2px; background: var(--line2); overflow: hidden; }
    .bar i { display: block; height: 100%; width: 0; background: var(--fg); transition: width .7s var(--ease); }
    .now { display: flex; gap: 12px; font: 13px/1.5 var(--mono); color: var(--fg); min-width: 0; }
    .now .v { flex-shrink: 0; min-width: 15ch; color: var(--fg3); }
    .now .ttl { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; min-width: 0; }
    .card .sub { margin-top: 6px; min-height: 18px; font: 12px/1.5 var(--mono); color: var(--fg3); font-variant-numeric: tabular-nums; }
    .card .big { margin: 2px 0 6px; font: 300 46px/1.1 var(--mono); letter-spacing: -.03em; font-variant-numeric: tabular-nums; }
    .card .explain { font: 13.5px/1.6 var(--sans); color: var(--fg2); }
    .log { margin-top: 20px; padding-top: 14px; border-top: 1px solid var(--line); font: 12px/1 var(--mono); color: var(--fg3); max-height: 210px; overflow: auto; }
    .log div { display: flex; gap: 12px; padding: 5px 0; white-space: nowrap; min-width: 0; }
    .log div.new { animation: up .32s var(--ease) both; }
    .log .g { width: 1ch; flex-shrink: 0; color: var(--fg); }
    .log .v { min-width: 11ch; flex-shrink: 0; }
    .log .ttl { color: var(--fg2); overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .log .bad, .log .bad .g, .log .bad .ttl { color: var(--red); }
    .log .why { color: var(--fg3); flex-shrink: 0; }
    .card .btns { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 22px; }
    .card .tip { margin-top: 16px; font: 12.5px/1.6 var(--sans); color: var(--fg3); }

    /* Status bar */
    .foot { display: flex; align-items: center; gap: 18px; height: 36px; padding: 0 20px; border-top: 1px solid var(--line); font: 11.5px/1 var(--mono); color: var(--fg3); flex-shrink: 0; }
    .foot .state { display: flex; align-items: center; gap: 8px; color: var(--fg); white-space: nowrap; font-variant-numeric: tabular-nums; }
    .foot .state .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--fg4); transition: background-color .3s, box-shadow .3s; }
    .foot .state.ready .dot { background: var(--green); box-shadow: 0 0 0 3px color-mix(in srgb, var(--green) 20%, transparent); }
    .foot .state.busy .dot { background: var(--green); animation: pulse 1.2s var(--ease) infinite; }
    .foot .state.wait .dot { background: var(--amber); animation: pulse 1.2s var(--ease) infinite; }
    .foot .state.hold .dot { background: var(--amber); }
    .foot .state.bad { color: var(--red); } .foot .state.bad .dot { background: var(--red); }
    .foot .status { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .foot .links { margin-left: auto; display: flex; gap: 2px; }
    .foot .btn { height: 24px; padding: 0 8px; font-size: 11px; border-color: transparent; color: var(--fg3); }
    .foot .btn:hover:not(:disabled) { color: var(--fg); background: var(--bg2); border-color: transparent; }
    .foot .btn.on { color: var(--fg); background: var(--bg2); border-color: transparent; }
    .drawer { height: 210px; overflow: auto; padding: 12px 20px; border-top: 1px solid var(--line); background: var(--bg1); font: 11.5px/1.75 var(--mono); color: var(--fg2); animation: up .24s var(--ease) both; }
    .drawer .head { margin-bottom: 8px; font-family: var(--sans); font-size: 12px; color: var(--fg3); }
    .drawer .s429 { color: var(--fg); font-weight: 600; }
    .drawer .sbad { color: var(--red); }

    /* Dialogs */
    .modal-wrap {
      position: fixed; inset: 0; z-index: 5; display: grid; place-items: center; padding: 20px; background: var(--veil);
      -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); animation: fade .22s var(--ease) both;
    }
    .modal-wrap.leaving { animation: fade-out .15s var(--ease-in) both; pointer-events: none; }
    .modal-wrap.leaving .modal { animation: sink .15s var(--ease-in) both; }
    .modal { width: min(520px, 100%); max-height: calc(100vh - 48px); overflow: auto; padding: 26px 28px 22px; background: var(--bg1); border: 1px solid var(--line2); border-radius: 16px; box-shadow: var(--shadow); animation: pop .32s var(--ease) both; }
    .modal h2 { margin: 0 0 18px; font: 600 19px/1.3 var(--sans); letter-spacing: -.015em; }
    .modal p, .modal .hint { margin: 0 0 12px; font: 14px/1.6 var(--sans); color: var(--fg2); }
    .modal .hint { font-size: 13px; color: var(--fg3); }
    .modal .lbl { margin: 22px 0 10px; font: 600 10.5px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--fg3); }
    .modal .mfoot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 24px; }
    .modal input[type=text], .modal input[type=number] {
      width: 100%; height: 38px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--line2); background: transparent;
      font: 13.5px/1 var(--mono); outline: none; transition: border-color .18s;
    }
    .modal input[type=number] { width: 80px; }
    .modal input:focus { border-color: var(--fg); }
    .check { display: flex; gap: 12px; align-items: flex-start; margin: 14px 0; cursor: pointer; }
    .check .cb { margin-top: 3px; }
    .check .t { font: 13px/1.5 var(--mono); color: var(--fg); }
    .check .h { margin-top: 2px; font: 13px/1.5 var(--sans); color: var(--fg3); }
    .table { border-top: 1px solid var(--line); font: 13px/1 var(--mono); }
    .table div { display: grid; grid-template-columns: 1fr auto; gap: 16px; align-items: baseline; padding: 12px 0; border-bottom: 1px solid var(--line); }
    .table .n { font-weight: 600; font-variant-numeric: tabular-nums; }
    .table .x { margin-left: 12px; font-size: 11px; color: var(--fg3); }
    .table .del, .table .del .x { color: var(--red); }
    .eta { margin: 12px 0 4px; font: 12px/1.6 var(--mono); color: var(--fg3); }
    .keys { display: grid; grid-template-columns: max-content 1fr; gap: 10px 18px; align-items: center; font: 12.5px/1.4 var(--mono); color: var(--fg2); }
    .keys .kbd { margin-right: 4px; }
    .inline { display: flex; align-items: center; gap: 10px; font: 13px/1 var(--mono); color: var(--fg2); }
    .stack { display: flex; flex-wrap: wrap; gap: 8px; }

    .toast {
      position: fixed; left: 50%; bottom: 56px; z-index: 9; transform: translateX(-50%); max-width: min(560px, calc(100vw - 32px));
      padding: 10px 16px; border-radius: 10px; background: var(--fg); color: var(--bg); font: 12px/1.45 var(--mono);
      box-shadow: var(--shadow); animation: toast .32s var(--ease) both;
    }
    .toast.leaving { animation: toast-out .2s var(--ease-in) both; }

    @media (max-width: 980px) {
      .queue { display: none; }
      .main { flex-direction: column; }
      .left { width: auto; min-width: 0; height: 52%; border-right: 0; border-bottom: 1px solid var(--line); }
      .rhead, .msgs { padding-left: 22px; padding-right: 22px; }
    }
    @media (max-width: 640px) {
      .top { gap: 10px; padding: 0 12px; }
      .brand .ver, .tab .n { display: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration: 1ms !important; animation-iteration-count: 1 !important; transition-duration: 1ms !important; }
    }
  `;

  const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  const spinner = () => h("span", { class: "spin", "aria-hidden": "true" }, SPIN[0]);
  const pad2 = (n) => String(n).padStart(2, "0");

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
    readerHead: null,
    readerBody: null,
    order: [],
    rowEls: new Map(),
    drawer: null, // "activity" | "network" | null
    modal: null,
    modalClose: null,
    runSig: "",
    runEls: null,
    logSeen: 0,
    lastQueueTotal: null,
    themeOverride: null,
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

    ui.launcher = h("button", { class: "launcher", type: "button", title: "Open Triage (Alt+Shift+T)", "aria-label": "Open Triage", onclick: () => ui.open() });
    ui.renderLauncher();
    root.append(ui.launcher, buildPanel());
    root.addEventListener("keydown", onKey);
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

    ui.syncTheme();
    new MutationObserver(ui.syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    if (window.matchMedia) window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", ui.syncTheme);
  };

  const THEME_KEY = `${APP}:theme`;
  function themePref() {
    try {
      return localStorage.getItem(THEME_KEY) || "auto";
    } catch {
      return "auto";
    }
  }
  function setThemePref(value) {
    try {
      if (value === "auto") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, value);
    } catch {
      /* storage blocked: the choice lasts until reload */
    }
    ui.themeOverride = value;
    ui.syncTheme();
  }
  function toggleTheme() {
    setThemePref(ui.root.classList.contains("dark") ? "light" : "dark");
  }

  // Follows ChatGPT's theme unless you picked light or dark yourself.
  ui.syncTheme = function syncTheme() {
    const pref = ui.themeOverride || themePref();
    const de = document.documentElement;
    let dark;
    if (pref === "dark") dark = true;
    else if (pref === "light") dark = false;
    else if (de.classList.contains("dark")) dark = true;
    else if (de.classList.contains("light")) dark = false;
    else dark = Boolean(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    const changed = ui.root.classList.contains("dark") !== dark || !ui.el.themeBtn || !ui.el.themeBtn.firstChild;
    ui.root.classList.toggle("dark", dark);
    if (changed && ui.el.themeBtn) {
      const label = dark ? "Switch to light mode" : "Switch to dark mode";
      ui.el.themeBtn.title = label;
      ui.el.themeBtn.setAttribute("aria-label", label);
      ui.el.themeBtn.replaceChildren(icon(dark ? "sun" : "moon", 16));
    }
  };

  function iconBtn(name, title, onclick) {
    return h("button", { class: "btn icon", type: "button", title, "aria-label": title, onclick }, icon(name, 16));
  }

  function buildPanel() {
    const el = ui.el;
    el.tabBtns = h("div", { class: "tabbtns", role: "tablist", "aria-label": "Which chats" });
    el.tabInd = h("span", { class: "tabind instant", "aria-hidden": "true" });
    el.tabs = h("div", { class: "tabs" }, el.tabBtns, el.tabInd);
    el.queue = h("div", { class: "queue", "aria-live": "polite" });
    el.refresh = iconBtn("refresh", "Reload the chat list", () => reloadLists());
    el.runBtn = h("button", { class: "btn primary run", type: "button", title: "Review the queue, then run it", onclick: () => confirmRun() });
    el.themeBtn = h("button", { class: "btn icon theme", type: "button", onclick: () => toggleTheme() });
    const top = h("div", { class: "top" },
      h("div", { class: "brand", title: `Triage ${VERSION}` }, h("span", { class: "word" }, "TRIAGE"), h("span", { class: "caret", "aria-hidden": "true" }), h("span", { class: "ver" }, `v${VERSION}`)),
      el.tabs,
      h("div", { class: "spacer" }),
      el.queue,
      h("div", { class: "actions" },
        el.refresh,
        el.themeBtn,
        iconBtn("sliders", "Settings", () => openSettings()),
        iconBtn("help", "Help and shortcuts (?)", () => openHelp()),
        el.runBtn,
        iconBtn("x", "Close. Your marks are saved.", () => ui.close())));

    el.banners = h("div", { class: "banners" });

    el.search = h("input", {
      class: "search", type: "search", placeholder: "Search titles and opened chats",
      title: "Searches every title, plus the text of chats you've opened in Triage", "aria-label": "Search",
      oninput: (e) => {
        ui.filters.q = e.target.value;
        ui.renderList();
      },
    });
    el.age = select([[0, "Any age"], [7 * DAY, "Older than 1 week"], [30 * DAY, "Older than 1 month"], [90 * DAY, "Older than 3 months"], [180 * DAY, "Older than 6 months"], [365 * DAY, "Older than 1 year"]], 0, (v) => {
      ui.filters.age = Number(v);
      ui.renderList();
    }, "Age");
    el.sort = select([["oldest", "Oldest first"], ["newest", "Newest first"], ["updated", "Recently used"]], "oldest", (v) => {
      ui.filters.sort = v;
      ui.renderList();
    }, "Sort");
    el.chips = h("div", { class: "chips" },
      chip("unread", "Unread", "Only chats you haven't opened in Triage"),
      chip("untitled", "Untitled", "Only chats called “New chat” or with no title"),
      chip("marked", "Marked", "Only chats with a queued change"));
    const tools = h("div", { class: "tools" }, el.search, el.age, el.sort, el.chips);

    el.listhead = h("div", { class: "listhead" });
    el.cursor = h("div", { class: "cursor instant", "aria-hidden": "true" });
    el.rows = h("div", { class: "rows" });
    el.list = h("div", { class: "list", tabindex: "0", role: "listbox", "aria-label": "Chats", onclick: onListClick }, el.cursor, el.rows);
    el.left = h("div", { class: "left" }, tools, el.listhead, el.list);
    el.reader = h("div", { class: "reader" });
    el.runLayer = h("div", { class: "runlayer", hidden: true });
    el.main = h("div", { class: "main" }, el.left, el.reader, el.runLayer);

    el.state = h("div", { class: "state" });
    el.status = h("div", { class: "status" });
    el.activityBtn = h("button", { class: "btn", type: "button", onclick: () => toggleDrawer("activity") }, "Activity");
    el.networkBtn = h("button", { class: "btn", type: "button", title: "Every request Triage has sent", onclick: () => toggleDrawer("network") }, "Network");
    el.drawerEl = h("div", { class: "drawer", hidden: true });
    const foot = h("div", { class: "foot" }, el.state, el.status,
      h("div", { class: "links" }, el.activityBtn, el.networkBtn, h("a", { class: "btn", href: HOMEPAGE, target: "_blank", rel: "noopener noreferrer" }, "GitHub ↗")));

    ui.panel = h("div", { class: "panel", hidden: true, tabindex: "-1", role: "dialog", "aria-label": "Triage" }, top, el.banners, el.main, el.drawerEl, foot);
    return ui.panel;
  }

  function select(options, value, onChange, label) {
    const s = h("select", { class: "select", "aria-label": label, onchange: (e) => onChange(e.target.value) },
      options.map(([v, text]) => h("option", { value: String(v) }, text)));
    s.value = String(value);
    return s;
  }

  function chip(key, label, title) {
    const b = h("button", { class: "chip", type: "button", title, "aria-pressed": "false" }, label);
    b.addEventListener("click", () => {
      ui.filters[key] = !ui.filters[key];
      b.classList.toggle("on", ui.filters[key]);
      b.setAttribute("aria-pressed", String(ui.filters[key]));
      ui.renderList();
    });
    return b;
  }

  function check(input, label, help) {
    input.classList.add("cb");
    return h("label", { class: "check" }, input, h("div", null, h("div", { class: "t" }, label), help ? h("div", { class: "h" }, help) : null));
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
    ui.renderList();
    ui.renderReader();
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
    ui.el.tabBtns.replaceChildren(...tabs.map(([key, count, title]) => h("button", {
      class: `tab${ui.filters.scope === key ? " on" : ""}`, type: "button", role: "tab", title,
      "aria-selected": String(ui.filters.scope === key),
      onclick: () => setScope(key),
    }, h("span", null, TAB_LABEL[key]), h("span", { class: "n" }, count == null ? "·" : String(count)))));
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
    ind.style.width = `${on.offsetWidth - 20}px`;
    ind.style.transform = `translateX(${on.offsetLeft + 10}px)`;
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
      if (q[a]) parts.push(h("span", { class: `q-${a}` }, `${ACTION[a].label} `, h("b", null, String(q[a]))));
    }
    ui.el.queue.replaceChildren(...(parts.length ? parts : [h("span", null, "Queue Empty")]));
    renderRunButton(q.total);
    ui.el.runBtn.disabled = !q.total || Runner.isActive() || Boolean(Store.data.run) || ui.lockedElsewhere || !Data.compatOk || Boolean(Data.loading);
    ui.el.refresh.disabled = Runner.isActive() || Boolean(Data.loading);
  };

  function renderRunButton(total) {
    const btn = ui.el.runBtn;
    const bump = ui.lastQueueTotal !== null && total !== ui.lastQueueTotal && total > 0;
    ui.lastQueueTotal = total;
    btn.classList.toggle("has-count", total > 0);
    btn.replaceChildren(...[icon("play", 11), h("span", null, "Run Queue"), total ? h("span", { class: `count${bump ? " bump" : ""}` }, String(total)) : null].filter(Boolean));
  }

  ui.renderBanners = function renderBanners() {
    const out = [];
    const left = Api.cooldownLeft();
    if (left > 0 && !Runner.isActive()) {
      out.push(h("div", { class: "banner" }, h("span", { class: "lbl" }, "WAIT"),
        h("span", null, `ChatGPT asked Triage to slow down. Reading and running resume at ${fmtClock(Store.data.cooldownUntil)}.`),
        h("span", { class: "clock", "data-countdown": "" }, clock(left))));
    }
    if (ui.lockedElsewhere) {
      out.push(h("div", { class: "banner" }, h("span", { class: "lbl" }, "BUSY"), h("span", null, "Triage is running a queue in another tab. Use that tab, or close it and reload this one.")));
    }
    if (!Data.compatOk) {
      out.push(h("div", { class: "banner bad" }, h("span", { class: "lbl" }, "OFF"), h("span", null, "ChatGPT's data looks different from what Triage expects, so changes are switched off. Reading still works. Check GitHub for an update.")));
    }
    ui.el.banners.replaceChildren(...out);
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

  ui.renderList = function renderList() {
    const el = ui.el;
    ui.rowEls = new Map();
    if (ui.fatal) {
      ui.order = [];
      el.listhead.replaceChildren();
      el.rows.replaceChildren(h("div", { class: "note" }, h("div", null, ui.fatal), h("button", { class: "btn", type: "button", onclick: () => retryBoot() }, "Try Again")));
      placeCursor(false);
      return;
    }
    const L = Data.loading;
    const loadingHere = L && (L.scope === "archived") === (ui.filters.scope === "archived");
    const rows = visibleChats();
    ui.order = rows.map((c) => c.id);

    if (loadingHere && !rows.length) {
      el.listhead.replaceChildren();
      const text = L.message || (L.waiting
        ? `ChatGPT asked Triage to slow down. Carrying on at ${fmtClock(Store.data.cooldownUntil)}.`
        : `Loading chats  ${L.n}${L.total ? ` / ~${L.total}` : ""}`);
      el.rows.replaceChildren(h("div", { class: "note" }, spinner(), text));
      placeCursor(false);
      return;
    }

    renderListHead(rows);
    if (!rows.length) {
      const filtered = ui.filters.q || ui.filters.age || ui.filters.unread || ui.filters.untitled || ui.filters.marked;
      el.rows.replaceChildren(h("div", { class: "note" }, h("div", null, filtered ? "No chats match these filters." : "No chats here."),
        filtered ? h("button", { class: "btn", type: "button", onclick: clearFilters }, "Clear Filters") : null));
      placeCursor(false);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const c of rows) {
      const row = rowEl(c);
      ui.rowEls.set(c.id, row);
      frag.append(row);
    }
    if (loadingHere) {
      frag.append(h("div", { class: "note" }, spinner(), L.waiting ? "Waiting for ChatGPT" : `Loading  ${L.n}${L.total ? ` / ~${L.total}` : ""}`));
    }
    el.rows.replaceChildren(frag);
    if (ui.focusId && !ui.rowEls.has(ui.focusId)) ui.focusId = null;
    ui.fresh.clear();
    placeCursor(false);
    ui.renderStatus();
  };

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
    const parts = [all, h("span", null, `${rows.length} ${rows.length === 1 ? "Chat" : "Chats"}`)];
    if (ui.sel.size) {
      const archivedScope = ui.filters.scope === "archived";
      parts.push(h("b", null, `${ui.sel.size} Selected`), h("span", { class: "grow" }),
        bulkBtn("delete"),
        archivedScope ? bulkBtn("unarchive") : bulkBtn("archive"),
        h("button", { class: "btn small", type: "button", title: "Protect the selected chats (P)", onclick: () => applyAction("protect", selectedChats()) }, "Protect"),
        h("button", { class: "btn small", type: "button", title: "Remove queued changes from the selected chats (C)", onclick: () => applyAction("clear", selectedChats()) }, "Clear"),
        h("button", { class: "btn small ghost", type: "button", title: "Select the shown chats that aren't selected", onclick: invertSelection }, "Invert"),
        h("button", { class: "btn small ghost", type: "button", onclick: () => { ui.sel.clear(); ui.renderList(); } }, "Deselect"));
    } else {
      parts.push(h("span", { class: "grow" }), h("span", null, "Click to read · Shift-click for a range · ? for keys"));
    }
    ui.el.listhead.replaceChildren(...parts);
  }

  function bulkBtn(action) {
    const a = ACTION[action];
    return h("button", { class: `btn small t-${action}${action === "delete" ? " danger" : ""}`, type: "button", title: `${a.label} the selected chats (${a.key})`, onclick: () => applyAction(action, selectedChats()) }, a.label);
  }

  function rowEl(c) {
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
    const badges = [];
    if (c.pinned) badges.push(h("span", { class: "badge", title: "Pinned" }, "Pinned"));
    if (c.projectId && ui.filters.scope !== "projects") badges.push(h("span", { class: "badge", title: "In a project" }, "Project"));
    if (c.gptId) badges.push(h("span", { class: "badge", title: "Chat with a custom GPT" }, "GPT"));
    const cb = h("input", { type: "checkbox", class: "cb", tabindex: "-1", "aria-label": "Select", disabled: prot });
    cb.checked = ui.sel.has(c.id);
    let tag = null;
    if (prot) tag = h("span", { class: `tag prot${fresh ? " fresh" : ""}`, title: "Protected: Triage won't change this chat" }, "Protected");
    else if (mark && mark.a === "rename") tag = h("span", { class: `tag rename${fresh ? " fresh" : ""}`, title: `Rename to ${quote(mark.t)}` }, "Rename → ", h("span", { class: "v" }, mark.t));
    else if (mark) tag = h("span", { class: `tag ${mark.a}${fresh ? " fresh" : ""}` }, ACTION[mark.a].label);
    const acts = h("span", { class: "acts" },
      miniBtn(c.archived ? "unarchive" : "archive", Boolean(mark && mark.a === (c.archived ? "unarchive" : "archive"))),
      miniBtn("delete", Boolean(mark && mark.a === "delete")),
      miniBtn("rename", Boolean(mark && mark.a === "rename")),
      miniBtn("protect", prot));
    return h("div", { class: cls.join(" "), "data-id": c.id, role: "option", "aria-selected": String(c.id === ui.focusId) },
      cb,
      h("span", { class: "date", title: c.created ? new Date(c.created).toLocaleString() : "" }, isoDate(c.created)),
      h("span", { class: "title", title: c.title || "Untitled" }, badges, h("span", { class: "t" }, c.title || "Untitled")),
      h("span", { class: "end" }, tag, acts));
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
    const row = ui.focusId ? ui.rowEls.get(ui.focusId) : null;
    if (!row || !row.offsetHeight) {
      cur.style.opacity = "0";
      return;
    }
    const snap = !animate || cur.style.opacity !== "1";
    cur.classList.toggle("instant", snap);
    cur.style.transform = `translateY(${row.offsetTop + ui.el.rows.offsetTop}px)`;
    cur.style.height = `${row.offsetHeight}px`;
    cur.style.opacity = "1";
    if (snap) requestAnimationFrame(() => cur.classList.remove("instant"));
  }

  function idleLegend() {
    const pair = (k, label) => [h("span", { class: "kbd" }, k), h("span", { class: "l" }, label)];
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
    const box = ui.el.reader;
    const c = ui.readerId ? Data.byId.get(ui.readerId) : null;
    if (!c) {
      const key = `idle:${Data.active.length || Data.archived.length ? 1 : 0}`;
      if (ui.readerBody !== key) box.replaceChildren(idleLegend());
      ui.readerHead = null;
      ui.readerBody = key;
      return;
    }
    const d = Store.data;
    const mark = d.marks[c.id];
    const prot = Boolean(d.protect[c.id]);
    const conv = cache.get(c.id);
    const meta = [
      `Created ${isoDate(c.created)}`,
      c.updated ? `Last Used ${isoDate(c.updated)}` : null,
      conv ? `${conv.messages.length} ${conv.messages.length === 1 ? "Message" : "Messages"}` : null,
      c.projectId ? "Project" : null,
      c.gptId ? "Custom GPT" : null,
      c.pinned ? "Pinned" : null,
      c.archived ? "Archived" : null,
    ].filter(Boolean);

    let state = null;
    if (prot) state = h("div", { class: "rstate" }, "Protected · Triage won't change this chat");
    else if (mark && mark.a === "rename") state = h("div", { class: "rstate" }, "Queued · Rename → ", h("span", { class: "v" }, mark.t));
    else if (mark) state = h("div", { class: `rstate ${mark.a}` }, `Queued · ${ACTION[mark.a].label}${mark.a === "delete" ? " · Can't be undone" : ""}`);

    const actionBtn = (action) => {
      const a = ACTION[action];
      const on = action === "protect" ? prot : Boolean(mark && mark.a === action);
      const label = action === "protect" ? (prot ? "Unprotect" : "Protect") : on ? `Unmark ${a.label}` : a.label;
      return h("button", { class: `btn${on ? " on" : ""}${action === "delete" ? " danger" : ""}`, type: "button", title: `${label} (${a.key})`, onclick: () => applyAction(action, [c]) },
        h("span", { class: "k" }, a.key), label);
    };
    const open = TEST.demo
      ? h("button", { class: "btn ghost", type: "button", onclick: () => ui.toast("In the demo, chats don't open in ChatGPT.") }, "Open in ChatGPT ↗")
      : h("a", { class: "btn ghost", href: `/c/${encodeURIComponent(c.id)}`, target: "_blank", rel: "noopener noreferrer" }, "Open in ChatGPT ↗");
    const switched = ui.readerHead !== c.id;
    ui.readerHead = c.id;
    const head = h("div", { class: `rhead${switched ? " fresh" : ""}` },
      h("h2", { class: "rtitle" }, c.title || "Untitled"),
      h("div", { class: "rmeta" }, meta.map((m) => h("span", null, m))),
      state,
      h("div", { class: "ractions" },
        actionBtn("delete"), c.archived ? actionBtn("unarchive") : actionBtn("archive"), actionBtn("rename"), actionBtn("protect"), open));

    // Only rebuild the conversation when it's a different chat or it just arrived, so marking doesn't make it jump.
    const rs = ui.reader && ui.reader.id === c.id ? ui.reader : null;
    const bodyKey = conv ? `ok:${c.id}` : rs && rs.status === "error" ? `err:${c.id}:${rs.error && rs.error.kind}` : `load:${c.id}`;
    const oldBody = box.querySelector(".msgs");
    const oldHead = box.querySelector(".rhead");
    if (ui.readerBody === bodyKey && oldBody && oldHead) {
      oldHead.replaceWith(head);
      return;
    }
    let body;
    {
      if (conv) {
        body = h("div", { class: "msgs enter" }, conv.messages.length
          ? conv.messages.map((m, i) => {
            const msg = h("div", { class: `msg ${m.role}` }, h("div", { class: "who" }, m.role === "user" ? "you" : "chatgpt"), h("div", { class: "txt" }, m.text));
            msg.style.animationDelay = `${Math.min(i, 6) * 40}ms`;
            return msg;
          })
          : h("div", { class: "note" }, "This chat has no text messages to show."));
        const entering = body;
        setTimeout(() => entering.classList.remove("enter"), 900);
      } else if (rs && rs.status === "error") {
        const e = rs.error || {};
        const text = e.kind === "cooldown" || e.kind === "ratelimit"
          ? `ChatGPT asked Triage to slow down. You can read chats again at ${fmtClock(Store.data.cooldownUntil)}.`
          : e.kind === "notfound" ? "This chat doesn't exist in ChatGPT any more." : `Couldn't load this chat. ${e.message || ""}`;
        body = h("div", { class: "msgs" }, h("div", { class: "note" }, h("div", null, text),
          e.kind === "notfound" ? null : h("button", { class: "btn", type: "button", onclick: () => openReader(c.id, true) }, "Try Again")));
      } else {
        body = h("div", { class: "msgs" }, h("div", { class: "note" }, spinner(), "Loading chat"));
      }
      ui.readerBody = bodyKey;
    }
    box.replaceChildren(head, body);
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
    el.replaceChildren(h("span", { class: "dot" }), text);
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
    ui.launcher.replaceChildren(...[h("span", { class: `dot ${dot}` }), h("span", { class: "word" }, "TRIAGE"), info ? h("span", { class: "info" }, info) : null].filter(Boolean));
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
    el.drawerEl.replaceChildren(...lines);
    el.drawerEl.scrollTop = el.drawerEl.scrollHeight;
  };

  function toggleDrawer(which) {
    ui.drawer = ui.drawer === which ? null : which;
    ui.renderDrawer();
  }

  // The card that covers the workspace while the queue runs.
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
      ui.runEls = null;
      ui.logSeen = 0;
      return;
    }
    if (ui.lockedElsewhere) {
      if (ui.runSig !== "elsewhere") {
        ui.runSig = "elsewhere";
        ui.runEls = null;
        el.runLayer.replaceChildren(h("div", { class: "card" },
          h("div", { class: "head" }, h("div", { class: "state" }, "BUSY")),
          h("div", { class: "bar" }, h("i")),
          h("div", { class: "explain" }, "Triage is working through a queue in another ChatGPT tab. Only one tab can run the queue at a time."),
          h("div", { class: "btns" }, h("button", { class: "btn", type: "button", onclick: recheckOtherTab }, "Check Again"))));
      }
      return;
    }
    // Rebuild only when something meaningful changed, so buttons stay clickable between ticks.
    const sig = [r.status, r.i, r.results.length, r.note, r.current, r.nextAt ? 1 : 0].join("|");
    if (sig === ui.runSig && ui.runEls) {
      tickRun();
      return;
    }
    ui.runSig = sig;

    const total = r.jobs.length;
    const done = r.results.filter((x) => x.status === "done").length;
    const failed = r.results.filter((x) => x.status === "failed").length;
    const unconfirmed = r.results.filter((x) => x.status === "unconfirmed").length;
    const live = ACTIVE.includes(r.status);
    const job = r.current ? r.jobs.find((j) => j.id === r.current) : null;
    const label = {
      backup: "BACKING UP", running: "RUNNING", waiting: "WAITING", verifying: "CHECKING", paused: "PAUSED",
      done: failed || unconfirmed ? "DONE · NEEDS A LOOK" : "DONE", stopped: "STOPPED",
    }[r.status] || "QUEUE";
    const width = String(total).length;

    const bar = h("i");
    bar.style.width = `${total ? Math.round((r.i / total) * 100) : 0}%`;
    const parts = [
      h("div", { class: "head" },
        h("div", { class: `state${(r.status === "done" && (failed || unconfirmed)) ? " bad" : ""}` }, live ? spinner() : null, label),
        h("div", { class: "frac" }, h("b", null, String(r.i).padStart(width, "0")), ` / ${total}`)),
      h("div", { class: "bar" }, bar),
    ];

    const sub = h("div", { class: "sub" });
    let big = null;
    const nowLine = (verb, title, extra) => h("div", { class: "now" }, h("span", { class: "v" }, verb), h("span", { class: "ttl" }, title, extra || null));
    if (r.status === "waiting") {
      big = h("div", { class: "big" }, clock(Api.cooldownLeft()));
      parts.push(big, h("div", { class: "explain" }, `ChatGPT asked Triage to slow down. It carries on by itself at ${fmtClock(Store.data.cooldownUntil)}.`));
      if (job) parts.push(h("div", { style: "height:14px" }), nowLine(`Next: ${ACTION[job.action].label}`, job.title || "Untitled", job.action === "rename" ? ` → ${job.newTitle}` : null));
    } else if (r.status === "backup") {
      parts.push(nowLine("Reading", (job && job.title) || "…"), sub);
      sub.textContent = r.note;
    } else if (r.status === "running" && job) {
      const a = ACTION[job.action];
      parts.push(nowLine(r.nextAt ? `Next: ${a.label}` : a.verb, job.title || "Untitled", job.action === "rename" ? ` → ${job.newTitle}` : null), sub);
    } else if (r.status === "verifying") {
      parts.push(nowLine("Checking", "Your chat list"), sub);
      sub.textContent = r.note;
    } else if (r.status === "paused") {
      parts.push(h("div", { class: "explain" }, r.note || "Nothing else changes until you resume."));
    } else if (r.status === "done" || r.status === "stopped") {
      const bits = [`${plural(done, "change")} made`];
      if (failed) bits.push(`${failed} failed`);
      if (unconfirmed) bits.push(`${unconfirmed} didn't stick and are marked again`);
      if (r.status === "stopped" && r.i < total) bits.push(`${total - r.i} not reached, still marked`);
      parts.push(h("div", { class: "explain" }, `${bits.join(". ")}.`));
    }

    // A terminal-style log: newest last. Finished runs list only what needs attention.
    const finished = r.status === "done" || r.status === "stopped" || r.status === "paused";
    const issues = r.results.filter((x) => x.status !== "done");
    const items = finished && issues.length ? issues.slice(-40) : r.results.slice(-6);
    if (items.length) {
      const glyph = { done: "✓", failed: "✕", unconfirmed: "~" };
      const log = h("div", { class: "log" }, items.map((x, i) => {
        const isNew = r.results.length > ui.logSeen && i === items.length - 1 && !finished;
        const bad = x.status !== "done";
        return h("div", { class: `${bad ? "bad" : ""}${isNew ? " new" : ""}` },
          h("span", { class: "g" }, glyph[x.status] || "·"),
          h("span", { class: "v" }, x.note === "It was already gone." ? "Gone" : ACTION[x.action].past),
          h("span", { class: "ttl" }, x.title || "Untitled", x.action === "rename" && x.newTitle ? ` → ${x.newTitle}` : ""),
          bad && x.note ? h("span", { class: "why" }, x.note) : null);
      }));
      parts.push(log);
      ui.logSeen = r.results.length;
    }

    const btns = [];
    if (live) {
      btns.push(h("button", { class: "btn", type: "button", onclick: () => Runner.pause() }, "Pause"));
      btns.push(h("button", { class: "btn ghost", type: "button", onclick: () => Runner.stop() }, "Stop"));
    } else if (r.status === "paused") {
      btns.push(h("button", { class: "btn primary", type: "button", disabled: ui.lockedElsewhere, onclick: () => Runner.resume() }, "Resume"));
      btns.push(h("button", { class: "btn ghost", type: "button", onclick: () => Runner.stop() }, "Stop"));
    } else {
      btns.push(h("button", { class: "btn primary", type: "button", onclick: () => Runner.dismiss() }, "Close"));
      btns.push(h("button", { class: "btn", type: "button", onclick: downloadReport }, "Download Report"));
      if (Runner.backup.length) btns.push(h("button", { class: "btn", type: "button", onclick: () => download(`chatgpt-triage-backup-${fileStamp()}.json`, JSON.stringify(Runner.backup, null, 2), "application/json") }, "Download Backup"));
    }
    parts.push(h("div", { class: "btns" }, btns));
    if (live) parts.push(h("div", { class: "tip" }, "Keep this tab open. You can close this panel and keep using ChatGPT; the button in the corner shows progress. Other ChatGPT tabs and the desktop app share the same limit, so close them if you can."));

    el.runLayer.replaceChildren(h("div", { class: "card", role: "status", "aria-live": "polite" }, parts));
    ui.runEls = { sub, big };
    tickRun();
  };

  function tickRun() {
    const r = Store.data.run;
    const els = ui.runEls;
    if (!r || !els) return;
    if (els.big) els.big.textContent = clock(Api.cooldownLeft());
    if (r.status === "running" && r.nextAt) els.sub.textContent = `In ${Math.max(0, Math.ceil((r.nextAt - now()) / SEC))}s`;
    else if (r.status === "running" && r.note) els.sub.textContent = r.note;
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
    ui.el.age.value = "0";
    for (const b of ui.el.chips.children) {
      b.classList.remove("on");
      b.setAttribute("aria-pressed", "false");
    }
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
    if (e.target.closest(".cb")) {
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
    const old = ui.focusId && ui.rowEls.get(ui.focusId);
    if (old) {
      old.classList.remove("focus");
      old.setAttribute("aria-selected", "false");
    }
    ui.focusId = id;
    const row = id && ui.rowEls.get(id);
    if (row) {
      row.classList.add("focus");
      row.setAttribute("aria-selected", "true");
      if (scroll) row.scrollIntoView({ block: "nearest" });
    }
    placeCursor(true);
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
    if (row) row.classList.add("seen");
    ui.renderStatus();
  }

  function isTyping(e) {
    const t = e.composedPath()[0];
    if (!t || !t.tagName) return false;
    const tag = t.tagName.toLowerCase();
    return tag === "textarea" || tag === "select" || t.isContentEditable || (tag === "input" && !["checkbox", "radio", "button"].includes(t.type));
  }

  function onKey(e) {
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
    const wrap = h("div", { class: "modal-wrap" });
    wrap.addEventListener("mousedown", (e) => {
      if (e.target === wrap) closeModal();
    });
    const foot = h("div", { class: "mfoot" }, buttons.map(([label, kind, fn]) => h("button", {
      class: `btn ${kind || ""}`, type: "button",
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
    const input = h("input", { type: "text", "aria-label": "New title", maxlength: "200" });
    input.value = mark && mark.a === "rename" ? mark.t : c.title;
    modal("Rename chat", [
      h("div", { class: "lbl" }, "Now"),
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
    const minutes = Math.max(1, Math.round((jobs.length * gap) / 60));
    const rows = ["delete", "archive", "unarchive", "rename"].filter((a) => n[a]).map((a) => h("div", { class: a === "delete" ? "del" : "" },
      h("span", null, ACTION[a].label, a === "delete" ? h("span", { class: "x" }, "Permanent · ChatGPT can't restore deleted chats") : null),
      h("span", { class: "n" }, String(n[a]))));
    const backup = h("input", { type: "checkbox" });
    backup.checked = Store.data.settings.backup;
    const typed = h("input", { type: "text", placeholder: String(n.delete), "aria-label": "Type the number of chats to delete" });
    const body = [
      h("div", { class: "table" }, rows),
      h("div", { class: "eta" }, `Changes: ${jobs.length}  ·  One every ${gap}s  ·  About ${minutes} min`),
      h("p", { class: "hint" }, "If ChatGPT says \"too many requests\", Triage waits as long as it asks and carries on by itself."),
    ];
    if (n.delete) body.push(check(backup, `Back up the ${plural(n.delete, "chat")} being deleted first`, "Saves one Markdown file before anything is deleted."));
    if (n.delete >= CFG.typeToConfirm) body.push(h("div", { class: "lbl" }, `Type ${n.delete} to Confirm`), typed);
    body.push(h("p", { class: "hint", style: "margin-top:16px" }, "Close other ChatGPT tabs and the desktop app while this runs. They share the same limit."));
    const box = modal("Run the queue?", body, [
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

  function openSettings() {
    const s = Store.data.settings;
    const gap = h("input", { type: "number", min: String(CFG.gapMin), max: String(CFG.gapMax), step: "1", "aria-label": "Seconds between changes" });
    gap.value = String(s.gap);
    const backup = h("input", { type: "checkbox" });
    backup.checked = s.backup;
    const pinned = h("input", { type: "checkbox" });
    pinned.checked = s.pinnedInSelectAll;
    const small = (label, fn) => h("button", { class: "btn small", type: "button", onclick: fn }, label);
    modal("Settings", [
      h("div", { class: "lbl", style: "margin-top:0" }, "Pace"),
      h("div", { class: "inline" }, h("span", null, "Wait"), gap, h("span", null, "seconds between changes")),
      h("p", { class: "hint", style: "margin-top:10px" }, `Slower is safer. Minimum ${CFG.gapMin}, default ${CFG.gapDefault}. After a "too many requests", Triage also waits however long ChatGPT asks.`),
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

  function themeSeg() {
    const current = ui.themeOverride || themePref();
    const seg = h("div", { class: "seg", role: "group", "aria-label": "Theme" });
    for (const [value, label] of [["auto", "Match ChatGPT"], ["light", "Light"], ["dark", "Dark"]]) {
      seg.append(h("button", {
        class: current === value ? "on" : "", type: "button",
        onclick: (e) => {
          setThemePref(value);
          for (const b of seg.children) b.classList.toggle("on", b === e.currentTarget);
        },
      }, label));
    }
    return seg;
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
      [["↑", "↓"], "Move; the chat opens on the right"],
      [["J", "K"], "Move, the Vim way"],
      [["Shift", "↑↓"], "Select while moving"],
      [["Space"], "Select or unselect"],
      [["D"], "Queue delete, then go to the next chat"],
      [["A"], "Queue archive (unarchive in Archived)"],
      [["R"], "Queue a new name"],
      [["P"], "Protect, so it's never touched"],
      [["C"], "Clear the queued change"],
      [["/"], "Search"],
      [["Esc"], "Clear the selection"],
      [["Alt", "Shift", "T"], "Open or close Triage"],
    ];
    modal("Triage", [
      h("p", null, "Read your chats, mark what should happen to each one, then run the queue. ChatGPT doesn't change until you do, and your marks are saved in this browser."),
      h("div", { class: "lbl" }, "Keys"),
      h("div", { class: "keys" }, keys.map(([ks, v]) => [h("span", null, ks.map((k) => h("span", { class: "kbd" }, k))), h("span", null, v)])),
      h("div", { class: "lbl" }, "The Limit"),
      h("p", null, "One change at a time, with a pause between each. If ChatGPT says \"too many requests\", Triage stops every request, waits as long as ChatGPT asks (longer each time if it doesn't say), then carries on with the same chat."),
      h("div", { class: "lbl" }, "Safety"),
      h("p", null, "Project and pinned chats stay out of Main and select all. Deletes can be backed up first, and big deletes ask you to type the number. At the end, Triage reloads your list to check the changes stuck."),
      h("div", { class: "lbl" }, "Privacy"),
      h("p", null, "Triage runs in your browser and only talks to chatgpt.com. The Network button shows every request it sends."),
      h("p", { class: "hint" }, `v${VERSION} · `, h("a", { href: HOMEPAGE, target: "_blank", rel: "noopener noreferrer", style: "text-decoration:underline" }, "Source on GitHub"), " · Not affiliated with OpenAI"),
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
  // Clocks: countdowns, heartbeat, spinners
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

  let spinFrame = 0;
  setInterval(() => {
    if (!ui.root || (!ui.isOpen && !ui.modal)) return;
    const spins = ui.root.querySelectorAll(".spin");
    if (!spins.length) return;
    spinFrame = (spinFrame + 1) % SPIN.length;
    for (const s of spins) s.textContent = SPIN[spinFrame];
  }, 80);

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
