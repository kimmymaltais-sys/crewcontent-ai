const ALLOWED = "https://kimmymaltais-sys.github.io";
const ADZUNA = { CA:"ca", US:"us", GB:"gb", AU:"au", NZ:"nz" };

const clean = (v,n=500) => String(v ?? "")
  .replace(/<[^>]*>/g," ")
  .replace(/&nbsp;/gi," ")
  .replace(/\s+/g," ")
  .trim()
  .slice(0,n);

const cors = o => ({
  "Access-Control-Allow-Origin": o===ALLOWED ? o : "null",
  "Access-Control-Allow-Methods":"GET,POST,OPTIONS",
  "Access-Control-Allow-Headers":"Content-Type",
  "Vary":"Origin"
});

const reply = (data,status=200,origin="") =>
  new Response(JSON.stringify(data),{
    status,
    headers:{
      "Content-Type":"application/json",
      ...cors(origin)
    }
  });

const work = b =>
  Array.isArray(b.work)
    ? b.work.map(x=>clean(x,50)).filter(Boolean).slice(0,6)
    : [];

const jq = p =>
  `${p.work[0] || "general labour"}${
    p.lane==="quick" ? " temporary casual immediate start" : ""
  }`;

const bq = p => {
  const jobs = p.work.length
    ? p.work.slice(0,4).map(x=>`"${x}"`).join(" OR ")
    : '"general labour" OR warehouse OR moving OR cleaner OR delivery';

  return `(${jobs}) "${p.location}" ("same day pay" OR "daily pay" OR "paid after shift" OR "cash on completion" OR "next day pay" OR "instant pay" OR "immediate start") (job OR shift OR gig)`;
};

const dedupe = rows => {
  const seen = new Set();
  return rows.filter(x=>{
    const k = (x.link || `${x.title}|${x.company}`).toLowerCase();
    if(!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

async function jooble(env,p){
  if(!env.JOOBLE_API_KEY || p.country!=="CA") return [];

  const r = await fetch(
    "https://ca.jooble.org/api/" + encodeURIComponent(env.JOOBLE_API_KEY),
    {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        keywords:jq(p),
        location:p.location,
        radius:String(p.radiusKm),
        page:1,
        ResultOnPage:20,
        SearchMode:1
      })
    }
  );

  if(!r.ok) throw new Error(`Jooble ${r.status}`);

  const d = await r.json();

  return (d.jobs||[]).map(j=>({
    title:clean(j.title,160),
    company:clean(j.company||j.source,120)||"Employer",
    location:clean(j.location,120),
    salary:clean(j.salary,80),
    type:clean(j.type,60),
    snippet:clean(j.snippet,700),
    link:String(j.link||""),
    sourceName:"Jooble"
  }));
}

async function adzuna(env,p){
  if(!env.ADZUNA_APP_ID || !env.ADZUNA_APP_KEY || !ADZUNA[p.country]){
    return [];
  }

  const u = new URL(
    `https://api.adzuna.com/v1/api/jobs/${ADZUNA[p.country]}/search/1`
  );

  u.searchParams.set("app_id",env.ADZUNA_APP_ID);
  u.searchParams.set("app_key",env.ADZUNA_APP_KEY);
  u.searchParams.set("results_per_page","20");
  u.searchParams.set("what",jq(p));
  u.searchParams.set("where",p.location);
  u.searchParams.set("content-type","application/json");

  const r = await fetch(u,{
    headers:{Accept:"application/json"}
  });

  if(!r.ok) throw new Error(`Adzuna ${r.status}`);

  const d = await r.json();

  return (d.results||[]).map(j=>({
    title:clean(j.title,160),
    company:clean(j?.company?.display_name,120)||"Employer",
    location:clean(j?.location?.display_name,120),
    salary:"",
    type:"",
    snippet:clean(j.description,700),
    link:String(j.redirect_url||""),
    sourceName:"Adzuna"
  }));
}

async function brave(env,p){
  if(!env.BRAVE_API_KEY || p.lane!=="quick") return [];

  const u = new URL(
    "https://api.search.brave.com/res/v1/web/search"
  );

  u.searchParams.set("q",bq(p));
  u.searchParams.set("country",p.country);
  u.searchParams.set("search_lang","en");
  u.searchParams.set("count","20");
  u.searchParams.set("safesearch","moderate");
  u.searchParams.set("freshness","pw");

  const r = await fetch(u,{
    headers:{
      Accept:"application/json",
      "X-Subscription-Token":env.BRAVE_API_KEY
    }
  });

  if(!r.ok) throw new Error(`Brave ${r.status}`);

  const d = await r.json();

  return (d?.web?.results||[]).map(j=>({
    title:clean(j.title,160),
    company:(()=>{
      try{
        return new URL(j.url).hostname.replace(/^www\./,"");
      }catch{
        return "";
      }
    })(),
    location:"",
    salary:"",
    type:"Public web result",
    snippet:clean(j.description,700),
    link:String(j.url||""),
    sourceName:"Brave Web"
  }));
}

async function source(name,fn){
  try{
    const items = await fn();
    return {
      name,
      ok:true,
      count:items.length,
      items
    };
  }catch(e){
    return {
      name,
      ok:false,
      count:0,
      error:String(e.message||e),
      items:[]
    };
  }
}

export default {
  async fetch(request,env){
    const u = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if(request.method==="OPTIONS"){
      return origin===ALLOWED
        ? new Response(null,{status:204,headers:cors(origin)})
        : new Response(null,{status:403});
    }

    if(u.pathname==="/health"){
      return reply({
        ok:true,
        service:"hunt-engine-api",
        providers:{
          brave:!!env.BRAVE_API_KEY,
          jooble:!!env.JOOBLE_API_KEY,
          adzuna:!!env.ADZUNA_APP_ID && !!env.ADZUNA_APP_KEY
        }
      },200,origin);
    }

    if(u.pathname!=="/hunt" || request.method!=="POST"){
      return reply({
        ok:true,
        message:"Hunt Engine API is running",
        endpoints:["GET /health","POST /hunt"]
      },200,origin);
    }

    if(origin!==ALLOWED){
      return reply({
        ok:false,
        error:"Origin not allowed"
      },403,origin);
    }

    let b;

    try{
      b = await request.json();
    }catch{
      return reply({
        ok:false,
        error:"Invalid JSON"
      },400,origin);
    }

    const country = String(b.country||"CA").toUpperCase();

    const p = {
      lane:b.lane==="steady" ? "steady" : "quick",
      country:/^[A-Z]{2}$/.test(country) ? country : "CA",
      location:clean(b.location,100),
      radiusKm:Math.min(
        100,
        Math.max(1,Number(b.radiusKm)||25)
      ),
      work:work(b)
    };

    if(!p.location){
      return reply({
        ok:false,
        error:"Location is required"
      },400,origin);
    }

    const tasks = [
      source("Jooble",()=>jooble(env,p)),
      source("Adzuna",()=>adzuna(env,p))
    ];

    if(p.lane==="quick"){
      tasks.push(
        source("Brave Web",()=>brave(env,p))
      );
    }

    const providers = await Promise.all(tasks);

    const results = dedupe(
      providers.flatMap(x=>x.items)
    ).slice(0,60);

    return reply({
      ok:true,
      generatedAt:new Date().toISOString(),
      providers:providers.map(({items,...x})=>x),
      count:results.length,
      results
    },200,origin);
  }
};
