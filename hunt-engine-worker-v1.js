const ALLOWED_ORIGINS = new Set([
  "https://kimmymaltais-sys.github.io",
]);

const COUNTRY_TO_ADZUNA = {
  CA: "ca",
  US: "us",
  GB: "gb",
  AU: "au",
  NZ: "nz",
};

function corsHeaders(origin) {
  const headers = {
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(data, status = 200, origin = "") {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(origin),
    },
  });
}

function cleanText(value, max = 300) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function safeCountry(value) {
  const country = String(value || "CA").toUpperCase();
  return /^[A-Z]{2}$/.test(country) ? country : "CA";
}

function safeWork(work) {
  if (!Array.isArray(work)) return [];
  return work.map((x) => cleanText(x, 60)).filter(Boolean).slice(0, 14);
}

function hostnameFromUrl(value) {
  try { return new URL(value).hostname.replace(/^www\./, ""); }
  catch { return ""; }
}

const ROUTE_ONLY = [
  "local gig","same day pay","paid research study","user testing paid",
  "temporary shift","freelance one off task","event staff daily pay",
  "moving cleanup helper cash"
];

function isRouteOnly(term) {
  const t = String(term || "").toLowerCase();
  return ROUTE_ONLY.some(x => t.includes(x)) ||
    /paid research|user testing|same day pay|freelance one off|local gig/.test(t);
}

function jobTerms(payload) {
  const chosen = payload.work.filter(x => !isRouteOnly(x));
  return chosen.length ? chosen : [
    "general labour","moving helper","cleaner","warehouse","delivery driver","event staff"
  ];
}

function buildJobQueries(payload) {
  const terms = jobTerms(payload);
  if (payload.lane !== "quick") return [terms.slice(0, 3).join(" ")];

  const first = terms.slice(0, 3).join(" ");
  const second = terms.slice(3, 6).join(" ") || "event staff moving helper cleaner";
  return [
    `${first} temporary casual immediate start`,
    `${second} temporary casual immediate start`,
  ];
}

function braveQueries(payload) {
  const place = payload.location ? `"${payload.location}"` : "";
  const countryName = {
    CA: "Canada", US: "United States", GB: "United Kingdom",
    AU: "Australia", NZ: "New Zealand"
  }[payload.country] || payload.country;
  const terms = jobTerms(payload).slice(0, 5).map(x => `"${x}"`).join(" OR ");

  return [
    {
      className: "local_fast_cash",
      q: `(${terms || '"general labour" OR "moving helper"'}) ${place} ("same day pay" OR "daily pay" OR "paid after shift" OR "cash on completion" OR "next day pay" OR "instant pay") (gig OR shift OR helper OR temporary)`,
      freshness: "pm",
    },
    {
      className: "research_testing",
      q: `("paid research study" OR "paid focus group" OR "research participant" OR "user testing" OR "usability study") ${place} ${countryName} (paid OR compensation OR honorarium)`,
      freshness: "pm",
    },
    {
      className: "one_off_tasks",
      q: `("one-off task" OR "one off gig" OR "day labour" OR "day labor" OR "event staff" OR "moving help" OR "cleanup help") ${place} (paid OR pay OR cash OR compensation)`,
      freshness: "pm",
    },
  ];
}

function normalizeJooble(j, searchClass = "job_fast_start") {
  return {
    title: cleanText(j.title, 160) || "Untitled job",
    company: cleanText(j.company || j.source, 120) || "Employer",
    location: cleanText(j.location, 120),
    salary: cleanText(j.salary, 80),
    type: cleanText(j.type, 60),
    snippet: cleanText(j.snippet, 800),
    link: String(j.link || ""),
    updated: cleanText(j.updated, 80),
    sourceName: "Jooble",
    sourceType: "job_api",
    searchClass,
  };
}

function normalizeAdzuna(j, searchClass = "job_fast_start") {
  const location =
    j?.location?.display_name ||
    (Array.isArray(j?.location?.area) ? j.location.area.join(", ") : "");

  let salary = "";
  const min = Number(j.salary_min);
  const max = Number(j.salary_max);
  if (Number.isFinite(min) || Number.isFinite(max)) {
    const a = Number.isFinite(min) ? min : max;
    const b = Number.isFinite(max) ? max : min;
    salary =
      Math.max(a, b) > 1000
        ? `$${Math.round(a).toLocaleString()}–$${Math.round(b).toLocaleString()} per year`
        : `$${Number(a).toFixed(2)}–$${Number(b).toFixed(2)} per hour`;
  }

  return {
    title: cleanText(j.title, 160) || "Untitled job",
    company: cleanText(j?.company?.display_name, 120) || "Employer",
    location: cleanText(location, 120),
    salary,
    type: "",
    snippet: cleanText(j.description, 800),
    link: String(j.redirect_url || ""),
    updated: cleanText(j.created, 80),
    sourceName: "Adzuna",
    sourceType: "job_api",
    searchClass,
  };
}

function normalizeBrave(r, searchClass) {
  const url = String(r.url || "");
  return {
    title: cleanText(r.title, 160) || "Web opportunity",
    company: hostnameFromUrl(url),
    location: "",
    salary: "",
    type: "Public web result",
    snippet: cleanText(r.description, 800),
    link: url,
    updated: cleanText(r.age || r.page_age, 80),
    sourceName: "Brave Web",
    sourceType: "web_search",
    searchClass,
  };
}

function dedupe(items) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const cleanLink = String(item.link || "").replace(/[?#].*$/, "").toLowerCase();
    const key = cleanLink || `${item.title}|${item.company}|${item.location}`.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

async function searchJoobleOne(env, payload, query) {
  if (!env.JOOBLE_API_KEY || payload.country !== "CA") return [];
  const response = await fetch(
    "https://ca.jooble.org/api/" + encodeURIComponent(env.JOOBLE_API_KEY),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keywords: query,
        location: payload.location,
        radius: String(payload.radiusKm || 25),
        page: 1,
        ResultOnPage: 12,
        SearchMode: 1,
      }),
    }
  );
  if (!response.ok) throw new Error(`Jooble HTTP ${response.status}`);
  const data = await response.json();
  return (data.jobs || []).map(j => normalizeJooble(j));
}

async function searchJooble(env, payload) {
  const queries = buildJobQueries(payload);
  const chunks = await Promise.all(queries.map(q => searchJoobleOne(env, payload, q)));
  return dedupe(chunks.flat());
}

async function searchAdzunaOne(env, payload, query) {
  if (!env.ADZUNA_APP_ID || !env.ADZUNA_APP_KEY) return [];
  const market = COUNTRY_TO_ADZUNA[payload.country];
  if (!market) return [];

  const url = new URL(`https://api.adzuna.com/v1/api/jobs/${market}/search/1`);
  url.searchParams.set("app_id", env.ADZUNA_APP_ID);
  url.searchParams.set("app_key", env.ADZUNA_APP_KEY);
  url.searchParams.set("results_per_page", "12");
  url.searchParams.set("what", query);
  if (payload.location) url.searchParams.set("where", payload.location);
  url.searchParams.set("content-type", "application/json");

  const response = await fetch(url.toString(), { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Adzuna HTTP ${response.status}`);
  const data = await response.json();
  return (data.results || []).map(j => normalizeAdzuna(j));
}

async function searchAdzuna(env, payload) {
  const queries = buildJobQueries(payload);
  const chunks = await Promise.all(queries.map(q => searchAdzunaOne(env, payload, q)));
  return dedupe(chunks.flat());
}

async function searchBraveOne(env, payload, spec) {
  const response = await fetch("https://api.search.brave.com/res/v1/web/search", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Subscription-Token": env.BRAVE_API_KEY,
    },
    body: JSON.stringify({
      q: spec.q,
      country: payload.country,
      search_lang: "en",
      count: 10,
      safesearch: "moderate",
      freshness: spec.freshness,
    }),
  });
  if (!response.ok) throw new Error(`Brave HTTP ${response.status}`);
  const data = await response.json();
  return (data?.web?.results || []).map(r => normalizeBrave(r, spec.className));
}

async function searchBrave(env, payload) {
  if (!env.BRAVE_API_KEY || payload.lane !== "quick") return [];
  const specs = braveQueries(payload);
  const chunks = await Promise.all(specs.map(spec => searchBraveOne(env, payload, spec)));
  return dedupe(chunks.flat());
}

async function runProvider(name, fn) {
  try {
    const items = await fn();
    return { name, ok: true, items, error: null };
  } catch (error) {
    return { name, ok: false, items: [], error: String(error?.message || error) };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      if (!ALLOWED_ORIGINS.has(origin)) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return json({
        ok: true,
        service: "hunt-engine-api",
        version: "1.0-search",
        providers: {
          brave: Boolean(env.BRAVE_API_KEY),
          jooble: Boolean(env.JOOBLE_API_KEY),
          adzuna: Boolean(env.ADZUNA_APP_ID) && Boolean(env.ADZUNA_APP_KEY),
        },
      }, 200, origin);
    }

    if (url.pathname !== "/hunt" || request.method !== "POST") {
      return json({
        ok: true,
        message: "Hunt Engine API is running.",
        endpoints: ["GET /health", "POST /hunt"],
      }, 200, origin);
    }

    if (!ALLOWED_ORIGINS.has(origin)) {
      return json({ ok: false, error: "Origin not allowed" }, 403, origin);
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ ok: false, error: "Invalid JSON body" }, 400, origin); }

    const payload = {
      lane: body.lane === "steady" ? "steady" : "quick",
      goal: Math.max(0, Number(body.goal) || 0),
      deadlineDays: Math.min(30, Math.max(1, Number(body.deadlineDays) || 3)),
      paySpeed: cleanText(body.paySpeed, 20) || "3_days",
      country: safeCountry(body.country),
      location: cleanText(body.location, 100),
      radiusKm: Math.min(100, Math.max(1, Number(body.radiusKm) || 25)),
      work: safeWork(body.work),
      notes: cleanText(body.notes, 300),
    };

    if (!payload.location) {
      return json({ ok: false, error: "Location is required" }, 400, origin);
    }

    const tasks = [
      runProvider("Jooble", () => searchJooble(env, payload)),
      runProvider("Adzuna", () => searchAdzuna(env, payload)),
    ];
    if (payload.lane === "quick") {
      tasks.push(runProvider("Brave Web", () => searchBrave(env, payload)));
    }

    const providerResults = await Promise.all(tasks);
    const results = dedupe(providerResults.flatMap(x => x.items)).slice(0, 80);

    return json({
      ok: true,
      generatedAt: new Date().toISOString(),
      query: payload,
      providers: providerResults.map(x => ({
        name: x.name,
        ok: x.ok,
        count: x.items.length,
        error: x.error,
      })),
      count: results.length,
      results,
      notices: [
        "Open the original source before relying on a listing.",
        "Web-search results are discovery leads, not verification.",
        "Only explicit start and payout evidence should count toward an urgent cash goal.",
      ],
    }, 200, origin);
  },
};
