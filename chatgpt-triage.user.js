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
    delete: { label: "Delete", verb: "Deleting", key: "D", icon: "trash" },
    archive: { label: "Archive", verb: "Archiving", key: "A", icon: "archive" },
    unarchive: { label: "Unarchive", verb: "Unarchiving", key: "U", icon: "restore" },
    rename: { label: "Rename", verb: "Renaming", key: "R", icon: "pencil" },
    protect: { label: "Protect", verb: "", key: "P", icon: "shield" },
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

  function fmtDate(t, long) {
    if (!t) return "—";
    const opts = long ? { year: "numeric", month: "short", day: "numeric" } : { year: "2-digit", month: "short", day: "numeric" };
    return new Date(t).toLocaleDateString(undefined, opts);
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
  };

  function icon(name, size = 16) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", ICONS[name] || "");
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
  // ---------------------------------------------------------------------------

  const CSS = `
    :host { all: initial; }
    .root {
      --bg: #ffffff; --bg2: #f7f7f8; --bg3: #ececef; --fg: #0d0d0d; --fg2: #5d5d66; --fg3: #8e8e98;
      --line: #e3e3e8; --danger: #c9302c; --danger-bg: #fdecea; --blue: #1d5fd6; --blue-bg: #e8effd;
      --green: #16794a; --green-bg: #e5f5ec; --violet: #6d3fd6; --violet-bg: #efe9fd; --amber: #9a5b00; --amber-bg: #fff3dc;
      --focus: #1d5fd6; --shadow: 0 24px 64px rgba(0,0,0,.22), 0 2px 8px rgba(0,0,0,.08);
      font: 14px/1.45 ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: var(--fg); -webkit-font-smoothing: antialiased; color-scheme: light;
    }
    .root.dark {
      --bg: #212121; --bg2: #1a1a1a; --bg3: #303030; --fg: #ececec; --fg2: #b4b4b4; --fg3: #8a8a8a;
      --line: #383838; --danger: #ff7b72; --danger-bg: rgba(255,123,114,.13); --blue: #7aa7ff; --blue-bg: rgba(122,167,255,.14);
      --green: #6ad39a; --green-bg: rgba(106,211,154,.13); --violet: #b39dff; --violet-bg: rgba(179,157,255,.14);
      --amber: #f5c060; --amber-bg: rgba(245,192,96,.13); --focus: #7aa7ff;
      --shadow: 0 24px 64px rgba(0,0,0,.6), 0 2px 8px rgba(0,0,0,.4);
      color-scheme: dark;
    }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    button, input, select { font: inherit; color: inherit; }
    a { color: inherit; }
    :focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }

    .launcher {
      position: fixed; right: 18px; bottom: 84px; z-index: 1; display: inline-flex; align-items: center; gap: 7px;
      height: 36px; padding: 0 14px 0 11px; border-radius: 999px; border: 1px solid var(--line);
      background: var(--bg); color: var(--fg); box-shadow: 0 4px 16px rgba(0,0,0,.14); cursor: pointer;
      font-size: 13px; font-weight: 600;
    }
    .launcher:hover { background: var(--bg2); }
    .launcher .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); }
    .launcher .dot.wait { background: var(--amber); }

    .panel { position: fixed; inset: 0; display: flex; flex-direction: column; background: var(--bg); outline: none; }
    .top { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
    .brand { display: flex; align-items: center; gap: 7px; font-weight: 650; font-size: 15px; margin-right: 6px; }
    .brand .ver { font-weight: 500; font-size: 11px; color: var(--fg3); }
    .tabs { display: flex; gap: 2px; background: var(--bg2); padding: 3px; border-radius: 10px; }
    .tab { border: 0; background: transparent; padding: 5px 11px; border-radius: 7px; cursor: pointer; font-size: 13px; color: var(--fg2); }
    .tab .n { color: var(--fg3); margin-left: 5px; font-size: 12px; font-variant-numeric: tabular-nums; }
    .tab.on { background: var(--bg); color: var(--fg); box-shadow: 0 1px 2px rgba(0,0,0,.08); }
    .root.dark .tab.on { background: var(--bg3); }
    .spacer { flex: 1; }
    .queue { font-size: 12.5px; color: var(--fg2); display: flex; gap: 8px; flex-wrap: wrap; }
    .queue b { font-weight: 600; }
    .queue .q-delete b { color: var(--danger); } .queue .q-archive b { color: var(--blue); }
    .queue .q-unarchive b { color: var(--green); } .queue .q-rename b { color: var(--violet); }

    .btn {
      height: 32px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg);
      cursor: pointer; display: inline-flex; align-items: center; gap: 6px; font-size: 13px; white-space: nowrap;
    }
    .btn:hover:not(:disabled) { background: var(--bg2); }
    .btn:disabled { opacity: .45; cursor: not-allowed; }
    .btn.primary { background: var(--fg); color: var(--bg); border-color: var(--fg); font-weight: 600; }
    .btn.primary:hover:not(:disabled) { opacity: .88; background: var(--fg); }
    .btn.icon { width: 32px; padding: 0; justify-content: center; }
    .btn.small { height: 28px; padding: 0 9px; font-size: 12.5px; }
    .btn.t-delete { color: var(--danger); } .btn.t-archive { color: var(--blue); }
    .btn.t-unarchive { color: var(--green); } .btn.t-rename { color: var(--violet); }
    .btn.on { background: var(--bg3); }

    .banners:empty { display: none; }
    .banner { display: flex; align-items: center; gap: 10px; padding: 9px 16px; font-size: 13px; border-bottom: 1px solid var(--line); }
    .banner.warn { background: var(--amber-bg); color: var(--amber); }
    .banner.bad { background: var(--danger-bg); color: var(--danger); }
    .banner.info { background: var(--blue-bg); color: var(--blue); }

    .main { flex: 1; display: flex; min-height: 0; position: relative; }
    .left { width: min(600px, 48vw); min-width: 400px; display: flex; flex-direction: column; border-right: 1px solid var(--line); min-height: 0; }
    .tools { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line); }
    .search {
      flex: 1 1 220px; min-width: 0; height: 32px; padding: 0 11px; border-radius: 8px; border: 1px solid var(--line);
      background: var(--bg2); outline: none;
    }
    .search:focus { border-color: var(--focus); background: var(--bg); }
    .select { height: 32px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); padding: 0 8px; font-size: 13px; }
    .chips { display: flex; gap: 6px; }
    .chip { height: 32px; padding: 0 11px; border-radius: 999px; border: 1px solid var(--line); background: var(--bg); cursor: pointer; font-size: 12.5px; }
    .chip.on { background: var(--fg); color: var(--bg); border-color: var(--fg); }

    .listhead { display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 4px 12px; border-bottom: 1px solid var(--line); font-size: 12.5px; color: var(--fg2); flex-wrap: wrap; }
    .listhead .grow { flex: 1; }
    .listhead .hint { color: var(--fg3); }
    .list { flex: 1; overflow: auto; overscroll-behavior: contain; outline: none; }
    .row {
      display: grid; grid-template-columns: 20px 68px minmax(0, 1fr) auto; align-items: center; gap: 8px;
      height: 38px; padding: 0 10px 0 12px; border-bottom: 1px solid var(--line); cursor: pointer;
    }
    .row:hover { background: var(--bg2); }
    .row.focus { background: var(--bg3); box-shadow: inset 3px 0 0 var(--focus); }
    .row.sel { background: var(--blue-bg); }
    .row.focus.sel { box-shadow: inset 3px 0 0 var(--focus); }
    .row .cb, .listhead .cb { margin: 0; width: 15px; height: 15px; cursor: pointer; accent-color: var(--focus); }
    .row .date { font-size: 12px; color: var(--fg3); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .row .title { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 550; }
    .row.seen .title { font-weight: 400; color: var(--fg2); }
    .row.m-delete .title { color: var(--danger); text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--danger) 45%, transparent); }
    .row .end { display: flex; align-items: center; gap: 4px; }
    .badge { display: inline-flex; align-items: center; gap: 3px; font-size: 11px; font-weight: 500; padding: 1px 6px; border-radius: 5px; background: var(--bg3); color: var(--fg2); margin-right: 6px; vertical-align: 1px; }
    .badge.prot { background: var(--green-bg); color: var(--green); }
    .tag { font-size: 11.5px; font-weight: 600; padding: 2px 8px; border-radius: 999px; max-width: 190px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .tag.delete { color: var(--danger); background: var(--danger-bg); }
    .tag.archive { color: var(--blue); background: var(--blue-bg); }
    .tag.unarchive { color: var(--green); background: var(--green-bg); }
    .tag.rename { color: var(--violet); background: var(--violet-bg); }
    .acts { display: none; gap: 1px; }
    .row:hover .acts, .row.focus .acts { display: flex; }
    .mini { width: 26px; height: 26px; border: 0; border-radius: 6px; background: transparent; color: var(--fg2); cursor: pointer; display: grid; place-items: center; }
    .mini:hover { background: var(--bg); color: var(--fg); }
    .mini.on { color: var(--green); }
    .loadmsg { padding: 28px 18px; color: var(--fg2); text-align: center; }

    .reader { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
    .rhead { padding: 16px 24px 12px; border-bottom: 1px solid var(--line); }
    .rtitle { font-size: 18px; font-weight: 650; margin: 0 0 3px; overflow-wrap: anywhere; }
    .rmeta { color: var(--fg2); font-size: 12.5px; }
    .rstate { margin-top: 8px; font-size: 12.5px; font-weight: 600; }
    .rstate.delete { color: var(--danger); } .rstate.archive { color: var(--blue); } .rstate.unarchive, .rstate.protect { color: var(--green); } .rstate.rename { color: var(--violet); }
    .ractions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .kbd { font: 11px ui-monospace, SFMono-Regular, Consolas, monospace; padding: 0 5px; border-radius: 4px; border: 1px solid var(--line); border-bottom-width: 2px; color: var(--fg2); background: var(--bg); }
    .msgs { flex: 1; overflow: auto; padding: 18px 24px 48px; overscroll-behavior: contain; }
    .msg { max-width: 780px; margin: 0 auto 16px; }
    .msg .who { font-size: 12px; font-weight: 600; color: var(--fg3); margin-bottom: 4px; }
    .msg .txt { white-space: pre-wrap; overflow-wrap: anywhere; }
    .msg.user .txt { background: var(--bg3); padding: 10px 14px; border-radius: 16px; }
    .empty { height: 100%; display: grid; place-items: center; text-align: center; padding: 24px; color: var(--fg2); }
    .empty .big { font-size: 15px; font-weight: 600; color: var(--fg); margin-bottom: 6px; }
    .empty .small { font-size: 13px; line-height: 1.7; }

    .runlayer { position: absolute; inset: 0; display: grid; place-items: center; background: color-mix(in srgb, var(--bg) 72%, transparent); backdrop-filter: blur(2px); z-index: 2; padding: 16px; }
    .card { width: min(560px, 100%); max-height: 100%; overflow: auto; background: var(--bg); border: 1px solid var(--line); border-radius: 16px; box-shadow: var(--shadow); padding: 20px 22px; }
    .card h2 { margin: 0 0 6px; font-size: 17px; }
    .card .line { font-weight: 550; overflow-wrap: anywhere; }
    .card .sub { color: var(--fg2); font-size: 13px; margin-top: 4px; min-height: 19px; }
    .progress { height: 6px; border-radius: 99px; background: var(--bg3); overflow: hidden; margin: 14px 0 6px; }
    .progress i { display: block; height: 100%; width: 0; background: var(--fg); transition: width .35s ease; }
    .counts { font-size: 12.5px; color: var(--fg2); display: flex; gap: 12px; flex-wrap: wrap; }
    .card .btns { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
    .card .tip { font-size: 12px; color: var(--fg3); margin-top: 14px; }
    .issues { margin-top: 12px; border: 1px solid var(--line); border-radius: 10px; max-height: 180px; overflow: auto; font-size: 12.5px; }
    .issues div { padding: 6px 10px; border-bottom: 1px solid var(--line); }
    .issues div:last-child { border-bottom: 0; }
    .issues b { font-weight: 600; }

    .foot { display: flex; align-items: center; gap: 8px; padding: 6px 14px; border-top: 1px solid var(--line); font-size: 12px; color: var(--fg2); }
    .foot .status { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .foot a { color: var(--fg2); }
    .drawer { height: 190px; overflow: auto; border-top: 1px solid var(--line); background: var(--bg2); padding: 8px 14px; font: 12px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--fg2); }
    .drawer .head { font-family: ui-sans-serif, -apple-system, "Segoe UI", sans-serif; color: var(--fg3); margin-bottom: 6px; }
    .drawer .s429 { color: var(--amber); } .drawer .sbad { color: var(--danger); }

    .modal-wrap { position: fixed; inset: 0; background: rgba(0,0,0,.42); display: grid; place-items: center; z-index: 5; padding: 16px; }
    .modal { width: min(540px, 100%); max-height: calc(100vh - 48px); overflow: auto; background: var(--bg); border: 1px solid var(--line); border-radius: 16px; box-shadow: var(--shadow); padding: 20px 22px; }
    .modal h2 { margin: 0 0 12px; font-size: 17px; }
    .modal p { margin: 0 0 10px; color: var(--fg2); }
    .modal .mfoot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
    .modal .field { margin: 12px 0; }
    .modal .field label { display: flex; gap: 8px; align-items: flex-start; cursor: pointer; }
    .modal .field .help { font-size: 12.5px; color: var(--fg3); margin: 3px 0 0 24px; }
    .modal .field .help.flush { margin-left: 0; }
    .modal input[type=text], .modal input[type=number] { width: 100%; height: 36px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg2); padding: 0 10px; outline: none; }
    .modal input[type=number] { width: 90px; }
    .modal input:focus { border-color: var(--focus); background: var(--bg); }
    .modal .inline { display: flex; align-items: center; gap: 8px; }
    .summary { border: 1px solid var(--line); border-radius: 10px; margin: 6px 0 12px; }
    .summary div { display: flex; justify-content: space-between; padding: 7px 12px; border-bottom: 1px solid var(--line); }
    .summary div:last-child { border-bottom: 0; }
    .summary .perm { color: var(--danger); font-size: 12px; }
    .keys { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; font-size: 13px; margin: 6px 0 14px; }
    .keys .kbd { margin-right: 3px; }
    .stack { display: flex; flex-wrap: wrap; gap: 8px; }
    .sep { height: 1px; background: var(--line); margin: 16px 0; }

    .toast { position: fixed; left: 50%; bottom: 56px; transform: translateX(-50%); z-index: 9; background: var(--fg); color: var(--bg); padding: 9px 15px; border-radius: 10px; font-size: 13px; box-shadow: var(--shadow); max-width: min(560px, calc(100vw - 32px)); }

    @media (max-width: 900px) {
      .main { flex-direction: column; }
      .left { width: auto; min-width: 0; height: 52%; border-right: 0; border-bottom: 1px solid var(--line); }
      .queue { display: none; }
    }
  `;

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
    anchor: null,
    focusId: null,
    readerId: null,
    reader: null, // { id, status: "loading" | "ok" | "error", error }
    order: [],
    rowEls: new Map(),
    drawer: null, // "activity" | "network" | null
    modal: null,
    modalClose: null,
    runSig: "",
    runEls: null,
    previewTimer: null,
    toastTimer: null,

    onNetwork() {
      if (ui.drawer === "network") ui.renderDrawer();
    },
    onActivity() {
      if (ui.drawer === "activity") ui.renderDrawer();
      if (ui.el.status && activity.length) ui.renderStatus();
    },
    onCooldown() {
      if (ui.booted) {
        ui.renderBanners();
        ui.renderLauncher();
      }
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

    ui.launcher = h("button", { class: "launcher", type: "button", title: "Open Triage (Alt+Shift+T)", onclick: () => ui.open() });
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

  ui.syncTheme = function syncTheme() {
    const de = document.documentElement;
    let dark;
    if (de.classList.contains("dark")) dark = true;
    else if (de.classList.contains("light")) dark = false;
    else dark = Boolean(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    ui.root.classList.toggle("dark", dark);
  };

  function buildPanel() {
    const el = ui.el;
    el.tabs = h("div", { class: "tabs", role: "tablist", "aria-label": "Which chats" });
    el.queue = h("div", { class: "queue", "aria-live": "polite" });
    el.refresh = h("button", { class: "btn icon", type: "button", title: "Reload the chat list", "aria-label": "Reload the chat list", onclick: () => reloadLists() }, icon("refresh"));
    el.runBtn = h("button", { class: "btn primary", type: "button", onclick: () => confirmRun() }, "Run queue");
    const top = h("div", { class: "top" },
      h("div", { class: "brand" }, icon("logo", 18), h("span", null, "Triage"), h("span", { class: "ver" }, `v${VERSION}`)),
      el.tabs,
      h("div", { class: "spacer" }),
      el.queue,
      el.refresh,
      h("button", { class: "btn icon", type: "button", title: "Settings", "aria-label": "Settings", onclick: () => openSettings() }, icon("sliders")),
      h("button", { class: "btn icon", type: "button", title: "Help and shortcuts (?)", "aria-label": "Help and shortcuts", onclick: () => openHelp() }, icon("help")),
      el.runBtn,
      h("button", { class: "btn icon", type: "button", title: "Close. Your marks are saved.", "aria-label": "Close Triage", onclick: () => ui.close() }, icon("x")));

    el.banners = h("div", { class: "banners" });

    el.search = h("input", {
      class: "search", type: "search", placeholder: "Search titles and opened chats", title: "Searches every title, plus the text of chats you've opened in Triage", "aria-label": "Search",
      oninput: (e) => {
        ui.filters.q = e.target.value;
        ui.renderList();
      },
    });
    el.age = select([[0, "Any age"], [7 * DAY, "Older than a week"], [30 * DAY, "Older than a month"], [90 * DAY, "Older than 3 months"], [180 * DAY, "Older than 6 months"], [365 * DAY, "Older than a year"]], 0, (v) => {
      ui.filters.age = Number(v);
      ui.renderList();
    }, "Age");
    el.sort = select([["oldest", "Oldest first"], ["newest", "Newest first"], ["updated", "Recently used"]], "oldest", (v) => {
      ui.filters.sort = v;
      ui.renderList();
    }, "Sort");
    el.chips = h("div", { class: "chips" }, chip("unread", "Unread", "Only chats you haven't opened in Triage"), chip("untitled", "Untitled", "Only chats called “New chat” or with no title"), chip("marked", "Marked", "Only chats with a queued change"));
    const tools = h("div", { class: "tools" }, el.search, el.age, el.sort, el.chips);

    el.listhead = h("div", { class: "listhead" });
    el.list = h("div", { class: "list", tabindex: "0", role: "listbox", "aria-label": "Chats", onclick: onListClick });
    el.left = h("div", { class: "left" }, tools, el.listhead, el.list);
    el.reader = h("div", { class: "reader" });
    el.runLayer = h("div", { class: "runlayer", hidden: true });
    el.main = h("div", { class: "main" }, el.left, el.reader, el.runLayer);

    el.status = h("div", { class: "status" });
    el.activityBtn = h("button", { class: "btn small", type: "button", onclick: () => toggleDrawer("activity") }, "Activity");
    el.networkBtn = h("button", { class: "btn small", type: "button", title: "Every request Triage has sent", onclick: () => toggleDrawer("network") }, "Network");
    el.drawerEl = h("div", { class: "drawer", hidden: true });
    const foot = h("div", { class: "foot" }, el.status, h("div", { class: "spacer" }), el.activityBtn, el.networkBtn,
      h("a", { href: HOMEPAGE, target: "_blank", rel: "noopener noreferrer" }, "GitHub"));

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

  // ---------------------------------------------------------------------------
  // Opening, closing, booting
  // ---------------------------------------------------------------------------

  ui.open = function open() {
    ui.panel.hidden = false;
    ui.launcher.hidden = true;
    ui.isOpen = true;
    ui.el.list.focus({ preventScroll: true });
    if (!ui.booted) boot();
    else ui.renderAll();
  };

  ui.close = function close() {
    closeModal();
    ui.panel.hidden = true;
    ui.launcher.hidden = false;
    ui.isOpen = false;
    ui.renderLauncher();
  };

  async function boot() {
    ui.booted = true;
    Data.loading = { scope: "active", n: 0, total: null, waiting: false, message: "Connecting to ChatGPT…" };
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
    ui.renderRun(true);
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

  ui.renderTabs = function renderTabs() {
    const n = counts();
    const tabs = [
      ["main", "Main", n.main, "Your regular chats. Project chats are left out so a cleanup can't empty a project by accident."],
      ["projects", "Projects", n.projects, "Chats that live inside Projects"],
      ["archived", "Archived", n.archived, "Chats you've archived. They load when you open this tab."],
      ["all", "All", n.all, "Main and project chats together"],
    ];
    ui.el.tabs.replaceChildren(...tabs.map(([key, label, count, title]) => h("button", {
      class: `tab${ui.filters.scope === key ? " on" : ""}`, type: "button", role: "tab", title,
      "aria-selected": String(ui.filters.scope === key),
      onclick: () => setScope(key),
    }, label, h("span", { class: "n" }, count == null ? "" : String(count)))));
  };

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
      if (q[a]) parts.push(h("span", { class: `q-${a}` }, h("b", null, String(q[a])), ` to ${ACTION[a].label.toLowerCase()}`));
    }
    ui.el.queue.replaceChildren(...(parts.length ? parts : [h("span", null, "Nothing queued yet")]));
    ui.el.runBtn.textContent = q.total ? `Run queue (${q.total})` : "Run queue";
    ui.el.runBtn.disabled = !q.total || Runner.isActive() || Boolean(Store.data.run) || ui.lockedElsewhere || !Data.compatOk || Boolean(Data.loading);
    ui.el.refresh.disabled = Runner.isActive() || Boolean(Data.loading);
  };

  ui.renderBanners = function renderBanners() {
    const out = [];
    const left = Api.cooldownLeft();
    if (left > 0 && !Runner.isActive()) {
      out.push(h("div", { class: "banner warn", "data-kind": "cooldown" },
        `ChatGPT asked Triage to slow down. Opening chats and running the queue will work again at ${fmtClock(Store.data.cooldownUntil)} (`,
        h("span", { "data-countdown": "" }, fmtDuration(left)), ")."));
    }
    if (ui.lockedElsewhere) {
      out.push(h("div", { class: "banner warn" }, "Triage is running a queue in another tab. Use that tab, or close it and reload this one."));
    }
    if (!Data.compatOk) {
      out.push(h("div", { class: "banner bad" }, "ChatGPT's data looks different from what Triage expects, so changes are switched off. Reading still works. Check GitHub for an update."));
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
    if (ui.fatal) {
      el.listhead.replaceChildren();
      el.list.replaceChildren(h("div", { class: "loadmsg" }, ui.fatal, h("div", { style: "margin-top:12px" }, h("button", { class: "btn", type: "button", onclick: () => retryBoot() }, "Try again"))));
      return;
    }
    const loadingHere = Data.loading && (Data.loading.scope === "archived") === (ui.filters.scope === "archived");
    const rows = visibleChats();
    ui.order = rows.map((c) => c.id);
    ui.rowEls = new Map();

    if (loadingHere && !rows.length) {
      const L = Data.loading;
      el.listhead.replaceChildren();
      const text = L.message || (L.waiting
        ? `ChatGPT asked Triage to slow down while loading. Carrying on at ${fmtClock(Store.data.cooldownUntil)}. ${L.n} loaded so far.`
        : `Loading your chats… ${L.n}${L.total ? ` of about ${L.total}` : ""}`);
      el.list.replaceChildren(h("div", { class: "loadmsg" }, text));
      return;
    }

    renderListHead(rows);
    if (!rows.length) {
      const filtered = ui.filters.q || ui.filters.age || ui.filters.unread || ui.filters.untitled || ui.filters.marked;
      el.list.replaceChildren(h("div", { class: "loadmsg" }, filtered ? "No chats match these filters." : "No chats here.",
        filtered ? h("div", { style: "margin-top:12px" }, h("button", { class: "btn", type: "button", onclick: clearFilters }, "Clear filters")) : null));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const c of rows) {
      const row = rowEl(c);
      ui.rowEls.set(c.id, row);
      frag.append(row);
    }
    if (loadingHere) frag.append(h("div", { class: "loadmsg" }, Data.loading.waiting ? "Waiting for ChatGPT before loading the rest…" : `Loading more… ${Data.loading.n}${Data.loading.total ? ` of about ${Data.loading.total}` : ""}`));
    el.list.replaceChildren(frag);
    if (ui.focusId && !ui.rowEls.has(ui.focusId)) ui.focusId = null;
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
    const parts = [all, h("span", null, plural(rows.length, "chat"))];
    if (ui.sel.size) {
      const archivedScope = ui.filters.scope === "archived";
      parts.push(h("b", null, `· ${ui.sel.size} selected`), h("span", { class: "grow" }),
        bulkBtn("delete"),
        archivedScope ? bulkBtn("unarchive") : bulkBtn("archive"),
        h("button", { class: "btn small", type: "button", title: "Protect the selected chats (P)", onclick: () => applyAction("protect", selectedChats()) }, icon("shield", 14), "Protect"),
        h("button", { class: "btn small", type: "button", title: "Remove queued changes from the selected chats (C)", onclick: () => applyAction("clear", selectedChats()) }, "Clear marks"),
        h("button", { class: "btn small", type: "button", title: "Select the shown chats that aren't selected", onclick: invertSelection }, "Invert"),
        h("button", { class: "btn small", type: "button", onclick: () => { ui.sel.clear(); ui.renderList(); } }, "Select none"));
    } else {
      parts.push(h("span", { class: "grow" }), h("span", { class: "hint" }, "Click to read · Shift-click to select a range · ? for shortcuts"));
    }
    ui.el.listhead.replaceChildren(...parts);
  }

  function bulkBtn(action) {
    const a = ACTION[action];
    return h("button", { class: `btn small t-${action}`, type: "button", title: `${a.label} the selected chats (${a.key})`, onclick: () => applyAction(action, selectedChats()) }, icon(a.icon, 14), a.label);
  }

  function rowEl(c) {
    const d = Store.data;
    const mark = d.marks[c.id];
    const prot = Boolean(d.protect[c.id]);
    const cls = ["row"];
    if (c.id === ui.focusId) cls.push("focus");
    if (ui.sel.has(c.id)) cls.push("sel");
    if (d.seen[c.id]) cls.push("seen");
    if (mark) cls.push(`m-${mark.a}`);
    const badges = [];
    if (c.pinned) badges.push(h("span", { class: "badge", title: "Pinned" }, icon("pin", 11), "Pinned"));
    if (prot) badges.push(h("span", { class: "badge prot", title: "Protected: Triage won't change this chat" }, icon("shield", 11), "Protected"));
    if (c.projectId && ui.filters.scope !== "projects") badges.push(h("span", { class: "badge" }, "Project"));
    if (c.gptId) badges.push(h("span", { class: "badge", title: "Chat with a custom GPT" }, "GPT"));
    const cb = h("input", { type: "checkbox", class: "cb", tabindex: "-1", "aria-label": "Select", disabled: prot });
    cb.checked = ui.sel.has(c.id);
    const tag = mark ? h("span", { class: `tag ${mark.a}`, title: mark.a === "rename" ? `Rename to ${quote(mark.t)}` : "" },
      mark.a === "rename" ? `Rename → ${mark.t}` : ACTION[mark.a].label) : null;
    const acts = h("span", { class: "acts" },
      miniBtn(c.archived ? "unarchive" : "archive", mark && mark.a === (c.archived ? "unarchive" : "archive")),
      miniBtn("delete", mark && mark.a === "delete"),
      miniBtn("rename", mark && mark.a === "rename"),
      miniBtn("protect", prot));
    return h("div", { class: cls.join(" "), "data-id": c.id, role: "option", "aria-selected": String(c.id === ui.focusId) },
      cb,
      h("span", { class: "date", title: c.created ? new Date(c.created).toLocaleString() : "" }, fmtDate(c.created)),
      h("span", { class: "title", title: c.title || "Untitled" }, badges, c.title || "Untitled"),
      h("span", { class: "end" }, tag, acts));
  }

  function miniBtn(action, on) {
    const a = ACTION[action];
    const label = action === "protect" && on ? "Unprotect" : a.label;
    return h("button", { class: `mini${on ? " on" : ""}`, type: "button", tabindex: "-1", "data-act": action, title: `${label} (${a.key})`, "aria-label": label }, icon(a.icon, 15));
  }

  ui.renderReader = function renderReader() {
    const box = ui.el.reader;
    const c = ui.readerId ? Data.byId.get(ui.readerId) : null;
    if (!c) {
      box.replaceChildren(h("div", { class: "empty" }, h("div", null,
        h("div", { class: "big" }, Data.active.length || Data.archived.length ? "Pick a chat to read it here." : "Your chats will show up here."),
        h("div", { class: "small" },
          "Move with ", h("span", { class: "kbd" }, "↑"), " ", h("span", { class: "kbd" }, "↓"),
          ". Mark with ", h("span", { class: "kbd" }, "D"), " delete, ", h("span", { class: "kbd" }, "A"), " archive, ",
          h("span", { class: "kbd" }, "R"), " rename, ", h("span", { class: "kbd" }, "P"), " protect.", h("br"),
          "Nothing changes in ChatGPT until you press Run queue.", h("br"),
          "Press ", h("span", { class: "kbd" }, "?"), " for every shortcut."))));
      return;
    }
    const d = Store.data;
    const mark = d.marks[c.id];
    const prot = Boolean(d.protect[c.id]);
    const conv = cache.get(c.id);
    const meta = [
      `Created ${fmtDate(c.created, true)}`,
      c.updated ? `last used ${fmtDate(c.updated, true)}` : null,
      conv ? plural(conv.messages.length, "message") : null,
      c.projectId ? "in a project" : null,
      c.gptId ? "custom GPT" : null,
      c.pinned ? "pinned" : null,
      c.archived ? "archived" : null,
    ].filter(Boolean).join(" · ");
    let state = null;
    if (prot) state = h("div", { class: "rstate protect" }, "Protected. Triage won't change this chat.");
    else if (mark) state = h("div", { class: `rstate ${mark.a}` }, mark.a === "rename" ? `Queued: rename to ${quote(mark.t)}` : `Queued: ${ACTION[mark.a].label.toLowerCase()}`, mark.a === "delete" ? ". Deleting can't be undone." : ".");

    const actionBtn = (action) => {
      const a = ACTION[action];
      const on = action === "protect" ? prot : mark && mark.a === action;
      const label = action === "protect" ? (prot ? "Unprotect" : "Protect") : on ? `Unmark ${a.label.toLowerCase()}` : a.label;
      return h("button", { class: `btn small t-${action}${on ? " on" : ""}`, type: "button", title: `${label} (${a.key})`, onclick: () => applyAction(action, [c]) },
        icon(a.icon, 14), label, h("span", { class: "kbd" }, a.key));
    };
    const open = TEST.demo
      ? h("button", { class: "btn small", type: "button", onclick: () => ui.toast("In the demo, chats don't open in ChatGPT.") }, icon("external", 14), "Open in ChatGPT")
      : h("a", { class: "btn small", href: `/c/${encodeURIComponent(c.id)}`, target: "_blank", rel: "noopener noreferrer" }, icon("external", 14), "Open in ChatGPT");
    const head = h("div", { class: "rhead" },
      h("h2", { class: "rtitle" }, c.title || "Untitled"),
      h("div", { class: "rmeta" }, meta),
      state,
      h("div", { class: "ractions" },
        actionBtn("delete"), c.archived ? actionBtn("unarchive") : actionBtn("archive"), actionBtn("rename"), actionBtn("protect"), open));

    let body;
    const rs = ui.reader && ui.reader.id === c.id ? ui.reader : null;
    if (conv) {
      body = conv.messages.length
        ? conv.messages.map((m) => h("div", { class: `msg ${m.role}` }, h("div", { class: "who" }, m.role === "user" ? "You" : "ChatGPT"), h("div", { class: "txt" }, m.text)))
        : h("div", { class: "empty" }, "This chat has no text messages to show.");
    } else if (rs && rs.status === "error") {
      const e = rs.error || {};
      const text = e.kind === "cooldown" || e.kind === "ratelimit"
        ? `ChatGPT asked Triage to slow down. You can read chats again at ${fmtClock(Store.data.cooldownUntil)}.`
        : e.kind === "notfound" ? "This chat doesn't exist in ChatGPT any more." : `Couldn't load this chat. ${e.message || ""}`;
      body = h("div", { class: "empty" }, h("div", null, h("div", null, text), e.kind === "notfound" ? null : h("div", { style: "margin-top:12px" }, h("button", { class: "btn", type: "button", onclick: () => openReader(c.id, true) }, "Try again"))));
    } else {
      body = h("div", { class: "empty" }, "Loading chat…");
    }
    box.replaceChildren(head, h("div", { class: "msgs" }, body));
  };

  ui.renderStatus = function renderStatus() {
    if (!ui.el.status) return;
    const d = Store.data;
    const bits = [];
    if (Data.active.length || Data.archived.length) {
      bits.push(`Showing ${ui.order.length}`);
      const read = Object.keys(d.seen).filter((id) => Data.byId.has(id)).length;
      bits.push(`${read} read`);
      const prot = Object.keys(d.protect).length;
      if (prot) bits.push(`${prot} protected`);
    }
    const last = activity[activity.length - 1];
    if (last) bits.push(last.message);
    ui.el.status.textContent = bits.join(" · ");
  };

  ui.renderLauncher = function renderLauncher() {
    if (!ui.launcher) return;
    const r = ui.booted ? Store.data.run : null;
    let text = "Triage";
    let dot = null;
    if (r && ACTIVE.includes(r.status)) {
      dot = r.status === "waiting" ? "wait" : "go";
      text = r.status === "waiting" ? `Triage · waiting ${fmtDuration(Api.cooldownLeft())}` : `Triage · ${r.i} of ${r.jobs.length}`;
    } else if (r && r.status === "paused") {
      text = "Triage · paused";
      dot = "wait";
    } else if (r) {
      text = "Triage · finished";
    }
    ui.launcher.replaceChildren(dot ? h("span", { class: `dot${dot === "wait" ? " wait" : ""}` }) : icon("logo", 15), text);
  };

  ui.renderDrawer = function renderDrawer() {
    const el = ui.el;
    el.drawerEl.hidden = !ui.drawer;
    el.activityBtn.classList.toggle("on", ui.drawer === "activity");
    el.networkBtn.classList.toggle("on", ui.drawer === "network");
    if (!ui.drawer) return;
    const time = (t) => new Date(t).toLocaleTimeString();
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

  // The panel that covers everything while the queue runs.
  ui.renderRun = function renderRun(force) {
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
      return;
    }
    if (ui.lockedElsewhere) {
      if (ui.runSig !== "elsewhere") {
        ui.runSig = "elsewhere";
        ui.runEls = null;
        el.runLayer.replaceChildren(h("div", { class: "card" },
          h("h2", null, "Running in another tab"),
          h("div", { class: "sub" }, "Triage is working through a queue in another ChatGPT tab. Only one tab can run the queue at a time."),
          h("div", { class: "btns" }, h("button", { class: "btn", type: "button", onclick: recheckOtherTab }, "Check again"))));
      }
      return;
    }
    // Rebuild the card only when something meaningful changed, so buttons stay clickable.
    const sig = [r.status, r.i, r.results.length, r.note, r.current, r.nextAt ? 1 : 0, force === "rebuild" ? now() : 0].join("|");
    if (sig === ui.runSig && ui.runEls) {
      tickRun();
      return;
    }
    ui.runSig = sig;

    const total = r.jobs.length;
    const done = r.results.filter((x) => x.status === "done").length;
    const failed = r.results.filter((x) => x.status === "failed").length;
    const unconfirmed = r.results.filter((x) => x.status === "unconfirmed").length;
    const job = r.current ? r.jobs.find((j) => j.id === r.current) : null;
    const title = {
      backup: "Backing up before deleting",
      running: "Working through your queue",
      waiting: "Waiting for ChatGPT",
      verifying: "Double-checking",
      paused: "Paused",
      done: failed || unconfirmed ? "Finished, with a few problems" : "All done",
      stopped: "Stopped",
    }[r.status] || "Queue";

    let line = "";
    if (r.status === "backup") line = r.note;
    else if ((r.status === "running" || r.status === "waiting") && job) {
      const a = ACTION[job.action];
      line = r.nextAt || r.status === "waiting" ? `Next: ${a.label.toLowerCase()} ${quote(job.title)}` : `${a.verb} ${quote(job.title)}`;
      if (job.action === "rename") line += ` → ${quote(job.newTitle)}`;
    } else if (r.status === "verifying") line = r.note || "Double-checking with ChatGPT.";
    else if (r.status === "paused") line = `Paused at ${r.i} of ${total}. Nothing else changes until you resume.`;
    else if (r.status === "done" || r.status === "stopped") line = `${plural(done, "change")} made.`;

    const sub = h("div", { class: "sub" });
    const bar = h("i");
    bar.style.width = `${total ? Math.round((r.i / total) * 100) : 0}%`;
    const countBits = [h("span", null, `${r.i} of ${total}`), h("span", null, `${done} done`)];
    if (failed) countBits.push(h("span", { style: "color:var(--danger)" }, `${failed} failed`));
    if (unconfirmed) countBits.push(h("span", { style: "color:var(--amber)" }, `${unconfirmed} not confirmed`));

    const btns = [];
    if (ACTIVE.includes(r.status)) {
      btns.push(h("button", { class: "btn", type: "button", onclick: () => Runner.pause() }, "Pause"));
      btns.push(h("button", { class: "btn", type: "button", onclick: () => Runner.stop() }, "Stop"));
    } else if (r.status === "paused") {
      btns.push(h("button", { class: "btn primary", type: "button", disabled: ui.lockedElsewhere, onclick: () => Runner.resume() }, "Resume"));
      btns.push(h("button", { class: "btn", type: "button", onclick: () => Runner.stop() }, "Stop"));
    } else {
      btns.push(h("button", { class: "btn", type: "button", onclick: downloadReport }, icon("download", 14), "Report (CSV)"));
      if (Runner.backup.length) btns.push(h("button", { class: "btn", type: "button", onclick: () => download(`chatgpt-triage-backup-${fileStamp()}.json`, JSON.stringify(Runner.backup, null, 2), "application/json") }, icon("download", 14), "Backup (JSON)"));
      btns.push(h("button", { class: "btn primary", type: "button", onclick: () => Runner.dismiss() }, "Close"));
    }

    const issues = r.results.filter((x) => x.status !== "done");
    const issueBox = (r.status === "done" || r.status === "stopped" || r.status === "paused") && issues.length
      ? h("div", { class: "issues" }, issues.slice(-60).map((x) => h("div", null, h("b", null, `${ACTION[x.action].label} ${quote(x.title)}: `), x.note || x.status)))
      : null;
    const tip = ACTIVE.includes(r.status)
      ? h("div", { class: "tip" }, "Keep this tab open. You can close this panel and keep using ChatGPT; the button in the corner shows progress. Other ChatGPT tabs and the desktop app share the same limit, so close them if you can.")
      : r.status === "paused" && r.note ? h("div", { class: "tip" }, r.note) : null;

    const card = h("div", { class: "card", role: "status", "aria-live": "polite" },
      h("h2", null, title), h("div", { class: "line" }, line), sub,
      h("div", { class: "progress" }, bar), h("div", { class: "counts" }, countBits), issueBox,
      h("div", { class: "btns" }, btns), tip);
    el.runLayer.replaceChildren(card);
    ui.runEls = { sub, r };
    tickRun();
  };

  function tickRun() {
    const r = Store.data.run;
    if (!r || !ui.runEls) return;
    let text = "";
    if (r.status === "waiting" || (r.status === "backup" && Api.cooldownLeft() > 0)) {
      const left = Api.cooldownLeft();
      text = left > 0
        ? `ChatGPT asked Triage to slow down. Carrying on by itself at ${fmtClock(Store.data.cooldownUntil)} (${fmtDuration(left)} left).`
        : "Carrying on…";
    } else if (r.status === "running" && r.nextAt) {
      text = `in ${fmtDuration(r.nextAt - now())}`;
    } else if (r.status === "running" && r.note) {
      text = r.note;
    }
    ui.runEls.sub.textContent = text;
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
      if (e.key === "Escape" || (e.key === "Enter" && e.composedPath()[0] === ui.el.search) || (e.key === "ArrowDown" && e.composedPath()[0] === ui.el.search)) {
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
    const k = e.key;
    const handled = () => e.preventDefault();
    switch (k) {
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
    ui.modal.remove();
    ui.modal = null;
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
      h("p", null, `Currently: ${quote(c.title)}`),
      input,
      h("p", { style: "margin-top:10px;font-size:12.5px" }, "The new name is queued. ChatGPT only changes when you run the queue."),
    ], [
      ["Cancel"],
      ["Queue rename", "primary", () => {
        const t = input.value.trim();
        if (!t || t === c.title) delete Store.data.marks[c.id];
        else Store.data.marks[c.id] = { a: "rename", title: c.title, t, at: now() };
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
    const rows = [];
    for (const a of ["delete", "archive", "unarchive", "rename"]) {
      if (!n[a]) continue;
      rows.push(h("div", null, h("span", null, `${ACTION[a].label} ${plural(n[a], "chat")}`), a === "delete" ? h("span", { class: "perm" }, "Permanent. ChatGPT can't restore deleted chats.") : h("span", null)));
    }
    const backup = h("input", { type: "checkbox" });
    backup.checked = Store.data.settings.backup;
    const typed = h("input", { type: "text", placeholder: String(n.delete), "aria-label": "Type the number of chats to delete" });
    const body = [
      h("div", { class: "summary" }, rows),
      h("p", null, `One change every ${gap} seconds, so this takes about ${plural(minutes, "minute")}. If ChatGPT says "too many requests", Triage waits and carries on by itself.`),
    ];
    if (n.delete) {
      body.push(h("div", { class: "field" }, h("label", null, backup, h("span", null, `Save a backup of the ${plural(n.delete, "chat")} being deleted first`)),
        h("div", { class: "help" }, "Downloads one Markdown file before anything is deleted. It adds a little time.")));
    }
    if (n.delete >= CFG.typeToConfirm) {
      body.push(h("div", { class: "field" }, h("div", { class: "help flush", style: "margin-bottom:6px;color:var(--fg)" }, `Type ${n.delete} to confirm deleting ${n.delete} chats.`), typed));
    }
    body.push(h("p", { style: "font-size:12.5px" }, "Tip: close other ChatGPT tabs and the ChatGPT desktop app while this runs. They count against the same limit."));
    const box = modal("Run the queue?", body, [
      ["Cancel"],
      [`Run ${plural(jobs.length, "change")}`, "primary", () => {
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
    const danger = (label, fn) => h("button", { class: "btn small", type: "button", onclick: fn }, label);
    modal("Settings", [
      h("div", { class: "field" }, h("div", { class: "inline" }, h("span", null, "Wait between changes"), gap, h("span", null, "seconds")),
        h("div", { class: "help flush" }, `Slower is safer. Minimum ${CFG.gapMin}, default ${CFG.gapDefault}. After a "too many requests", Triage also waits however long ChatGPT asks.`)),
      h("div", { class: "field" }, h("label", null, backup, h("span", null, "Back up chats before deleting them")),
        h("div", { class: "help" }, "Saves a Markdown file of the chats in the delete queue before anything is deleted.")),
      h("div", { class: "field" }, h("label", null, pinned, h("span", null, "Include pinned chats in select all")),
        h("div", { class: "help" }, "Off by default, so select all never picks up pinned chats.")),
      h("div", { class: "sep" }),
      h("div", { class: "stack" },
        danger("Download chat list (CSV)", exportList),
        danger("Clear all marks", () => resetState("marks", "Clear every queued change?")),
        danger("Forget what I've read", () => resetState("seen", "Mark every chat as unread again?")),
        danger("Unprotect everything", () => resetState("protect", "Remove protection from every chat?"))),
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
      ["↑ ↓ or J K", "Move through the list. The chat opens on the right."],
      ["Shift + ↑ ↓", "Select as you move"],
      ["Space or X", "Select or unselect"],
      ["Shift-click", "Select a range"],
      ["D", "Queue delete, then move on"],
      ["A", "Queue archive (unarchive in Archived)"],
      ["R", "Queue a new name"],
      ["P", "Protect. Protected chats can't be queued."],
      ["C", "Clear the queued change"],
      ["/", "Search"],
      ["Esc", "Clear the selection"],
      ["Alt + Shift + T", "Open or close Triage"],
    ];
    modal("How Triage works", [
      h("p", null, "Read your chats, queue what should happen to each one, then run the queue. ChatGPT doesn't change until you press Run queue, and your marks are saved in this browser."),
      h("div", { class: "keys" }, keys.map(([k, v]) => [h("span", null, k.split(" ").map((part) => (part === "or" || part === "+" ? ` ${part} ` : h("span", { class: "kbd" }, part)))), h("span", null, v)])),
      h("p", null, h("b", null, "Staying under ChatGPT's limit. "), "Triage makes one change at a time with a pause between each. If ChatGPT says \"too many requests\", Triage stops every request, waits as long as ChatGPT asks (or longer each time if it doesn't say), then carries on with the same chat."),
      h("p", null, h("b", null, "Safety. "), "Project and pinned chats are left out of Main and select all. Deleting can be backed up first, and big deletes ask you to type the number. At the end, Triage reloads your list to check the changes stuck."),
      h("p", null, h("b", null, "Privacy. "), "Triage runs in your browser and only talks to chatgpt.com. The Network button shows every request it sends."),
      h("p", { style: "font-size:12.5px" }, `Version ${VERSION}. `, h("a", { href: HOMEPAGE, target: "_blank", rel: "noopener noreferrer" }, "Source code and updates on GitHub"), ". Not affiliated with OpenAI."),
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
    ui.toastTimer = setTimeout(() => t.remove(), 3400);
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
  // Clock: countdowns, heartbeat, banners
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
      if (r) ui.renderRun(false);
      if (cooling || hadCooldown) {
        const cd = ui.el.banners.querySelector("[data-countdown]");
        if (cd && cooling) cd.textContent = fmtDuration(Api.cooldownLeft());
        else ui.renderBanners();
        if (!cooling) ui.renderTop();
      }
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
