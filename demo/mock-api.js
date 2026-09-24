/*
 * A fake ChatGPT backend for the Triage demo and tests.
 *
 * It patches window.fetch so requests to /api/auth/session and /backend-api/*
 * are answered locally with made-up chats. Nothing leaves the page.
 * The response shapes mirror what chatgpt.com returns, as far as Triage uses them.
 *
 * URL options (on the demo page):
 *   ?ratelimit=on        answer 429 when more than `max` requests arrive within `window` seconds
 *   ?ratelimit=noheader  same, but without a Retry-After header
 *   &max=6&window=20     limiter settings (defaults 8 requests per 30 s)
 *   ?expire=30           rotate the access token every 30 s, so stale tokens get 401
 *   ?fail=0.2            make 20% of changes fail with HTTP 500
 *   ?ghost=0.3           make 30% of changes report success but not take effect
 */
(function mockChatGPT() {
  "use strict";

  const DB_KEY = "triage-demo:db";
  const WIPE_KEY = "triage-demo:wipe";
  const params = new URLSearchParams(location.search);

  function forgetTriage() {
    for (const k of Object.keys(localStorage)) if (k.startsWith("chatgpt-triage:")) localStorage.removeItem(k);
    try { sessionStorage.removeItem("chatgpt-triage:tab"); } catch { /* ignore */ }
  }
  try {
    if (sessionStorage.getItem(WIPE_KEY)) {
      sessionStorage.removeItem(WIPE_KEY);
      forgetTriage();
    }
  } catch { /* ignore */ }
  const RATE = params.get("ratelimit");
  const RATE_MAX = Number(params.get("max")) || 8;
  const RATE_WINDOW = (Number(params.get("window")) || 30) * 1000;
  const EXPIRE = (Number(params.get("expire")) || 0) * 1000;
  const FAIL = Math.min(1, Number(params.get("fail")) || 0);
  // ?ghost=0.3 makes 30% of changes report success without taking effect (like chats that reappear).
  const GHOST = Math.min(1, Number(params.get("ghost")) || 0);

  const stats = { requests: 0, limited: 0, unauthorized: 0, failed: 0, byPath: {} };
  const recent = [];

  // Deterministic random numbers, so every visitor gets the same demo account.
  function rng(seed) {
    return function next() {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const TOPICS = [
    "Sourdough starter not rising", "Explain Kubernetes like I'm five", "Birthday message for a coworker",
    "Regex to validate email addresses", "Four days in Lisbon itinerary", "Fix: npm ERR! peer dependency",
    "Cover letter for a product role", "Why is my monstera turning yellow", "Summarise this meeting transcript",
    "Weekly meal prep, high protein", "SQL join vs subquery performance", "Name ideas for a coffee cart",
    "Convert Celsius to Fahrenheit in Python", "How do index funds work", "Rewrite this email to sound friendlier",
    "Chess opening for beginners", "Explain the Monty Hall problem", "Bash script to rename photos by date",
    "Best way to learn Spanish in 6 months", "Draft a landlord repair request", "Pros and cons of standing desks",
    "Wedding toast for my sister", "What's a good first telescope", "React useEffect runs twice",
    "Plan a 5k training schedule", "Explain compound interest with an example", "Resignation letter, polite",
    "Git: undo the last commit", "Houseplants that survive low light", "Write a haiku about Mondays",
    "Compare Postgres and MySQL", "How to negotiate a raise", "Kids' science fair ideas",
    "Translate this menu from Italian", "Budget spreadsheet formulas", "Dockerfile for a Node app",
    "Explain black holes simply", "Thank-you note after an interview", "Tips for better sleep",
    "Excel: VLOOKUP returns #N/A", "Fantasy novel plot outline", "How does HTTPS actually work",
    "Road trip playlist ideas", "Car makes a clicking noise when turning", "Explain the French Revolution briefly",
    "Python list comprehension examples", "Dog keeps barking at night", "LinkedIn headline suggestions",
    "Birthday party games for 8-year-olds", "What is a Roth IRA", "Clean up this CSV with pandas",
    "Speech for a retirement party", "Explain vectors and dot products", "Fix leaking kitchen tap",
    "Instagram caption for a beach photo", "TypeScript generics explained", "How to start journaling",
    "Grocery list for a dinner party", "Linux permissions: chmod 755", "Write a limerick about cats",
    "Explain inflation to a teenager", "Study plan for AWS certification", "Garden layout for tomatoes",
    "Apology message to a friend", "What is quantum entanglement", "CSS grid vs flexbox",
    "Home workout without equipment", "Prepare for a behavioural interview", "Photography tips for sunsets",
    "Explain the stock market crash of 1929", "Rust borrow checker error", "Rainy day activities in London",
    "Improve my resume summary", "How to brew pour-over coffee", "Explain machine learning in plain words",
  ];
  const PROJECTS = [
    { id: "g-p-demo-thesis", name: "Thesis", topics: ["Thesis: literature review outline", "Thesis: methods section feedback", "Thesis: citation formatting", "Thesis: abstract draft", "Thesis: defence practice questions"] },
    { id: "g-p-demo-renovation", name: "Home renovation", topics: ["Renovation: kitchen budget", "Renovation: choosing floor tiles", "Renovation: contractor questions", "Renovation: paint colours for north rooms"] },
  ];
  const GPTS = ["g-demo-code-helper", "g-demo-travel-planner"];

  function makeDb() {
    const r = rng(20260924);
    const pick = (arr) => arr[Math.floor(r() * arr.length)];
    const start = Date.UTC(2023, 2, 1) / 1000;
    const end = Date.UTC(2026, 8, 20) / 1000;
    const convs = [];
    let n = 0;
    const add = (title, extra = {}) => {
      n += 1;
      const created = start + r() * (end - start);
      const updated = Math.min(end + 86400, created + r() * 86400 * 60);
      const id = `demo-${String(n).padStart(4, "0")}-${Math.floor(r() * 0xffffff).toString(16)}`;
      convs.push({
        id, title, created, updated,
        gizmo_id: null, conversation_template_id: null,
        is_visible: true, is_archived: false, pinned_time: null,
        turns: 1 + Math.floor(r() * 5),
        ...extra,
      });
    };
    const lowerFirst = (t) => (/^[A-Z][A-Z]/.test(t) ? t : `${t.charAt(0).toLowerCase()}${t.slice(1)}`);
    const variant = (t, i) => (i === 0 ? t : i === 1 ? `${t}, follow-up` : `Quick question: ${lowerFirst(t)}`);
    for (let i = 0; i < 3; i += 1) for (const t of TOPICS) add(variant(t, i));
    for (let i = 0; i < 9; i += 1) add("New chat");
    for (const p of PROJECTS) for (const t of p.topics) for (let k = 0; k < 4; k += 1) {
      add(k === 0 ? t : `${t} ${k + 1}`, { gizmo_id: p.id, conversation_template_id: p.id });
    }
    for (let i = 0; i < 12; i += 1) {
      const g = pick(GPTS);
      add(g.includes("code") ? `Code review ${i + 1}` : `Trip idea ${i + 1}`, { gizmo_id: g });
    }
    // A few pinned chats and some that are already archived.
    for (let i = 0; i < 3; i += 1) convs[Math.floor(r() * 200)].pinned_time = new Date((end - i * 86400) * 1000).toISOString();
    for (let i = 0; i < 18; i += 1) convs[200 + i].is_archived = true;
    return { version: 1, token: "demo-token-1", tokenIssued: Date.now(), convs };
  }

  function load() {
    try {
      const db = JSON.parse(localStorage.getItem(DB_KEY) || "null");
      return db && db.version === 1 ? db : null;
    } catch {
      return null;
    }
  }
  let db = load() || makeDb();
  const save = () => { try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch { /* demo only */ } };
  save();

  const iso = (sec) => new Date(sec * 1000).toISOString();
  const find = (id) => db.convs.find((c) => c.id === id && c.is_visible);

  function listItem(c) {
    return {
      id: c.id,
      title: c.title,
      create_time: iso(c.created),
      update_time: iso(c.updated),
      mapping: null,
      current_node: null,
      conversation_template_id: c.conversation_template_id,
      gizmo_id: c.gizmo_id,
      is_archived: c.is_archived,
      is_starred: null,
      is_do_not_remember: false,
      pinned_time: c.pinned_time,
      snippet: null,
      workspace_id: null,
      async_status: null,
    };
  }

  const LINES = [
    "Here's a clear way to think about it.",
    "Short answer: yes, with a couple of caveats.",
    "Let's break this into three steps.",
    "Good question. The key idea is simpler than it sounds.",
    "Here's a draft you can adapt.",
    "A few options, from easiest to most thorough:",
  ];

  function detail(c) {
    const r = rng(c.id.split("").reduce((a, ch) => a + ch.charCodeAt(0), 0));
    const mapping = { root: { id: "root", message: null, parent: null, children: ["sys"] } };
    mapping.sys = {
      id: "sys", parent: "root", children: [],
      message: { id: "sys", author: { role: "system" }, create_time: c.created, content: { content_type: "text", parts: [""] }, metadata: { is_visually_hidden_from_conversation: true } },
    };
    let prev = "sys";
    let t = c.created;
    const topic = c.title === "New chat" ? "something I was curious about" : c.title.toLowerCase();
    for (let i = 0; i < c.turns; i += 1) {
      const u = `u${i}`;
      const a = `a${i}`;
      t += 20 + r() * 200;
      const userParts = i === 0
        ? [`Can you help me with this: ${topic}?`]
        : [`Thanks. Can you go a bit deeper on point ${1 + Math.floor(r() * 3)}?`];
      if (i === 1 && r() > 0.6) userParts.unshift({ content_type: "image_asset_pointer", asset_pointer: "file-service://demo" });
      mapping[u] = {
        id: u, parent: prev, children: [a],
        message: { id: u, author: { role: "user" }, create_time: t, content: { content_type: i === 1 ? "multimodal_text" : "text", parts: userParts }, metadata: {} },
      };
      mapping[prev].children.push(u);
      t += 5 + r() * 30;
      const body = [
        LINES[Math.floor(r() * LINES.length)],
        "",
        `1. Start with the basics of ${topic}.`,
        "2. Check the part that usually goes wrong.",
        "3. Keep what works and drop the rest.",
        "",
        "This is demo text. None of these chats are real.",
      ].join("\n");
      mapping[a] = {
        id: a, parent: u, children: [],
        message: { id: a, author: { role: "assistant" }, create_time: t, content: { content_type: "text", parts: [body] }, metadata: {} },
      };
      prev = a;
    }
    return {
      title: c.title,
      create_time: c.created,
      update_time: c.updated,
      mapping,
      current_node: prev,
      conversation_id: c.id,
      is_archived: c.is_archived,
      gizmo_id: c.gizmo_id,
      conversation_template_id: c.conversation_template_id,
    };
  }

  function json(status, body, headers = {}) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
  }

  function currentToken() {
    if (EXPIRE && Date.now() - db.tokenIssued > EXPIRE) {
      const n = Number(db.token.split("-").pop()) + 1;
      db.token = `demo-token-${n}`;
      db.tokenIssued = Date.now();
      save();
    }
    return db.token;
  }

  function limited() {
    if (!RATE) return null;
    const t = Date.now();
    while (recent.length && t - recent[0] > RATE_WINDOW) recent.shift();
    if (recent.length >= RATE_MAX) {
      const wait = Math.ceil((recent[0] + RATE_WINDOW - t) / 1000);
      return Math.max(1, wait);
    }
    recent.push(t);
    return null;
  }

  async function route(url, init) {
    const method = (init.method || "GET").toUpperCase();
    const path = url.pathname;
    stats.requests += 1;
    const key = `${method} ${path.replace(/demo-[\w-]+/, ":id")}`;
    stats.byPath[key] = (stats.byPath[key] || 0) + 1;

    if (path === "/api/auth/session") {
      return json(200, { user: { id: "user-demo", name: "Demo" }, accessToken: currentToken(), expires: new Date(Date.now() + 864e5).toISOString() });
    }

    const auth = new Headers(init.headers || {}).get("Authorization");
    if (auth !== `Bearer ${currentToken()}`) {
      stats.unauthorized += 1;
      return json(401, { detail: "Unauthorized" });
    }

    const wait = limited();
    if (wait !== null) {
      stats.limited += 1;
      return json(429, { detail: "Too many requests" }, RATE === "noheader" ? {} : { "Retry-After": String(wait) });
    }

    if (method === "GET" && path === "/backend-api/conversations") {
      const offset = Number(url.searchParams.get("offset")) || 0;
      const limit = Math.min(100, Number(url.searchParams.get("limit")) || 28);
      const archived = url.searchParams.get("is_archived") === "true";
      const rows = db.convs
        .filter((c) => c.is_visible && c.is_archived === archived)
        .sort((a, b) => b.updated - a.updated);
      return json(200, { items: rows.slice(offset, offset + limit).map(listItem), total: rows.length, limit, offset, has_missing_conversations: false });
    }

    const m = path.match(/^\/backend-api\/conversation\/([^/]+)$/);
    if (m) {
      const c = find(decodeURIComponent(m[1]));
      if (!c) return json(404, { detail: "Can't load conversation" });
      if (method === "GET") return json(200, detail(c));
      if (method === "PATCH") {
        if (FAIL && Math.random() < FAIL) {
          stats.failed += 1;
          return json(500, { detail: "Simulated server error" });
        }
        if (GHOST && Math.random() < GHOST) return json(200, { success: true });
        const body = JSON.parse(init.body || "{}");
        if (body.is_visible === false) c.is_visible = false;
        if (typeof body.is_archived === "boolean") c.is_archived = body.is_archived;
        if (typeof body.title === "string") c.title = body.title;
        c.updated = Date.now() / 1000;
        save();
        return json(200, { success: true });
      }
    }
    return json(404, { detail: "Not found" });
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async function demoFetch(input, init = {}) {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    const ours = url.origin === location.origin && (url.pathname === "/api/auth/session" || url.pathname.startsWith("/backend-api/"));
    if (!ours) return realFetch(input, init);
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 180));
    return route(url, init);
  };

  window.__triageDemo = {
    stats,
    get db() { return db; },
    reset() {
      db = makeDb();
      save();
      forgetTriage();
      // Triage saves its state as the page unloads, so wipe it again on the next load too.
      try { sessionStorage.setItem(WIPE_KEY, "1"); } catch { /* ignore */ }
    },
    visible() { return db.convs.filter((c) => c.is_visible); },
  };
})();
