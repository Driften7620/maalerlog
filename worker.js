export default {
  async fetch(request, env, ctx) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      const body = await request.json();

      if (body.action === "elprices") {
        return await handleElPrices(cors);
      }

      if (body.action === "sendEmail") {
        return await handleSendEmail(body, env, cors);
      }

      if (body.action === "remindersRun") {
        const log = await koerPaamindelser(env, true, !!body.tvang);
        return new Response(JSON.stringify({ ok: !log.fejl, log: log }), {
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }

      if (body.action === "feedTest") {
        return await handleFeedTest(body, env, cors);
      }

      if (body.action === "weatherAlerts") {
        return await handleWeatherAlerts(body, env, cors);
      }

      if (body.action === "authDeleteUser") {
        return await handleAuthDeleteUser(body, env, cors);
      }

      if (body.action === "authInviteTest") {
        return await handleAuthInviteTest(body, env, cors);
      }

      if (body.action === "authInvite") {
        return await handleAuthInvite(body, env, cors);
      }

      if (body.action === "excelSync") {
        return await handleExcelSync(body, env, cors);
      }

      if (body.action === "aicost") {
        return await handleAiCost(env, cors);
      }

      if (body.action === "weather") {
        return await handleWeather(body, env, cors);
      }

      if (body.action === "greenpower") {
        return await handleGreenPower(body, cors);
      }

      if (body.action === "energydash") {
        return await handleEnergyDash(body, cors);
      }

      if (body.action === "gasprice") {
        return await handleGasPrice(cors);
      }
      if (body.action === "gridstatus") {
        return await handleGridStatus(cors);
      }

      if (body.action === "livedata") {
        return await handleLiveData(env, cors);
      }

      if (body.action === "entsoe") {
        return await handleEntsoe(body, env, cors);
      }

      if (body.action === "roundExport") {
        return await handleRoundExport(body, env, cors);
      }

      if (body.action === "backupExport") {
        return await handleBackupExport(body, env, cors);
      }

      if (body.action === "rss") {
        return await handleRss(body, cors);
      }

      if (!env.ANTHROPIC_API_KEY) {
        return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY mangler - sæt den som Secret under Workerens Settings i Cloudflare" }), {
          status: 500,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }

      const maxTokens = body.max_tokens || 1024;

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-opus-4-8",
          max_tokens: maxTokens,
          ...(body.system ? { system: body.system } : {}),
          messages: body.messages,
        }),
      });

      const data = await response.json();
      return new Response(JSON.stringify(data), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
  },

  // Kaldes af Cloudflares cron-trigger. Ingen bruger involveret.
  // Cloudflares gratisplan tillader 50 underforespoergsler pr. koersel.
  // Derfor deles arbejdet paa to triggere:
  //   0 4,10,16 * * *   -> vejrvarsler (ca. 10 kald)
  //   30 5 * * *        -> paamindelser (ca. 12 laesninger + mails)
  // Findes kun EEN trigger, koeres begge dele, saa intet gaar i staa i stilhed.
  async scheduled(event, env, ctx) {
    const cron = String((event && event.cron) || "").trim();
    const erPaamindelse = cron.startsWith("30 5");
    const kunEen = !cron;
    ctx.waitUntil((async () => {
      if (erPaamindelse || kunEen) await koerPaamindelser(env, false);
      if (!erPaamindelse) await koerVejrVarsel(env, false);
    })());
  },
};

// Henter faktisk forbrug (måned til dato) fra Anthropic Cost Admin API.
// Kræver en Admin-nøgle (sk-ant-admin...) sat som Secret: ANTHROPIC_ADMIN_KEY.
async function handleAiCost(env, cors) {
  try {
    if (!env.ANTHROPIC_ADMIN_KEY) {
      return new Response(JSON.stringify({ error: "Admin-nøgle mangler (ANTHROPIC_ADMIN_KEY) - opret i Anthropic Console (Organisationsindstillinger -> Admin keys) og sæt som Secret" }), {
        status: 200,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 19) + "Z";
    const end = now.toISOString().slice(0, 19) + "Z";
    const q = new URLSearchParams({
      starting_at: start,
      ending_at: end,
      bucket_width: "1d",
      limit: "31",
    });

    const r = await fetch("https://api.anthropic.com/v1/organizations/cost_report?" + q.toString(), {
      headers: {
        "x-api-key": env.ANTHROPIC_ADMIN_KEY,
        "anthropic-version": "2023-06-01",
      },
    });

    const j = await r.json();
    if (!r.ok || j.error) {
      console.log("Cost-API fejl:", r.status, JSON.stringify(j));
      return new Response(JSON.stringify({ error: (j.error && j.error.message) || ("HTTP " + r.status) }), {
        status: 200,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // Summer alle beløb (USD) på tværs af dags-buckets.
    // NB: skulle beløbet se 100x for højt ud, returnerer API'et cents -> del total med 100.
    let total = 0;
    for (const bucket of (j.data || [])) {
      for (const res of (bucket.results || [])) {
        total += parseFloat(res.amount || 0);
      }
    }

    return new Response(JSON.stringify({ total_cost_usd: total }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.log("Cost-API undtagelse:", e.message);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
}

function _wErr(msg, cors) {
  return new Response(JSON.stringify({ error: msg }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
}

// Afled et WMO-vejrkode-tal ud fra DMI's rå parametre (DMI har intet vejr-symbol).
function _dmiCode(cloud, precip, ptype, lightning) {
  if (lightning != null && lightning >= 0.3) return 95;      // tordenvejr
  if (precip != null && precip >= 0.1) {
    if (ptype === 3) return precip >= 1 ? 75 : (precip >= 0.4 ? 73 : 71);  // sne
    if (ptype === 2 || ptype === 4 || ptype === 5) return 67;              // slud/underafkølet
    if (ptype === 6 || ptype === 7) return 77;                            // graupel/hagl
    if (precip >= 2.5) return 65;                                         // kraftig regn
    if (precip >= 0.5) return 63;                                         // regn
    return 61;                                                            // let regn
  }
  const c = cloud == null ? 0 : cloud;   // 0..1
  if (c < 0.13) return 0;                // klart
  if (c < 0.45) return 1;                // mest klart
  if (c < 0.80) return 2;                // delvist skyet
  return 3;                              // overskyet
}

async function handleWeather(body, env, cors) {
  try {
    const source = body.source || "dmi";
    if (body.lat == null || body.lon == null) return _wErr("Mangler lat/lon", cors);
    if (source === "dmi") return await handleWeatherDMI(body.lat, body.lon, env, cors);
    return _wErr("Ukendt vejrkilde: " + source, cors);
  } catch (e) {
    return _wErr(e.message, cors);
  }
}

async function handleWeatherDMI(lat, lon, env, cors) {
  // DMI Forecast EDR via den noeglefri vaert opendataapi.dmi.dk. Den svarer, men rate-limiter (HTTP 429) under travlhed.
  // DMI_HOST kan overstyres som Secret. DMI_API_KEY sendes med hvis den er sat (ikke paakraevet paa opendataapi).
  const params = ["temperature-2m", "wind-speed-10m", "wind-dir-10m", "total-precipitation", "fraction-of-cloud-cover", "precipitation-type"];
  const host = env.DMI_HOST || "https://opendataapi.dmi.dk";
  let url = host + "/v1/forecastedr/collections/harmonie_dini_sf/position"
    + "?coords=" + encodeURIComponent("POINT(" + lon + " " + lat + ")")
    + "&crs=crs84&f=CoverageJSON&parameter-name=" + params.join(",");
  if (env.DMI_API_KEY) url += "&api-key=" + encodeURIComponent(env.DMI_API_KEY);

  // Retry ved 429 (DMI travl): kort ventetid, faa forsoeg.
  let r, txt = "";
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  for (let attempt = 0; attempt < 3; attempt++) {
    r = await fetch(url, { headers: { "Accept": "application/json" } });
    txt = await r.text();
    if (r.status !== 429) break;
    if (attempt < 2) await sleep(600 * (attempt + 1)); // 600ms, 1200ms
  }
  if (!r.ok) {
    let extra = txt ? (": " + txt.slice(0, 160)) : "";
    if (r.status === 429) extra = " - DMI er travl lige nu (for mange forespoergsler). Proev igen om lidt.";
    return _wErr("DMI HTTP " + r.status + extra, cors);
  }
  let j; try { j = JSON.parse(txt); } catch (_) { return _wErr("DMI: uventet svar (ikke JSON): " + txt.slice(0, 160), cors); }
  const t = j.domain && j.domain.axes && j.domain.axes.t && j.domain.axes.t.values;
  const ranges = j.ranges || {};
  if (!t || !t.length) return _wErr("DMI: ingen tidsdata i svaret", cors);
  const val = (name, i) => (ranges[name] && ranges[name].values ? ranges[name].values[i] : null);

  const hourly = { time: [], temperature_2m: [], weather_code: [], precipitation_probability: [], wind_speed_10m: [] };
  const days = {};
  let prevP = null;
  for (let i = 0; i < t.length; i++) {
    const tK = val("temperature-2m", i);
    const tC = tK == null ? null : (tK - 273.15);
    const wind = val("wind-speed-10m", i);          // m/s
    const dir = val("wind-dir-10m", i);
    const cloud = val("fraction-of-cloud-cover", i); // 0..1
    let ptype = val("precipitation-type", i);
    if (ptype != null) ptype = Math.round(ptype);
    const accP = val("total-precipitation", i);      // akkumuleret mm
    let stepP = null;
    if (accP != null) { stepP = prevP == null ? accP : Math.max(0, accP - prevP); prevP = accP; }
    const code = _dmiCode(cloud, stepP, ptype, null);

    hourly.time.push(t[i]);
    hourly.temperature_2m.push(tC);
    hourly.weather_code.push(code);
    hourly.precipitation_probability.push(stepP != null && stepP > 0 ? Math.min(100, Math.round(stepP * 40)) : 0);
    hourly.wind_speed_10m.push(wind == null ? 0 : wind * 3.6); // km/h

    const dt = new Date(t[i]);
    const key = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Copenhagen", year: "numeric", month: "2-digit", day: "2-digit" }).format(dt);
    if (!days[key]) days[key] = { min: Infinity, max: -Infinity, windMax: 0, dir: dir || 0, code: code, midDist: Infinity };
    const dd = days[key];
    if (tC != null) { dd.min = Math.min(dd.min, tC); dd.max = Math.max(dd.max, tC); }
    if (wind != null) dd.windMax = Math.max(dd.windMax, wind * 3.6);
    let hourLocal = parseInt(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Copenhagen", hour: "2-digit", hour12: false }).format(dt), 10);
    if (isNaN(hourLocal)) hourLocal = 0;
    const dist = Math.abs(hourLocal - 12);
    if (dist < dd.midDist) { dd.midDist = dist; dd.code = code; dd.dir = dir || 0; }
  }
  const keys = Object.keys(days).sort();
  const daily = { time: [], temperature_2m_max: [], temperature_2m_min: [], weather_code: [], wind_speed_10m_max: [], wind_direction_10m_dominant: [] };
  for (const k of keys) {
    const dd = days[k];
    daily.time.push(k);
    daily.temperature_2m_max.push(dd.max === -Infinity ? null : dd.max);
    daily.temperature_2m_min.push(dd.min === Infinity ? null : dd.min);
    daily.weather_code.push(dd.code);
    daily.wind_speed_10m_max.push(dd.windMax);
    daily.wind_direction_10m_dominant.push(dd.dir);
  }
  const dir0 = val("wind-dir-10m", 0);
  const current = { temperature_2m: hourly.temperature_2m[0], weather_code: hourly.weather_code[0], wind_speed_10m: hourly.wind_speed_10m[0], wind_direction_10m: dir0 || 0 };
  return new Response(JSON.stringify({ current, hourly, daily }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
}

async function handleRss(body, cors) {
  try {
    const url = body && body.url;
    if (!url || !/^https?:\/\//.test(url)) return _wErr("Ugyldig feed-URL", cors);
    const r = await fetch(url, { headers: { "User-Agent": "DriftenApp/1.0 (+https://driften7620.github.io)", "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" } });
    if (!r.ok) return _wErr("Feed HTTP " + r.status, cors);
    const xml = await r.text();
    return new Response(JSON.stringify({ xml }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    return _wErr(e.message, cors);
  }
}

async function handleBackupExport(body, env, cors) {
  try {
    const url = env.PA_BACKUP_URL || env.PA_ROUND_EXPORT_URL;
    if (!url) return _wErr("PA_BACKUP_URL mangler - opret Power Automate-flow og saet URL som Secret", cors);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "backup",
        folder: body.folder || "",
        filename: body.filename || "driften-backup.zip",
        contentBase64: body.contentBase64 || "",
        sizeBytes: body.sizeBytes || 0,
        createdAt: new Date().toISOString(),
      }),
    });
    const txt = await res.text();
    let d; try { d = JSON.parse(txt); } catch (_) { d = { raw: txt }; }
    if (!res.ok) {
      return new Response(JSON.stringify({ ok: false, error: "Power Automate HTTP " + res.status, raw: d }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true, ...(d && typeof d === "object" ? d : {}) }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    return _wErr(e.message, cors);
  }
}

async function handleRoundExport(body, env, cors) {
  try {
    if (!env.PA_ROUND_EXPORT_URL) return _wErr("PA_ROUND_EXPORT_URL mangler - opret Power Automate-flow og saet URL som Secret", cors);
    const res = await fetch(env.PA_ROUND_EXPORT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        destination: body.destination || "",
        folder: body.folder || "",
        filenameBase: body.filenameBase || "registrering",
        csvLine: body.csvLine || "",
        html: body.html || "",
        data: body.data || {},
      }),
    });
    const txt = await res.text();
    let d; try { d = JSON.parse(txt); } catch (_) { d = { raw: txt }; }
    if (!res.ok) {
      return new Response(JSON.stringify({ ok: false, error: "Power Automate HTTP " + res.status, raw: d }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true, ...(d && typeof d === "object" ? d : {}) }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    return _wErr(e.message, cors);
  }
}

async function handleGreenPower(body, cors) {
  try {
    const area = (body && body.area) || "DK1";
    const now = new Date();
    const start = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    const startStr = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
    const params = new URLSearchParams({
      start: startStr,
      filter: JSON.stringify({ PriceArea: [area] }),
      sort: "Minutes5UTC ASC",
      limit: "2000",
    });
    const url = "https://api.energidataservice.dk/dataset/CO2EmisProg?" + params.toString();
    const r = await fetch(url);
    const j = await r.json();
    if (!r.ok) return _wErr("CO2-prognose HTTP " + r.status, cors);
    const recs = j.records || [];
    // Aggregér 5-min -> timepriser (gennemsnit pr. time, dansk lokaltid).
    const byHour = {};
    for (const rec of recs) {
      const tDK = rec.Minutes5DK;
      if (!tDK || rec.CO2Emission == null) continue;
      const hk = tDK.slice(0, 13); // "YYYY-MM-DDTHH"
      if (!byHour[hk]) byHour[hk] = { sum: 0, n: 0 };
      byHour[hk].sum += rec.CO2Emission;
      byHour[hk].n += 1;
    }
    const hours = Object.keys(byHour).sort().map((hk) => ({ time: hk + ":00:00", co2: byHour[hk].sum / byHour[hk].n, est: false }));
    // Forlæng ud over Energinets horisont med et vejr-estimat (vind i 100 m + sol) fra Open-Meteo.
    try {
      const dk1la = (body && body.lat != null) ? body.lat : 56.55;
      const dk1lo = (body && body.lon != null) ? body.lon : 8.30;
      // Regionale punkter der driver DK1's pris/CO2: DK1 (Vestjylland), tysk Nordsokyst/offshore, tysk indland (sol+vind).
      const pts = [
        { la: dk1la, lo: dk1lo, w: 0.45 }, // DK1 lokalt
        { la: 54.0,  lo: 8.0,   w: 0.35 }, // Tysk bugt / Nordso-vind
        { la: 52.5,  lo: 10.5,  w: 0.20 }, // Tysk indland (sol + onshore)
      ];
      const lats = pts.map((p) => p.la).join(",");
      const lons = pts.map((p) => p.lo).join(",");
      const lastReal = hours.length ? new Date(hours[hours.length - 1].time).getTime() : Date.now();
      const wUrl = "https://api.open-meteo.com/v1/forecast?latitude=" + lats + "&longitude=" + lons +
        "&hourly=wind_speed_100m,shortwave_radiation&timezone=Europe%2FCopenhagen&forecast_days=10";
      const wr = await fetch(wUrl);
      if (wr.ok) {
        let wj = await wr.json();
        const arr = Array.isArray(wj) ? wj : [wj];
        const T = (arr[0] && arr[0].hourly && arr[0].hourly.time) || [];
        for (let i = 0; i < T.length; i++) {
          const tms = new Date(T[i]).getTime();
          if (tms <= lastReal) continue;
          let ren = 0, wsum = 0;
          for (let p = 0; p < arr.length; p++) {
            const h = (arr[p] && arr[p].hourly) || {};
            const windMs = ((h.wind_speed_100m && h.wind_speed_100m[i]) || 0) / 3.6;
            const rad = (h.shortwave_radiation && h.shortwave_radiation[i]) || 0;
            const ws = Math.min(1, windMs / 12);
            const ss = Math.min(1, rad / 400);
            const frac = Math.max(0, Math.min(0.98, 0.15 + 0.7 * ws + 0.22 * ss));
            const w = (pts[p] && pts[p].w) || 0;
            ren += frac * w; wsum += w;
          }
          ren = wsum ? ren / wsum : 0;
          const co2 = Math.round((1 - ren) * 420 + 15);
          hours.push({ time: (T[i].length === 16 ? T[i] + ":00" : T[i]), co2: co2, est: true });
        }
      }
    } catch (e) { /* estimatet er valgfrit */ }
    return new Response(JSON.stringify({ hours, area }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    return _wErr(e.message, cors);
  }
}

async function handleEnergyDash(body, cors) {
  // Vejr-baseret VE-dashboard for Norden + Tyskland, 10 dage frem (Open-Meteo, keyless).
  // Faktisk MW-produktion pr. land (Energinet/ENTSO-E) laegges paa senere som "nowcast".
  try {
    // Repraesentative punkter pr. land (vind-region + sol-region).
    const pts = [
      { la: 56.3, lo: 8.3 },  // 0 DK1 Vestjylland (vind+sol)
      { la: 56.0, lo: 6.5 },  // 1 DK Nordso offshore (vind)
      { la: 54.0, lo: 8.5 },  // 2 DE nord (vind)
      { la: 48.5, lo: 11.5 }, // 3 DE syd (sol)
      { la: 56.0, lo: 13.5 }, // 4 SE syd (vind+sol)
      { la: 59.3, lo: 15.0 }, // 5 SE midt (vind)
      { la: 58.8, lo: 6.0 },  // 6 NO sydvest (vind)
      { la: 56.55, lo: 8.30 } // 7 Lemvig (temperatur)
    ];
    const lats = pts.map((p) => p.la).join(",");
    const lons = pts.map((p) => p.lo).join(",");
    const url = "https://api.open-meteo.com/v1/forecast?latitude=" + lats + "&longitude=" + lons +
      "&hourly=wind_speed_100m,shortwave_radiation,temperature_2m&timezone=Europe%2FCopenhagen&forecast_days=10";
    const r = await fetch(url);
    if (!r.ok) return _wErr("Open-Meteo HTTP " + r.status, cors);
    const wj = await r.json();
    const arr = Array.isArray(wj) ? wj : [wj];
    const time = (arr[0] && arr[0].hourly && arr[0].hourly.time) || [];
    const windIdx = (pi, i) => {
      const h = (arr[pi] && arr[pi].hourly) || {};
      const ms = ((h.wind_speed_100m && h.wind_speed_100m[i]) || 0) / 3.6; // km/t -> m/s
      return Math.max(0, Math.min(1, ms / 12));
    };
    const solIdx = (pi, i) => {
      const h = (arr[pi] && arr[pi].hourly) || {};
      const rad = (h.shortwave_radiation && h.shortwave_radiation[i]) || 0;
      return Math.max(0, Math.min(1, rad / 400));
    };
    const tempAt = (pi, i) => {
      const h = (arr[pi] && arr[pi].hourly) || {};
      return (h.temperature_2m && h.temperature_2m[i] != null) ? h.temperature_2m[i] : null;
    };
    const avg2 = (a, b) => (a + b) / 2;
    const countries = { dk: { wind: [], sol: [] }, de: { wind: [], sol: [] }, se: { wind: [], sol: [] }, no: { wind: [], sol: [] } };
    const ve = [], temp = [];
    for (let i = 0; i < time.length; i++) {
      const dkW = avg2(windIdx(0, i), windIdx(1, i)), dkS = solIdx(0, i);
      const deW = windIdx(2, i), deS = solIdx(3, i);
      const seW = avg2(windIdx(4, i), windIdx(5, i)), seS = solIdx(4, i);
      const noW = windIdx(6, i), noS = solIdx(6, i);
      countries.dk.wind.push(dkW); countries.dk.sol.push(dkS);
      countries.de.wind.push(deW); countries.de.sol.push(deS);
      countries.se.wind.push(seW); countries.se.sol.push(seS);
      countries.no.wind.push(noW); countries.no.sol.push(noS);
      // Regional VE-fraktion pr. land (vind vejer mest), blandet efter paavirkning paa DK1.
      const frac = (w, sol) => Math.max(0, Math.min(1, 0.15 + 0.70 * w + 0.22 * sol));
      const blended = 0.30 * frac(dkW, dkS) + 0.35 * frac(deW, deS) + 0.20 * frac(seW, seS) + 0.15 * frac(noW, noS);
      ve.push(Math.round(blended * 100));
      temp.push(tempAt(7, i));
    }
    return new Response(JSON.stringify({ time, countries, ve, temp, _fetchedAt: Date.now() }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" }
    });
  } catch (e) {
    return _wErr(e.message, cors);
  }
}

async function handleGasPrice(cors) {
  // Selv-opdagende: proever flere sandsynlige Energi Data Service gas-datasaet og finder selv pris-feltet.
  // Returnerer hvad der virkede + diagnostik, saa vi kan laase det rigtige datasaet efter foerste test.
  const cands = [
    "https://api.energidataservice.dk/dataset/GasDailyBalancingPrice?sort=GasDay%20DESC&limit=1",
    "https://api.energidataservice.dk/dataset/GasExchangeNeutral?sort=Date%20DESC&limit=1",
    "https://api.energidataservice.dk/dataset/GasSpotPrice?sort=GasDay%20DESC&limit=1",
    "https://api.energidataservice.dk/dataset/GasSystemBalance?limit=1"
  ];
  const tried = [];
  for (const url of cands) {
    try {
      const r = await fetch(url);
      if (!r.ok) { tried.push({ url, status: r.status }); continue; }
      const d = await r.json();
      const rec = (d.records || [])[0];
      if (!rec) { tried.push({ url, status: "ok-men-tom" }); continue; }
      // Find foerste numeriske felt der ligner en pris
      let priceField = null, price = null;
      for (const k of Object.keys(rec)) {
        if (/price|pris/i.test(k) && typeof rec[k] === "number") { priceField = k; price = rec[k]; break; }
      }
      const dataset = url.split("/dataset/")[1].split("?")[0];
      return new Response(JSON.stringify({ ok: true, dataset, priceField, price, record: rec, tried }), {
        status: 200, headers: { ...cors, "Content-Type": "application/json" }
      });
    } catch (e) { tried.push({ url, error: e.message }); }
  }
  return new Response(JSON.stringify({ ok: false, error: "Ingen gas-datasaet svarede", tried }), {
    status: 200, headers: { ...cors, "Content-Type": "application/json" }
  });
}

async function handleGridStatus(cors) {
  // Forsoeg paa Energinet aaben-data for udfald/driftsstatus. Meget usikkert - returnerer diagnostik.
  const cands = [
    "https://api.energidataservice.dk/dataset/Outages?limit=20",
    "https://api.energidataservice.dk/dataset/TransmissionLines?limit=20",
    "https://api.energidataservice.dk/dataset/PhysicalFlowsInterconnectors?sort=HourUTC%20DESC&limit=10"
  ];
  const tried = [];
  for (const url of cands) {
    try {
      const r = await fetch(url);
      if (!r.ok) { tried.push({ url, status: r.status }); continue; }
      const d = await r.json();
      const recs = d.records || [];
      const dataset = url.split("/dataset/")[1].split("?")[0];
      return new Response(JSON.stringify({ ok: true, dataset, count: recs.length, sample: recs.slice(0, 3), tried }), {
        status: 200, headers: { ...cors, "Content-Type": "application/json" }
      });
    } catch (e) { tried.push({ url, error: e.message }); }
  }
  return new Response(JSON.stringify({ ok: false, error: "Ingen grid-datasaet svarede", tried }), {
    status: 200, headers: { ...cors, "Content-Type": "application/json" }
  });
}

async function handleLiveData(env, cors) {
  // Henter LiveConnect get_list.php (fast key). Robust parser: finder T<nr> + navn + sidste tal pr. raekke,
  // uanset om formatet er HTML-tabel, tabs eller mellemrum.
  if (!env.LIVECONNECT_URL) return _wErr("LIVECONNECT_URL mangler - saet get_list.php-URL (inkl. key) som Secret i Cloudflare", cors);
  try {
    const r = await fetch(env.LIVECONNECT_URL);
    let txt = await r.text();
    if (!r.ok) return _wErr("LiveConnect HTTP " + r.status + (txt ? ": " + txt.slice(0, 120) : ""), cors);
    if (/no access/i.test(txt)) return _wErr("LiveConnect: No access (tjek key i LIVECONNECT_URL)", cors);

    const tags = {};
    let ts = "";

    // Metode 1: HTML-tabelraekker <tr>...</tr> med celler
    const trMatches = txt.match(/<tr[\s\S]*?<\/tr>/gi);
    if (trMatches && trMatches.length) {
      for (const tr of trMatches) {
        const cells = (tr.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi) || [])
          .map((c) => c.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim());
        if (cells.length >= 2) {
          const idx = (cells[0] || "").trim();
          const val = cells[cells.length - 1];
          if (/^T\d+$/i.test(idx)) {
            tags[idx.toUpperCase()] = { name: cells.slice(1, cells.length - 1).join(" ").trim(), value: parseFloat(val) };
          } else if (/time\s*stamp/i.test(cells.join(" "))) {
            ts = val;
          }
        }
      }
    }

    // Metode 2 (fallback / supplement): linje-baseret paa ren tekst
    if (Object.keys(tags).length === 0) {
      const plain = txt.replace(/<[^>]+>/g, "\t").replace(/&nbsp;/g, " ").replace(/\r/g, "");
      for (const line of plain.split("\n")) {
        // Find T<nr> et sted, og sidste tal paa linjen
        const m = line.match(/\bT(\d+)\b/i);
        const nums = line.match(/-?\d+(?:[.,]\d+)?/g);
        if (m && nums && nums.length) {
          const key = "T" + m[1];
          // navn = teksten mellem T-index og sidste tal
          let name = line.replace(/<[^>]+>/g, " ").replace(/\t/g, " ").replace(/\bT\d+\b/i, "").trim();
          const lastNum = nums[nums.length - 1];
          const ni = name.lastIndexOf(lastNum);
          if (ni >= 0) name = name.slice(0, ni).trim();
          tags[key] = { name: name, value: parseFloat(lastNum.replace(",", ".")) };
        } else if (/time\s*stamp/i.test(line) && nums && nums.length) {
          ts = nums[nums.length - 1];
        }
      }
    }

    return new Response(JSON.stringify({ ok: true, tags: tags, ts: ts, count: Object.keys(tags).length, _sample: txt.slice(0, 300) }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" }
    });
  } catch (e) { return _wErr(e.message, cors); }
}



// ENTSO-E Transparency Platform: faktisk produktion pr. type (A75) -> rigtigt VE-indeks.
// Token som Cloudflare Secret ENTSOE_TOKEN. Svar er XML; robust regex-parser + _sample til diagnostik.
const ENTSOE_ZONES = {
  DK1: "10YDK-1--------W", DK2: "10YDK-2--------M",
  DE: "10Y1001A1001A82H", "DE-LU": "10Y1001A1001A82H",
  SE1: "10Y1001A1001A44P", SE2: "10Y1001A1001A45N", SE3: "10Y1001A1001A46L", SE4: "10Y1001A1001A47J",
  NO1: "10YNO-1--------2", NO2: "10YNO-2--------T", NO3: "10YNO-3--------J", NO4: "10YNO-4--------9", NO5: "10Y1001A1001A48H",
  FI: "10YFI-1--------U"
};
const ENTSOE_PSR = {
  B01: "Biomasse", B02: "Brunkul", B03: "Kulgas", B04: "Naturgas", B05: "Stenkul", B06: "Olie", B07: "Olieskifer",
  B08: "Toerv", B09: "Geotermisk", B10: "Vandkraft pumpe", B11: "Vandkraft flod", B12: "Vandkraft reservoir",
  B13: "Marine", B14: "Atomkraft", B15: "Anden VE", B16: "Sol", B17: "Affald", B18: "Vind offshore", B19: "Vind onshore", B20: "Andet"
};
function _entsoeTime(d) {
  const p = (x) => String(x).padStart(2, "0");
  return "" + d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + p(d.getUTCHours()) + "00";
}
const ENTSOE_COUNTRY = {
  DK: ["DK1", "DK2"], DE: ["DE"], SE: ["SE1", "SE2", "SE3", "SE4"], NO: ["NO1", "NO2", "NO3", "NO4", "NO5"], FI: ["FI"]
};
async function _entsoeZoneGen(env, eic, doc) {
  const now = new Date();
  const end = new Date(Math.ceil(now.getTime() / 3600000) * 3600000);
  const start = new Date(end.getTime() - 8 * 3600000);
  const ps = _entsoeTime(start), pe = _entsoeTime(end);
  const url = "https://web-api.tp.entsoe.eu/api?securityToken=" + env.ENTSOE_TOKEN +
    "&documentType=" + doc + "&processType=A16&in_Domain=" + eic +
    "&periodStart=" + ps + "&periodEnd=" + pe;
  const r = await fetch(url);
  const txt = await r.text();
  if (!r.ok) throw new Error("HTTP " + r.status + (txt ? ": " + txt.slice(0, 120) : ""));
  if (/Acknowledgement_MarketDocument/i.test(txt)) {
    const reason = (txt.match(/<text>([\s\S]*?)<\/text>/) || [])[1] || "ukendt aarsag";
    throw new Error("afvist: " + reason.slice(0, 140));
  }
  const gen = {};
  const tsBlocks = txt.match(/<TimeSeries>[\s\S]*?<\/TimeSeries>/g) || [];
  for (const ts of tsBlocks) {
    const pType = (ts.match(/<psrType>([^<]+)<\/psrType>/) || [])[1];
    if (!pType) continue;
    const isLoad = /<outBiddingZone_Domain/i.test(ts) && !/<inBiddingZone_Domain/i.test(ts);
    if (isLoad) continue;
    const pts = [...ts.matchAll(/<position>(\d+)<\/position>\s*<quantity>([\d.]+)<\/quantity>/g)];
    if (!pts.length) continue;
    let best = pts[0];
    for (const pt of pts) if (parseInt(pt[1]) > parseInt(best[1])) best = pt;
    const q = parseFloat(best[2]);
    if (isNaN(q)) continue;
    gen[pType] = (gen[pType] || 0) + q;
  }
  return { gen: gen, count: tsBlocks.length, periode: { start: ps, slut: pe }, sample: txt.slice(0, 600) };
}
async function handleEntsoe(body, env, cors) {
  if (!env.ENTSOE_TOKEN) return _wErr("ENTSOE_TOKEN mangler - saet din Transparency Platform-token som Secret i Cloudflare", cors);
  try {
    const zone = (body.zone || "DK1").toUpperCase();
    const doc = body.doc || "A75";
    const subs = ENTSOE_COUNTRY[zone] || (ENTSOE_ZONES[zone] ? [zone] : null);
    if (!subs) return _wErr("Ukendt zone: " + zone + " (gyldige: DK, DE, SE, NO, FI eller enkeltzoner som DK1, SE3, NO2)", cors);
    const results = await Promise.all(subs.map(async (z) => {
      try { const g = await _entsoeZoneGen(env, ENTSOE_ZONES[z], doc); return { z: z, ok: true, g: g }; }
      catch (e) { return { z: z, ok: false, err: e.message }; }
    }));
    const gen = {}; let anySample = ""; let serier = 0; let periode = null; const fejl = [];
    for (const res of results) {
      if (!res.ok) { fejl.push(res.z + ": " + res.err); continue; }
      if (!anySample) anySample = res.g.sample;
      if (!periode) periode = res.g.periode;
      serier += res.g.count;
      for (const k in res.g.gen) gen[k] = (gen[k] || 0) + res.g.gen[k];
    }
    let total = 0; for (const k in gen) total += gen[k];
    if (total === 0 && fejl.length) return _wErr("ENTSO-E fejl: " + fejl.join(" | ").slice(0, 200), cors);
    const wind = (gen.B18 || 0) + (gen.B19 || 0);
    const solar = gen.B16 || 0;
    const renewKeys = ["B01", "B09", "B10", "B11", "B12", "B13", "B15", "B16", "B18", "B19"];
    let renew = 0; renewKeys.forEach((k) => { renew += gen[k] || 0; });
    const mix = {};
    for (const k in gen) mix[ENTSOE_PSR[k] || k] = Math.round(gen[k]);
    return new Response(JSON.stringify({
      ok: true, zone: zone, subzoner: subs, doc: doc,
      total_MW: Math.round(total), vind_MW: Math.round(wind), sol_MW: Math.round(solar),
      ve_vind_sol_pct: total > 0 ? Math.round(((wind + solar) / total) * 100) : null,
      ve_alle_pct: total > 0 ? Math.round((renew / total) * 100) : null,
      mix: mix, periode: periode, antal_serier: serier,
      advarsler: fejl.length ? fejl : undefined,
      _sample: anySample
    }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) { return _wErr("ENTSO-E: " + e.message, cors); }
}

async function handleExcelSync(body, env, cors) {
  try {
    if (!env.PA_EXCEL_SYNC_URL) {
      return new Response(JSON.stringify({ ok: false, message: "PA_EXCEL_SYNC_URL mangler - sæt den som Secret under Workerens Settings i Cloudflare" }), {
        status: 500,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const { excelFile, sheetName, row, col, value, expectedName } = body;
    if (!excelFile || !sheetName || !row || !col || value === undefined || value === null) {
      return new Response(JSON.stringify({ ok: false, message: "Mangler et eller flere felter (excelFile, sheetName, row, col, value)" }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const res = await fetch(env.PA_EXCEL_SYNC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ excelFile, sheetName, row, col, value, expectedName: expectedName || "" }),
    });

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    // Power Automate's "Respond to a PowerApp or flow" wrapper puts the Office
    // Script's own return value one level in (under .result eller direkte).
    const scriptResult = data.result || data;

    if (!res.ok) {
      console.log("Excel-sync (Power Automate) HTTP-fejl:", res.status, text);
      return new Response(JSON.stringify({ ok: false, message: `Power Automate HTTP ${res.status}`, raw: data }), {
        status: 502,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    if (scriptResult && scriptResult.ok === false) {
      console.log("Excel-sync (Office Script) afviste skrivning:", scriptResult.message);
      return new Response(JSON.stringify({ ok: false, message: scriptResult.message, raw: scriptResult }), {
        status: 200,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: true, ...scriptResult }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.log("Excel-sync undtagelse:", e.message);
    return new Response(JSON.stringify({ ok: false, message: e.message }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
}

// ═══ PÅMINDELSER ══════════════════════════════════════════════════════════
// Kører på cron\'en, saa forfaldne opgaver bliver meldt, ogsaa naar ingen har
// appen aaben. Logikken herunder SKAL svare til _remOverdueCalc i index.html.
// Aendres den ene, skal den anden med. Det er en bevidst dublet — alternativet
// var at flytte hele beregningen ud af appen, hvor den ogsaa bruges til badges.

const REM_MODULER = [
  { k: "meters",  navn: "Måleraflæsning",   ikon: "⚡",  dage: 2 },
  { k: "round",   navn: "Rundering",        ikon: "📋", dage: 1 },
  { k: "jobs",    navn: "Jobs",             ikon: "🔧", dage: 7 },
  { k: "tasks",   navn: "Opgaver",          ikon: "📌", dage: 7 },
  { k: "equip",   navn: "Udstyr ikke retur", ikon: "🛠️", dage: 1 },
  { k: "inspect", navn: "Eftersyn",         ikon: "🔍", dage: 7 },
  { k: "bredOev", navn: "Beredskabsøvelser", ikon: "🚨", dage: 0 },
  { k: "cert",    navn: "Kompetencer",       ikon: "🎓", dage: 0 },
];

const _liste = (v) => (v ? (Array.isArray(v) ? v : Object.values(v)) : []);
const _dage = (d) => (!d ? Infinity : Math.floor((Date.now() - new Date(d).getTime()) / 86400000));
const _over = (d, interval) => (!d ? 9999 : Math.floor((Date.now() - new Date(d).getTime()) / 86400000) - (interval || 0));

function _remCfg(cfgAlle, k) {
  const std = REM_MODULER.find((m) => m.k === k) || {};
  const c = (cfgAlle || {})[k] || {};
  const dage = c.dage == null ? std.dage : c.dage;
  const mods = (c.emails || []).map((e) =>
    typeof e === "string" ? { mail: e, dage: dage } : { mail: e.mail || e.email || "", dage: e.dage == null ? dage : e.dage }
  ).filter((e) => !!e.mail);
  return { on: !!c.on, dage: dage, emails: mods };
}

// Samme regel som isDue() i appen
function _maalerForfalden(m, readings, roundStart) {
  const lr = readings.filter((r) => r.meterId === m.id)
    .sort((a, b) => new Date(b.date) - new Date(a.date))[0];
  if (!lr) return { due: true, over: 9999 };
  if (roundStart && new Date(lr.date) < new Date(roundStart)) return { due: true, over: _over(lr.date, 0) };
  const type = m.intervalType || "days";
  if (type === "monthly") {
    const l = new Date(lr.date), n = new Date();
    const due = l.getMonth() !== n.getMonth() || l.getFullYear() !== n.getFullYear();
    return { due: due, over: _over(lr.date, 30) };
  }
  const iv = m.intervalDays || 30;
  return { due: _dage(lr.date) >= iv, over: _over(lr.date, iv) };
}

async function koerPaamindelser(env, manuel, tvang) {
  const log = { moduler: [], sendt: 0, fejl: "" };
  try {
    if (!env.FB_SERVICE_ACCOUNT || !env.FB_DB_URL) throw new Error("FB_SERVICE_ACCOUNT eller FB_DB_URL mangler");
    if (!env.PA_EMAIL_URL) throw new Error("PA_EMAIL_URL mangler");
    const token = await _gcpAccessToken(env);
    const base = env.FB_DB_URL.replace(/\/$/, "");
    const auth = "?access_token=" + encodeURIComponent(token);
    const hent = async (n) => {
      try { const r = await fetch(base + "/" + n + ".json" + auth); return r.ok ? await r.json() : null; }
      catch (e) { return null; }
    };

    const cfgAlle = (await hent("reminderSettings")) || {};
    const aktive = REM_MODULER.filter((m) => {
      const c = _remCfg(cfgAlle, m.k);
      return c.on && c.emails.length;
    });
    if (!aktive.length) { log.fejl = "Ingen påmindelser er slået til"; return log; }

    // Hent kun det, de aktive moduler faktisk skal bruge
    const brug = (k) => aktive.some((m) => m.k === k);
    const [readings, meters, roundStart, roundLocs, roundLog, jobs, tasks, equipLoans, equipment, inspectLog, sendtRaw] =
      await Promise.all([
        brug("meters") ? hent("readings") : null,
        brug("meters") ? hent("meters") : null,
        brug("meters") ? hent("meterRoundStart") : null,
        brug("round") ? hent("roundLocs") : null,
        brug("round") ? hent("roundLog") : null,
        brug("jobs") ? hent("jobs") : null,
        brug("tasks") ? hent("tasks") : null,
        brug("equip") ? hent("equipLoans") : null,
        brug("inspect") ? hent("equipment") : null,
        brug("inspect") ? hent("inspectLog") : null,
        hent("reminderSent"),
      ]);
    const bredSet = brug("bredOev") ? ((await hent("bredSettings")) || {}) : {};
    const certL = brug("cert") ? _liste(await hent("certs")) : [];
    const certT = brug("cert") ? _liste(await hent("certTypes")) : [];
    const brugere = brug("cert") ? _liste(await hent("users")) : [];
    const bredOev = brug("bredOev") ? _liste(await hent("bredOevelser")) : [];

    const R = _liste(readings), M = _liste(meters), RL = _liste(roundLocs), RLog = _liste(roundLog);
    const J = _liste(jobs), T = _liste(tasks), EL = _liste(equipLoans), EQ = _liste(equipment), IL = _liste(inspectLog);
    const sendt = sendtRaw || {};
    const iDag = new Date().toDateString();

    // Sikkerhedsspærre: kunne en nødvendig node ikke hentes, springes modulet
    // over. Ellers ville en enkelt fejlet læsning melde ALT som forfaldent —
    // og en mail med 181 falske punkter er værre end ingen mail.
    const mangler = {
      meters:  brug("meters")  && (!M.length || !R.length),
      round:   brug("round")   && !RL.length,
      inspect: brug("inspect") && !EQ.length,
    };
    const forfaldne = (k) => {
      const ud = [];
      if (k === "meters") {
        M.forEach((m) => {
          const s = _maalerForfalden(m, R, roundStart);
          if (s.due) ud.push({ navn: m.name || m.id, ekstra: m.location || "", gruppe: m.location || "Uden lokation", dage: s.over });
        });
      } else if (k === "round") {
        RL.forEach((loc) => {
          const logs = RLog.filter((l) => l.locId === loc.id).sort((a, b) => new Date(b.date) - new Date(a.date));
          const over = logs.length ? _over(logs[0].date, loc.intervalDays || 1) : 9999;
          if (over >= 0) ud.push({ navn: loc.name || loc.id, ekstra: "", gruppe: loc.name || loc.id, dage: over });
        });
      } else if (k === "jobs") {
        J.filter((j) => j.status === "open").forEach((j) =>
          ud.push({ navn: j.title || "(uden titel)", ekstra: j.location || "", gruppe: j.location || "Uden lokation", dage: _over(j.createdAt, 0) }));
      } else if (k === "tasks") {
        T.filter((t) => t.status === "open").forEach((t) =>
          ud.push({ navn: t.title || "(uden titel)", ekstra: (t.assignees || []).join(", "), gruppe: (t.assignees || []).join(", ") || "Ikke tildelt", dage: _over(t.createdAt, 0) }));
      } else if (k === "equip") {
        EL.filter((l) => !l.returnedAt && l.expectedReturnAt).forEach((l) => {
          const over = Math.floor((Date.now() - new Date(l.expectedReturnAt).getTime()) / 86400000);
          if (over >= 0) ud.push({ navn: l.equipName || l.equipId, ekstra: l.user || "", gruppe: l.user || "Ukendt låner", dage: over });
        });
      } else if (k === "cert") {
        certL.filter((c) => c.status === "godkendt" && c.udloeber).forEach((c) => {
          const t = certT.find((x) => x.id === c.typeId) || {};
          const varsel = t.varselDage == null ? 90 : t.varselDage;
          const tilbage = Math.ceil((new Date(c.udloeber) - new Date()) / 86400000);
          if (tilbage > varsel) return;
          const navn = (brugere.find((u) => u.id === c.userId) || {}).name || "—";
          ud.push({
            navn: (t.navn || "Bevis") + (c.kategori ? " (" + c.kategori + ")" : ""),
            ekstra: navn + (tilbage < 0 ? " — UDLØBET" : " — om " + tilbage + " dage"),
            gruppe: navn, dage: varsel - tilbage,
          });
        });
      } else if (k === "bredOev") {
        const varsel = bredSet.oevelseVarselDage == null ? 60 : bredSet.oevelseVarselDage;
        (bredSet.oevelseTyper || []).forEach((t) => {
          const gjort = bredOev.filter((o) => o.status === "gennemført" && (o.type === t.navn || o.navn === t.navn))
            .sort((a, b) => String(b.dato || "").localeCompare(String(a.dato || "")))[0];
          if (!gjort) { ud.push({ navn: t.navn, ekstra: "aldrig afholdt", gruppe: "Øvelser", dage: 9999 }); return; }
          const naeste = new Date(gjort.dato);
          naeste.setMonth(naeste.getMonth() + (t.intervalMdr || 12));
          const tilbage = Math.ceil((naeste - new Date()) / 86400000);
          if (tilbage > varsel) return;
          ud.push({
            navn: t.navn,
            ekstra: tilbage > 0 ? "om " + tilbage + " dage" : "overskredet med " + (-tilbage) + " dage",
            gruppe: "Øvelser", dage: varsel - tilbage,
          });
        });
      } else if (k === "inspect") {
        EQ.filter((e) => e.inspectTemplateId).forEach((eq) => {
          const sidst = IL.filter((l) => l.equipId === eq.id).sort((a, b) => new Date(b.date) - new Date(a.date))[0];
          let due = false, over = 9999;
          if (eq.approved === "no" || !sidst) { due = true; }
          else {
            const d = new Date(sidst.date);
            d.setMonth(d.getMonth() + (eq.inspectIntervalMonths || 12));
            if (d <= new Date()) { due = true; over = Math.floor((Date.now() - d.getTime()) / 86400000); }
          }
          if (due) ud.push({ navn: eq.name || eq.id, ekstra: eq.location || "", gruppe: eq.location || "Uden lokation", dage: over });
        });
      }
      return ud;
    };

    const MAX_MAILS = 12;   // sikkerhedsloft mod Cloudflares 50 underforespoergsler
    for (const mod of aktive) {
      if (log.sendt >= MAX_MAILS) { log.fejl = "Loft paa " + MAX_MAILS + " mails naaet — resten sendes ved naeste koersel"; break; }
      if (mangler[mod.k]) {
        log.moduler.push({ navn: mod.navn, forfaldne: 0, sendt: 0, fejl: "data kunne ikke hentes — sprunget over" });
        continue;
      }
      const c = _remCfg(cfgAlle, mod.k);
      const alle = forfaldne(mod.k);
      const ml = { navn: mod.navn, forfaldne: alle.length, sendt: 0 };
      const grupper = {};
      c.emails.forEach((e) => { (grupper[e.dage] = grupper[e.dage] || []).push(e.mail); });

      for (const g of Object.keys(grupper)) {
        const d = parseInt(g, 10);
        if (!tvang && sendt[mod.k + "_" + d] === iDag) continue;
        const emner = alle.filter((e) => e.dage >= d);
        if (!emner.length) continue;
        // Faa emner listes enkeltvis. Mange samles pr. lokation, ellers bliver
        // mailen en mur af tekst, som ingen laeser.
        const _tid = (d) => (d >= 9999 ? "aldrig udført" : (d <= 0 ? "forfalden i dag" : d + " dage over"));
        let linjer;
        if (emner.length <= 8) {
          linjer = emner.sort((a, b) => b.dage - a.dage).map(
            (e) => "• " + e.navn + (e.ekstra ? " (" + e.ekstra + ")" : "") + " — " + _tid(e.dage)
          );
        } else {
          const grp = {};
          emner.forEach((e) => {
            const g = e.gruppe || "Øvrige";
            if (!grp[g]) grp[g] = { antal: 0, vaerst: -1, aldrig: 0 };
            grp[g].antal++;
            if (e.dage >= 9999) grp[g].aldrig++;
            else if (e.dage > grp[g].vaerst) grp[g].vaerst = e.dage;
          });
          linjer = Object.keys(grp).sort((a, b) => grp[b].antal - grp[a].antal).map((g) => {
            const x = grp[g];
            const detalje = x.aldrig === x.antal
              ? "aldrig udført"
              : (x.aldrig ? x.aldrig + " aldrig udført" : "") +
                (x.aldrig && x.vaerst >= 0 ? " · " : "") +
                (x.vaerst >= 0 ? "ældste " + _tid(x.vaerst) : "");
            return "• <b>" + g + "</b> — " + x.antal + " stk. (" + detalje + ")";
          });
          linjer.push("");
          linjer.push("<i>Åbn appen for at se de enkelte punkter.</i>");
        }
        const html =
          '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;color:#222">' +
          "<p>Hej,</p><p>Følgende er forfaldent i <b>" + mod.navn + "</b> (mindst " + d + " dag" + (d === 1 ? "" : "e") + " over planlagt):</p>" +
          "<p>" + linjer.join("<br>") + "</p>" +
          '<p><a href="https://driften7620.github.io/maalerlog/">Åbn Driften App</a></p>' +
          '<p style="font-size:12px;color:#666">Automatisk påmindelse — kan slås fra under Indstillinger → Påmindelser.</p></div>';
        const paRes = await fetch(env.PA_EMAIL_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: grupper[g].join(";"), toList: grupper[g],
            subject: mod.ikon + " " + mod.navn + ": " + emner.length + " forfalden" + (emner.length > 1 ? "e" : "") + " — Driften App",
            body: html, attachmentName: "", attachmentBase64: "",
            sentAt: new Date().toISOString(),
          }),
        });
        if (paRes.ok) {
          ml.sendt++; log.sendt++;
          await fetch(base + "/reminderSent/" + mod.k + "_" + d + ".json" + auth, {
            method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(iDag),
          });
        } else { ml.fejl = "Power Automate HTTP " + paRes.status; }
      }
      log.moduler.push(ml);
    }
    return log;
  } catch (e) {
    log.fejl = String((e && e.message) || e);
    return log;
  }
}

// ═══ VEJRVARSLER ══════════════════════════════════════════════════════════
// Henter DMI\'s varsler via MeteoAlarms Atom-feed (de gamle RSS-feeds blev
// lukket 14. januar 2026). Sender mail, naar der kommer et NYT varsel — ikke
// hver gang cron\'en koerer.
//
// Indstillinger i Firebase under settings/vejrVarsel:
//   aktiv      true/false
//   modtagere  ["a@b.dk", ...]
//   omraader   ["Midtjylland", ...]  (tom = alle danske varsler)
//   niveau     "gul" | "orange" | "roed"   (mindste niveau der udloeser mail)
// Sidst sete varsler gemmes i settings/vejrVarselSet.

const ALARM_FEED = "https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-denmark";
const NIVEAU_RANG = { gul: 1, yellow: 1, orange: 2, roed: 3, red: 3, rød: 3 };

const STD_KILDER = [
  { id: "meteoalarm", navn: "DMI vejrvarsler (MeteoAlarm)", url: ALARM_FEED, type: "meteoalarm", aktiv: true, ord: [] },
];

function _tag(xml, navn) {
  const m = xml.match(new RegExp("<" + navn + "[^>]*>([\\s\\S]*?)</" + navn + ">", "i"));
  return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : "";
}
function _afkod(t) {
  return String(t || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}
function _niveauAf(tekst) {
  const t = String(tekst || "").toLowerCase();
  if (t.includes("red") || t.includes("rød")) return "roed";
  if (t.includes("orange")) return "orange";
  if (t.includes("yellow") || t.includes("gul")) return "gul";
  return "";
}

// Laeser baade Atom (<entry>) og RSS (<item>), saa vilkaarlige feeds kan bruges.
async function hentFeed(kilde) {
  const r = await fetch(kilde.url, { headers: { "User-Agent": "DriftenApp/1.0 (Lemvig Varmevaerk)" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const xml = await r.text();
  const erAtom = /<entry[\s>]/i.test(xml);
  const dele = xml.split(erAtom ? /<entry[\s>]/i : /<item[\s>]/i).slice(1);
  return dele.slice(0, 40).map(function (d) {
    const titel = _afkod(_tag(d, "title"));
    const resume = _afkod(_tag(d, "summary")) || _afkod(_tag(d, "description")) || _afkod(_tag(d, "content"));
    const omraade = _afkod(_tag(d, "cap:areaDesc")) || _afkod(_tag(d, "areaDesc")) || "";
    const id = _tag(d, "id") || _tag(d, "guid") || _tag(d, "link") || titel;
    const opdateret = _tag(d, "updated") || _tag(d, "published") || _tag(d, "pubDate") || "";
    return {
      kilde: kilde.navn, kildeId: kilde.id,
      id: id, titel: titel, omraade: omraade,
      tekst: resume.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 900),
      niveau: kilde.type === "meteoalarm" ? _niveauAf(titel + " " + resume) : "info",
      opdateret: opdateret,
    };
  });
}

// Oversætter MeteoAlarms engelske varseltitler til dansk.
function _daVarsel(t) {
  let s = String(t || "");
  const farve = { Red: "Rødt", Orange: "Orange", Yellow: "Gult", Green: "Grønt" };
  const type = {
    "Thunderstorm": "tordenvejr", "Wind": "kraftig vind", "Rain": "kraftig regn",
    "Rain-Flood": "regn og oversvømmelse", "Snow-Ice": "sne og is", "Snow/Ice": "sne og is",
    "Fog": "tåge", "Extreme high temperature": "meget høj temperatur",
    "Extreme low temperature": "meget lav temperatur", "high-temperature": "høj temperatur",
    "low-temperature": "lav temperatur", "Coastalevent": "forhøjet vandstand",
    "Coastal Event": "forhøjet vandstand", "Flood": "oversvømmelse",
    "Forest fire": "skovbrand", "Avalanches": "laviner",
  };
  // "Yellow Thunderstorm Warning issued for Denmark - Midtjylland"
  const m = s.match(/^(Red|Orange|Yellow|Green)\s+(.+?)\s+Warning issued for Denmark\s*-?\s*(.*)$/i);
  if (m) {
    const niv = farve[m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()] || m[1];
    let typ = m[2];
    for (const k in type) { if (typ.toLowerCase() === k.toLowerCase()) { typ = type[k]; break; } }
    return niv + " varsel: " + typ + (m[3] ? " — " + m[3] : "");
  }
  // Faldback: oversæt løse ord
  for (const k in type) s = s.replace(new RegExp(k, "gi"), type[k]);
  for (const k in farve) s = s.replace(new RegExp(k + " ", "gi"), farve[k] + " ");
  return s.replace(/Warning issued for Denmark\s*-?\s*/i, "").replace(/\s+/g, " ").trim();
}

async function hentVejrVarsler() {
  const alle = await hentFeed(STD_KILDER[0]);
  const varsler = alle.filter(function (x) { return x.niveau && x.niveau !== "info"; });
  varsler.forEach(function (v) { v.titel = _daVarsel(v.titel); });
  // Fjern dubletter — samme niveau + område + titel
  const set = {}, ud = [];
  varsler.forEach(function (v) {
    const n = (v.niveau + "|" + (v.omraade || "") + "|" + v.titel).toLowerCase();
    if (set[n]) return;
    set[n] = 1; ud.push(v);
  });
  return ud;
}

async function koerVejrVarsel(env, manuel) {
  const log = { hentet: 0, relevante: 0, nye: 0, sendt: false, fejl: "", kilder: [] };
  try {
    if (!env.FB_SERVICE_ACCOUNT || !env.FB_DB_URL) throw new Error("FB_SERVICE_ACCOUNT eller FB_DB_URL mangler");
    const token = await _gcpAccessToken(env);
    const base = env.FB_DB_URL.replace(/\/$/, "");
    const auth = "?access_token=" + encodeURIComponent(token);

    const cfgRes = await fetch(base + "/settings/vejrVarsel.json" + auth);
    const cfg = (await cfgRes.json()) || {};
    if (cfg.aktiv === false && !manuel) { log.fejl = "Varsling er slaaet fra"; return log; }

    const kildeRes = await fetch(base + "/settings/varselKilder.json" + auth);
    const gemte = await kildeRes.json();
    let kilder = Array.isArray(gemte) ? gemte : (gemte ? Object.values(gemte) : []);
    if (!kilder.length) kilder = STD_KILDER;
    kilder = kilder.filter(function (k) { return k && k.url && k.aktiv !== false; });

    const minRang = NIVEAU_RANG[cfg.niveau || "gul"] || 1;
    const globaleOrd = (cfg.omraader || []).map(function (x) { return String(x).toLowerCase(); });
    let relevante = [];

    for (const k of kilder) {
      const kl = { navn: k.navn || k.url, hentet: 0, fejl: "" };
      try {
        const poster = await hentFeed(k);
        kl.hentet = poster.length;
        log.hentet += poster.length;
        const ord = ((k.ord && k.ord.length) ? k.ord : globaleOrd).map(function (x) { return String(x).toLowerCase(); });
        poster.forEach(function (v) {
          if (k.type === "meteoalarm") {
            if (!v.niveau || (NIVEAU_RANG[v.niveau] || 0) < minRang) return;
          }
          if (ord.length) {
            const t = (v.titel + " " + v.omraade + " " + v.tekst).toLowerCase();
            if (!ord.some(function (o) { return t.includes(o); })) return;
          } else if (k.type !== "meteoalarm") {
            return;   // frie feeds kraever noegleord, ellers drukner man i nyheder
          }
          relevante.push(v);
        });
      } catch (e) { kl.fejl = String((e && e.message) || e); }
      log.kilder.push(kl);
    }
    log.relevante = relevante.length;

    const setRes = await fetch(base + "/settings/vejrVarselSet.json" + auth);
    const set = (await setRes.json()) || {};
    const nye = relevante.filter(function (v) { return set[_noegle(v.id)] !== v.opdateret; });
    log.nye = nye.length;

    if (nye.length && env.PA_EMAIL_URL) {
      const modtagere = (cfg.modtagere || []).filter(Boolean);
      if (modtagere.length) {
        const farve = { gul: "#e0a800", orange: "#e06d00", roed: "#c62828", info: "#1f6fb2" };
        const navn = { gul: "GULT VARSEL", orange: "ORANGE VARSEL", roed: "RØDT VARSEL", info: "BEREDSKABSMELDING" };
        const vaerst = nye.reduce(function (a, b) {
          return ((NIVEAU_RANG[b.niveau] || 0) > (NIVEAU_RANG[a.niveau] || 0)) ? b : a;
        });
        const html =
          '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;color:#222">' +
          '<p style="font-size:18px;font-weight:bold;color:' + (farve[vaerst.niveau] || "#333") + '">' +
          (navn[vaerst.niveau] || "VARSEL") + "</p>" +
          nye.map(function (v) {
            return '<div style="border-left:4px solid ' + (farve[v.niveau] || "#999") +
              ';padding:6px 12px;margin-bottom:12px">' +
              '<div style="font-size:11px;color:#777;text-transform:uppercase">' + v.kilde + "</div>" +
              "<b>" + v.titel + "</b>" + (v.omraade ? " — " + v.omraade : "") + "<br>" + v.tekst + "</div>";
          }).join("") +
          "<p>Se hændelseskortene i Driften App, hvis meldingen får betydning for driften.</p>" +
          '<p><a href="https://driften7620.github.io/maalerlog/">Åbn Driften App</a></p>' +
          '<p style="font-size:12px;color:#666">Sendt automatisk af Driften App.</p></div>';
        const paRes = await fetch(env.PA_EMAIL_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: modtagere.join(";"), toList: modtagere,
            subject: (navn[vaerst.niveau] || "Varsel") + " — Driften App",
            body: html, attachmentName: "", attachmentBase64: "",
            sentAt: new Date().toISOString(),
          }),
        });
        log.sendt = paRes.ok;
        if (!paRes.ok) log.fejl = "Power Automate HTTP " + paRes.status;
      } else {
        log.fejl = "Ingen modtagere sat";
      }
    }

    const nyt = {};
    relevante.forEach(function (v) { nyt[_noegle(v.id)] = v.opdateret; });
    await fetch(base + "/settings/vejrVarselSet.json" + auth, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(nyt),
    });
    await fetch(base + "/settings/vejrVarselSidst.json" + auth, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tid: new Date().toISOString(), hentet: log.hentet, relevante: log.relevante, nye: log.nye }),
    });
    return log;
  } catch (e) {
    log.fejl = String((e && e.message) || e);
    return log;
  }
}

function _noegle(s) { return String(s).replace(/[.#$/\[\]]/g, "_").slice(0, 180); }

// Proever et vilkaarligt feed og viser de nyeste poster, saa man kan se
// om adressen duer, og hvilke ord der kan filtreres paa.
async function handleFeedTest(body, env, cors) {
  const j = (o, st) => new Response(JSON.stringify(o), { status: st || 200, headers: { ...cors, "Content-Type": "application/json" } });
  try {
    if (!body.url) return j({ error: "Ingen adresse angivet" }, 400);
    const poster = await hentFeed({ id: "test", navn: "Test", url: body.url, type: "rss" });
    return j({ ok: true, antal: poster.length, poster: poster.slice(0, 8) });
  } catch (e) {
    return j({ error: String((e && e.message) || e) });
  }
}

// Kald fra appen: enten "vis mig varslerne" eller "koer motoren nu"
async function handleWeatherAlerts(body, env, cors) {
  const j = (o, st) => new Response(JSON.stringify(o), { status: st || 200, headers: { ...cors, "Content-Type": "application/json" } });
  try {
    if (body.koer) {
      const log = await koerVejrVarsel(env, true);
      let alle = [];
      try { alle = await hentVejrVarsler(); } catch (e) {}
      return j({ ok: !log.fejl, log: log, varsler: alle });
    }
    const varsler = await hentVejrVarsler();
    return j({ ok: true, varsler: varsler });
  } catch (e) {
    return j({ error: String((e && e.message) || e) });
  }
}

// ═══ INVITATION TIL NY BRUGER — mail fra jeres egen Outlook ═══════════════
// Firebase laver saet-kode-linket, men sender det IKKE. Vi henter linket med
// en tjenestekonto og sender selv mailen gennem Power Automate.
// Kraever i Cloudflare: FB_SERVICE_ACCOUNT (hele JSON-filen), FB_DB_URL, PA_EMAIL_URL.
let _gcpToken = null;

function _b64url(buf) {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function _pemToDer(pem) {
  const clean = pem.replace(/-----BEGIN [^-]+-----/, "").replace(/-----END [^-]+-----/, "").replace(/\s+/g, "");
  const raw = atob(clean);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}

// Underskriver en JWT med tjenestekontoens noegle og bytter den til et adgangstoken.
async function _gcpAccessToken(env) {
  if (_gcpToken && _gcpToken.exp > Date.now() + 60000) return _gcpToken.token;
  const sa = JSON.parse(env.FB_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  const scope = [
    "https://www.googleapis.com/auth/identitytoolkit",
    "https://www.googleapis.com/auth/firebase.database",
    "https://www.googleapis.com/auth/userinfo.email",
  ].join(" ");
  const header = _b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claim = _b64url(new TextEncoder().encode(JSON.stringify({
    iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  })));
  const key = await crypto.subtle.importKey(
    "pkcs8", _pemToDer(String(sa.private_key).replace(/\\n/g, "\n")),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(header + "." + claim));
  const jwt = header + "." + claim + "." + _b64url(sig);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + encodeURIComponent(jwt),
  });
  const d = await res.json();
  if (!res.ok || !d.access_token) throw new Error("Token: " + (d.error_description || d.error || "ukendt fejl"));
  _gcpToken = { token: d.access_token, exp: Date.now() + ((d.expires_in || 3600) - 60) * 1000 };
  return d.access_token;
}

async function handleAuthInvite(body, env, cors) {
  const j = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { ...cors, "Content-Type": "application/json" } });
  try {
    const email = String(body.email || "").trim().toLowerCase();
    if (!email) return j({ error: "Ingen email angivet" }, 400);
    if (!body.idToken) return j({ error: "Ikke logget ind" }, 401);
    if (!env.FB_SERVICE_ACCOUNT) return j({ error: "FB_SERVICE_ACCOUNT mangler i Cloudflare" }, 500);
    if (!env.FB_DB_URL) return j({ error: "FB_DB_URL mangler i Cloudflare" }, 500);
    if (!env.PA_EMAIL_URL) return j({ error: "PA_EMAIL_URL mangler i Cloudflare" }, 500);

    const token = await _gcpAccessToken(env);

    // 1) Hvem kalder? Kun en admin maa udsende invitationer.
    const look = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ idToken: body.idToken }),
    });
    const lookD = await look.json();
    const uid = lookD && lookD.users && lookD.users[0] && lookD.users[0].localId;
    if (!look.ok || !uid) return j({ error: "Login kunne ikke bekraeftes" }, 401);

    const roleRes = await fetch(env.FB_DB_URL.replace(/\/$/, "") + "/userRoles/" + uid + "/role.json?access_token=" + encodeURIComponent(token));
    const role = await roleRes.json();
    if (role !== "admin") return j({ error: "Kun admin maa sende invitationer" }, 403);

    // 2) Hent saet-kode-linket UDEN at Firebase sender mail.
    const oobReq = { requestType: "PASSWORD_RESET", email, returnOobLink: true };
    if (env.APP_URL) oobReq.continueUrl = env.APP_URL;
    const oob = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify(oobReq),
    });
    const oobD = await oob.json();
    if (!oob.ok || !oobD.oobLink) {
      return j({ error: "Firebase: " + ((oobD.error && oobD.error.message) || "intet link") });
    }

    // 3) Send mailen gennem jeres egen Outlook. Linket sendes ALDRIG retur til appen.
    const navn = String(body.name || "").trim();
    const link = oobD.oobLink;
    const html =
      "<div style=\"font-family:Segoe UI,Arial,sans-serif;font-size:15px;color:#222;line-height:1.6\">" +
      "<p>" + (navn ? "Hej " + navn : "Hej") + ",</p>" +
      "<p>Du er oprettet som bruger i <b>Driften App</b> — v\u00e6rkets fælles app til drift og vedligehold.</p>" +

      "<p><b>1. V\u00e6lg din adgangskode</b><br>" +
      "Tryk p\u00e5 knappen. S\u00e5 v\u00e6lger du selv en kode, og derefter logger du ind med din email og den kode.</p>" +
      '<p><a href="' + link + '" style="background:#00a8c0;color:#ffffff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block">V\u00e6lg adgangskode</a></p>' +
      '<p style="font-size:12px;color:#666">Virker knappen ikke, s\u00e5 kopier dette link ind i browseren:<br>' + link + "</p>" +

      "<p><b>2. \u00c5bn appen</b><br>" +
      'Appen ligger p\u00e5 <a href="https://driften7620.github.io/maalerlog/">driften7620.github.io/maalerlog</a> og k\u00f8rer i browseren — der er ikke noget at installere fra App Store.</p>' +

      "<p><b>3. L\u00e6g den p\u00e5 hjemmesk\u00e6rmen</b> (anbefales)<br>" +
      "S\u00e5 \u00e5bner den i fuld sk\u00e6rm uden adresselinje og opf\u00f8rer sig som en almindelig app:</p>" +
      "<ul style=\"margin-top:4px\">" +
      "<li><b>iPhone og iPad:</b> \u00e5bn linket i <b>Safari</b> (ikke Chrome), tryk p\u00e5 del-ikonet nederst, og v\u00e6lg <b>F\u00f8j til hjemmesk\u00e6rm</b>.</li>" +
      "<li><b>Android:</b> \u00e5bn linket i Chrome, tryk p\u00e5 de tre prikker \u00f8verst, og v\u00e6lg <b>Installer app</b> eller <b>F\u00f8j til startsk\u00e6rm</b>.</li>" +
      "<li><b>Computer:</b> \u00e5bn linket i Edge eller Chrome — der kommer et lille installer-ikon ude i h\u00f8jre side af adresselinjen.</li>" +
      "</ul>" +

      "<p><b>Hvad kan den?</b></p>" +
      "<ul style=\"margin-top:4px\">" +
      "<li><b>Sikkerhedsdatablade</b> p\u00e5 kemikalier — altid ved h\u00e5nden, ogs\u00e5 ude p\u00e5 v\u00e6rkerne.</li>" +
      "<li><b>Beredskabsplan</b> med hurtige h\u00e6ndelseskort, der guider dig igennem.</li>" +
      "<li><b>M\u00e5leraflæsninger</b></li>" +
      "<li><b>Udstyr og eftersyn</b></li>" +
      "<li><b>Lager</b></li>" +
      "</ul>" +
      "<p>Derudover kan der v\u00e6lges flere moduler til — de er under udvikling. Du ser kun de dele, du har adgang til, s\u00e5 sig til, hvis der er noget, du mangler.</p>" +
      "<p><b>Forslag til forbedringer er meget velkomne.</b> Appen bliver bygget efter, hvordan arbejdet rent faktisk foreg\u00e5r — s\u00e5 er der noget, der er besv\u00e6rligt eller kunne g\u00f8res smartere, s\u00e5 sig endelig til.</p>" +

      "<p><b>Om oplysninger i appen</b><br>" +
      "Appen registrerer, <i>at</i> du har \u00e5bnet den — tidspunkt, hvilken slags enhed du bruger, og hvilken version du k\u00f8rer p\u00e5. Det bruges til at holde appen k\u00f8rende og til at se, om alle har f\u00e5et den nyeste version. " +
      "Der registreres <b>ikke</b>, hvad du kigger p\u00e5 inde i appen, og appen beder <b>aldrig</b> om din placering.</p>" +
      "<p style=\"font-size:13px;color:#555\">Til geng\u00e6ld gemmes det arbejde, du <i>registrerer</i> — aflæsninger, runderinger, eftersyn, timer og kvitteringer — med dit navn og tidspunkt. Det er hele pointen med en logbog, og det er ogs\u00e5 det, dokumentationskravene bygger p\u00e5.</p>" +

      "<p style=\"font-size:13px;color:#555\">Sm\u00e5 r\u00e5d til f\u00f8rste gang: log ind \u00e9n gang p\u00e5 den telefon, du bruger til daglig, s\u00e5 husker den dig. Appen virker ogs\u00e5, n\u00e5r der er d\u00e5rligt signal ude p\u00e5 v\u00e6rkerne — den gemmer og sender, n\u00e5r der er forbindelse igen.</p>" +

      "<p>Venlig hilsen<br>Driften App — Lemvig Varmev\u00e6rk</p>" +
      "</div>";

    const paRes = await fetch(env.PA_EMAIL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: email,
        toList: [email],
        subject: body.subject || "Din adgang til Driften App",
        body: html,
        attachmentName: "",
        attachmentBase64: "",
        sentAt: new Date().toISOString(),
      }),
    });
    if (!paRes.ok) {
      const raw = await paRes.text();
      return j({ error: "Power Automate HTTP " + paRes.status, raw: raw.slice(0, 300) });
    }
    return j({ ok: true, via: "power-automate" });
  } catch (e) {
    return j({ error: String((e && e.message) || e) });
  }
}

// Sletter selve login-kontoen i Firebase Authentication. Uden dette bliver
// kontoen liggende, naar en bruger fjernes i appen — og en konto, der stadig
// findes, kan laese databasen udenom appen.
async function handleAuthDeleteUser(body, env, cors) {
  const j = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { ...cors, "Content-Type": "application/json" } });
  try {
    const email = String(body.email || "").trim().toLowerCase();
    if (!email) return j({ error: "Ingen email angivet" }, 400);
    if (!body.idToken) return j({ error: "Ikke logget ind" }, 401);
    if (!env.FB_SERVICE_ACCOUNT || !env.FB_DB_URL) return j({ error: "FB_SERVICE_ACCOUNT eller FB_DB_URL mangler" }, 500);

    const token = await _gcpAccessToken(env);

    // Kun en admin maa slette logins
    const look = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ idToken: body.idToken }),
    });
    const lookD = await look.json();
    const uid = lookD && lookD.users && lookD.users[0] && lookD.users[0].localId;
    if (!look.ok || !uid) return j({ error: "Login kunne ikke bekraeftes" }, 401);
    const roleRes = await fetch(env.FB_DB_URL.replace(/\/$/, "") + "/userRoles/" + uid + "/role.json?access_token=" + encodeURIComponent(token));
    if ((await roleRes.json()) !== "admin") return j({ error: "Kun admin maa slette logins" }, 403);

    // Find kontoen paa email
    const find = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ email: [email] }),
    });
    const findD = await find.json();
    const target = findD && findD.users && findD.users[0];
    if (!target) return j({ ok: true, fandtIngen: true });   // ingen konto — intet at slette
    if (target.localId === uid) return j({ error: "Du kan ikke slette dit eget login" }, 400);

    const del = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:delete", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ localId: target.localId }),
    });
    const delD = await del.json();
    if (!del.ok) return j({ error: "Firebase: " + ((delD.error && delD.error.message) || "kunne ikke slette") });
    return j({ ok: true, uid: target.localId });
  } catch (e) {
    return j({ error: String((e && e.message) || e) });
  }
}

// Gennemloeber hele invitations-kaeden trin for trin og fortaeller hvor det
// braender. Sender en testmail til admins egen adresse. Linket kasseres.
async function handleAuthInviteTest(body, env, cors) {
  const steps = [];
  const add = (navn, ok, note) => steps.push({ navn, ok, note: note || "" });
  const svar = () => new Response(JSON.stringify({ ok: steps.every((t) => t.ok), steps }), { headers: { ...cors, "Content-Type": "application/json" } });
  try {
    add("Hemmeligheder i Cloudflare", !!(env.FB_SERVICE_ACCOUNT && env.FB_DB_URL && env.PA_EMAIL_URL),
      [!env.FB_SERVICE_ACCOUNT && "FB_SERVICE_ACCOUNT mangler", !env.FB_DB_URL && "FB_DB_URL mangler", !env.PA_EMAIL_URL && "PA_EMAIL_URL mangler"].filter(Boolean).join(" · "));
    if (!steps[0].ok) return svar();

    let token;
    try {
      token = await _gcpAccessToken(env);
      add("Tjenestekonto underskriver token", true);
    } catch (e) {
      add("Tjenestekonto underskriver token", false, String((e && e.message) || e));
      return svar();
    }

    if (!body.idToken) { add("Dit login bekraeftes", false, "Intet login-token sendt med"); return svar(); }
    const look = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ idToken: body.idToken }),
    });
    const lookD = await look.json();
    const bruger = lookD && lookD.users && lookD.users[0];
    if (!look.ok || !bruger) { add("Dit login bekraeftes", false, (lookD.error && lookD.error.message) || "ukendt fejl"); return svar(); }
    add("Dit login bekraeftes", true, bruger.email || "");

    const roleRes = await fetch(env.FB_DB_URL.replace(/\/$/, "") + "/userRoles/" + bruger.localId + "/role.json?access_token=" + encodeURIComponent(token));
    const role = await roleRes.json();
    add("Du er admin i userRoles", role === "admin", "rolle: " + JSON.stringify(role));
    if (role !== "admin") return svar();

    const mail = String(body.email || bruger.email || "").trim().toLowerCase();
    const oob = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ requestType: "PASSWORD_RESET", email: mail, returnOobLink: true }),
    });
    const oobD = await oob.json();
    const harLink = !!(oob.ok && oobD.oobLink);
    add("Firebase udleverer saet-kode-link", harLink, harLink ? "link modtaget og kasseret" : ((oobD.error && oobD.error.message) || "intet link"));
    if (!harLink) return svar();

    const paRes = await fetch(env.PA_EMAIL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: mail, toList: [mail],
        subject: "Test af invitations-mail — Driften App",
        body: "<p>Det her er en testmail fra Driften App.</p><p>Kommer den frem, virker kaeden fra appen gennem Cloudflare og Power Automate til jeres Outlook. Invitationer til nye brugere sendes ad samme vej.</p><p>Der er ikke noget link i denne mail — den kan roligt slettes.</p>",
        attachmentName: "", attachmentBase64: "", sentAt: new Date().toISOString(),
      }),
    });
    const paTxt = paRes.ok ? "" : (await paRes.text()).slice(0, 200);
    add("Testmail sendt via Power Automate", paRes.ok, paRes.ok ? "sendt til " + mail : "HTTP " + paRes.status + " " + paTxt);
    return svar();
  } catch (e) {
    add("Uventet fejl", false, String((e && e.message) || e));
    return svar();
  }
}

async function handleSendEmail(body, env, cors) {
  const j = (o, st) => new Response(JSON.stringify(o), { status: st || 200, headers: { ...cors, "Content-Type": "application/json" } });
  try {
    // Al mail gaar gennem Power Automate og jeres eget Outlook/M365.
    // EmailJS blev pensioneret 21. juli 2026 og kontoen er lukket.
    if (!env.PA_EMAIL_URL) {
      return j({ error: "PA_EMAIL_URL mangler i Cloudflare - ingen mail kan sendes" }, 500);
    }
    const toArr = Array.isArray(body.to) ? body.to : [body.to];
    if (!toArr.length || !toArr[0]) return j({ error: "Ingen modtager angivet" }, 400);

    let attB64 = "";
    if (body.attachment && body.attachment.content) {
      attB64 = body.attachment.contentBase64 || btoa(unescape(encodeURIComponent(body.attachment.content)));
    }
    const paRes = await fetch(env.PA_EMAIL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: toArr.join(";"),
        toList: toArr,
        subject: body.subject || "Besked fra Driften App",
        body: body.body || "",
        attachmentName: (body.attachment && body.attachment.filename) || "",
        attachmentBase64: attB64,
        sentAt: new Date().toISOString(),
      }),
    });
    const paTxt = await paRes.text();
    if (!paRes.ok) return j({ error: "Power Automate HTTP " + paRes.status, raw: paTxt });
    return j({ ok: true, via: "power-automate", sent: toArr.length });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
}

async function handleElPrices(cors) {
  try {
    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const pad = (n) => String(n).padStart(2, "0");
    const startLocal = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;

    const params = new URLSearchParams({
      start: startLocal,
      filter: JSON.stringify({ PriceArea: ["DK1"] }),
      sort: "TimeDK ASC",
      limit: "400",
    });

    // ✅ Opdateret: DayAheadPrices (Elspotprices nedlagt sept. 2025)
    const actualUrl = `https://api.energidataservice.dk/dataset/DayAheadPrices?${params.toString()}`;
    // Tredjeparts-prognose (solmøller) fjernet af licens-hensyn: kilden tillader ikke
    // brug i apps/kommercielt. Vi laver i stedet vores eget skøn ud fra vejr (nedenfor).
    const fetchWithTimeout = (url, ms) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), ms);
      return fetch(url, { signal: controller.signal })
        .finally(() => clearTimeout(timeoutId));
    };

    const actualRes = await fetchWithTimeout(actualUrl, 10000).catch((e) => ({ ok: false, _err: e }));

    let actual = [];
    if (actualRes.ok) {
      const d = await actualRes.json();
      // DayAheadPrices-felter: TimeDK (lokaltid) og DayAheadPriceDKK (DKK pr. MWh).
      // Data er i 15-min-intervaller -> aggregér til timepriser (gennemsnit pr. time).
      const dk1 = (d.records || []).filter((r) => r.PriceArea === "DK1" && r.TimeDK && r.DayAheadPriceDKK != null);
      const byHour = {};
      for (const rec of dk1) {
        const hourKey = rec.TimeDK.slice(0, 13); // "YYYY-MM-DDTHH"
        if (!byHour[hourKey]) byHour[hourKey] = { sum: 0, n: 0 };
        byHour[hourKey].sum += rec.DayAheadPriceDKK;
        byHour[hourKey].n += 1;
      }
      actual = Object.keys(byHour).sort().map((hk) => ({
        time: hk + ":00:00",
        // DKK pr. MWh -> øre pr. kWh = / 10
        oerePerKwh: (byHour[hk].sum / byHour[hk].n) / 10,
      }));
    } else {
      console.log("Elpris (faktisk) fejl:", actualRes.status, actualRes._err);
    }

    // Eget prisskøn (regelbaseret, INGEN ML): vejrprognoser for DK1, Tyskland, Sverige og Norge
    // (Open-Meteo, gratis + tilladt kommercielt m. kildeangivelse), med de faktiske priser som niveau.
    // Kun en tendens (billige/dyre døgn) — ikke rigtige spotpriser.
    let forecast = null;
    try {
      const om = (lat, lon, extra) =>
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=wind_speed_100m${extra}&forecast_days=7&timezone=UTC`;
      const [dkR, deR, seR, noR] = await Promise.all([
        fetchWithTimeout(om(56.15, 8.62, ",temperature_2m,shortwave_radiation"), 10000).catch(() => ({ ok: false })),
        fetchWithTimeout(om(51.20, 9.50, ",shortwave_radiation"), 10000).catch(() => ({ ok: false })),
        fetchWithTimeout(om(59.30, 15.50, ",shortwave_radiation"), 10000).catch(() => ({ ok: false })),
        fetchWithTimeout(om(60.50, 8.50, ""), 10000).catch(() => ({ ok: false })),
      ]);
      if (dkR.ok) {
        const dk = await dkR.json();
        const times = (dk.hourly && dk.hourly.time) || [];
        const wdk = (dk.hourly && dk.hourly.wind_speed_100m) || [];
        const tdk = (dk.hourly && dk.hourly.temperature_2m) || [];
        const rdk = (dk.hourly && dk.hourly.shortwave_radiation) || [];
        const lut = async (res) => {
          const o = { w: {}, r: {} };
          if (res && res.ok) {
            const d = await res.json();
            const t = (d.hourly && d.hourly.time) || [];
            const w = (d.hourly && d.hourly.wind_speed_100m) || [];
            const r = (d.hourly && d.hourly.shortwave_radiation) || [];
            t.forEach((tt, i) => { o.w[tt] = w[i]; if (r.length) o.r[tt] = r[i]; });
          }
          return o;
        };
        const de = await lut(deR), se = await lut(seR), no = await lut(noR);
        let baseline = 50;
        if (actual.length) baseline = actual.reduce((s, h) => s + h.oerePerKwh, 0) / actual.length;
        if (!isFinite(baseline) || baseline < 5) baseline = 50;
        const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
        const norm = (x, lo, hi) => clamp((Number(x) - lo) / (hi - lo), 0, 1);
        const hours = times.map((t, i) => {
          const wDK = norm(wdk[i], 3, 14);
          const wDE = (de.w[t] != null) ? norm(de.w[t], 3, 14) : wDK;
          const wSE = (se.w[t] != null) ? norm(se.w[t], 3, 14) : wDK;
          const wNO = (no.w[t] != null) ? norm(no.w[t], 3, 14) : wDK;
          const rads = [Number(rdk[i])];
          if (de.r[t] != null) rads.push(Number(de.r[t]));
          if (se.r[t] != null) rads.push(Number(se.r[t]));
          const radAvg = rads.reduce((a, b) => a + b, 0) / rads.length;
          const sol = norm(radAvg, 0, 600);
          const warm = norm(tdk[i], -5, 18);
          // Vaegte (sum = 1): vind DK .24, DE .20, SE .14, NO .08; sol .20; temp .14
          const renewIdx = 0.24 * wDK + 0.20 * wDE + 0.14 * wSE + 0.08 * wNO + 0.20 * sol + 0.14 * warm;
          const hr = new Date(t + "Z").getUTCHours();
          let shape = 1.0;
          if (hr >= 7 && hr <= 9) shape = 1.12;
          else if (hr >= 17 && hr <= 20) shape = 1.18;
          else if (hr <= 5) shape = 0.85;
          let price = baseline * (1.7 - renewIdx * (1.7 - 0.45)) * shape;
          price = clamp(price, -30, 400);
          return { time: t + "Z", oerePerKwh: Math.round(price * 10) / 10 };
        }).filter((h) => isFinite(h.oerePerKwh));
        forecast = { kilde: "eget-skoen-vejr-dk-de-se-no", egetSkoen: true, hours };
      }
    } catch (e) {
      console.log("Eget prisskøn fejl:", e && e.message);
    }

    return new Response(JSON.stringify({ actual, forecast }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message, actual: [], forecast: null }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
}
