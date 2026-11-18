/** free-pi server half — ad-impression keeper + free-pi request identity.
 *
 * freepi.ai pauses free completions (403 `ads_required`) unless an ad
 * impression was reported recently. The TUI half reports impressions on turn
 * boundaries, but those are fire-and-forget: the first completion of a session
 * can beat the impression, an idle opencode lets the window expire, and the
 * per-click_token dedupe can suppress a new POST for as long as the server
 * reuses a token. This half owns the gate instead:
 *
 *   - `model.request` : await a fresh impression immediately before every
 *                       freepi model call (throttled, hard-capped so a slow ad
 *                       network never stalls the request), then attach
 *                       x-session-id / x-client-version / x-turn-id to the
 *                       chat request itself (CLI/bridge parity).
 *   - `retry` hook    : on 403 ads_required, report an ad and retry once the
 *                       account is unpaused again.
 *   - background tick : re-report every FREEPI_AD_REFRESH_MS (default 3 min)
 *                       so an idle session never lets the window expire
 *                       (freepi-bridge proves a 10 min cadence clears the
 *                       gate; 3 min keeps comfortable margin).
 *
 * Impression policy mirrors freepi-bridge: GET /ads/next with full fingerprint
 * headers, fire the gravity pixel, then POST /ads/impression with x-session-id
 * — every time, no long-lived dedupe.
 */
import { readFileSync, appendFileSync } from "node:fs";
import { arch, homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const CREDS = process.env.FREEPI_CREDS || join(HOME, ".free-pi/agent/credentials.json");
const BASE = "https://api.freepi.ai";
const PROVIDER = "freepi";
const AD_CLIENT_VERSION = process.env.FREEPI_AD_CLIENT_VERSION ?? "0.6.23";
const AD_REFRESH_MS = Number(process.env.FREEPI_AD_REFRESH_MS ?? 3 * 60_000);
const AD_STALE_MS = 90_000;             // request-path warm when the last impression is older
const AD_WARM_TIMEOUT_MS = 4_000;       // never stall a model call longer than this
const BANNER_MIN_REFRESH_MS = 60_000;   // /ads/next throttle (CLI parity)
const PIXEL_TIMEOUT_MS = 2_500;

function log(msg) {
  if (!process.env.FREEPI_METER_DEBUG) return;
  try { appendFileSync("/tmp/freepi-plugin.log", `[server] ${new Date().toISOString()} ${msg}\n`); } catch {}
}

function readToken() {
  try { return JSON.parse(readFileSync(CREDS, "utf8")).token ?? ""; } catch { return ""; }
}

async function post(path, body, token, headers) {
  const h = { "content-type": "application/json", ...(headers ?? {}) };
  if (token) h.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method: "POST", headers: h, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/** Same shape as the CLI's localeHeaders(): timezone + locale from Intl. */
function localeHeaders() {
  try {
    const { timeZone, locale } = Intl.DateTimeFormat().resolvedOptions();
    return {
      ...(timeZone ? { "x-client-timezone": timeZone } : {}),
      ...(locale ? { "x-client-locale": locale } : {}),
    };
  } catch { return {}; }
}

function isGravityImpUrl(raw) {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && /(^|\.)trygravity\.(ai|com)$/.test(u.hostname);
  } catch { return false; }
}

const adSessionId = crypto.randomUUID();
let currentTurnId = "";
let lastImpAt = 0;
let lastPullAt = 0;
let warmInFlight = null;

async function fetchAd(slot, trigger) {
  const tok = readToken();
  if (!tok) return;
  const headers = {
    authorization: `Bearer ${tok}`,
    "x-session-id": adSessionId,
    "x-client-version": AD_CLIENT_VERSION,
    "x-client-os": process.platform,
    "x-client-arch": arch(),
    ...localeHeaders(),
  };
  if (currentTurnId) headers["x-turn-id"] = currentTurnId;
  if (trigger) headers["x-ad-trigger"] = trigger;
  const res = await fetch(`${BASE}/ads/next?slot=${slot}`, { headers });
  log(`ads/next slot=${slot} trigger=${trigger ?? "-"} -> ${res.status}`);
  if (res.status === 204 || !res.ok) return;
  return await res.json().catch(() => undefined);
}

/** Fire the gravity pixel first (so imp_fired is truthful), then report. */
async function reportImpression(ad, trigger) {
  if (!ad?.ad_id || !ad?.click_token) return false;
  let impFired = false;
  if (ad.source === "gravity" && isGravityImpUrl(ad.imp_url)) {
    try {
      await fetch(ad.imp_url, { method: "GET", signal: AbortSignal.timeout(PIXEL_TIMEOUT_MS) });
      impFired = true;
    } catch (e) { log("pixel failed: " + (e?.message ?? e)); }
  }
  const tok = readToken();
  const r = await post(
    "/ads/impression",
    { ad_id: ad.ad_id, click_token: ad.click_token, ...(impFired ? { imp_fired: true } : {}) },
    tok,
    { "x-session-id": adSessionId },
  );
  log(`impression: ad=${ad.ad_id} source=${ad.source ?? "?"} trigger=${trigger ?? "-"} http=${r.status}${r.ok ? "" : " " + JSON.stringify(r.data).slice(0, 120)}`);
  if (r.ok) lastImpAt = Date.now();
  return r.ok;
}

/** Pull + report one banner ad. Returns true when an impression was accepted
 *  (or the account already has a fresh one). */
async function warmAds(trigger, opts = {}) {
  const force = opts.force === true;
  const now = Date.now();
  if (!force && now - lastImpAt < AD_STALE_MS) return true;
  if (warmInFlight) return warmInFlight;
  if (!force && now - lastPullAt < BANNER_MIN_REFRESH_MS) return lastImpAt > 0;
  const p = (async () => {
    lastPullAt = Date.now();
    try {
      const ad = await fetchAd("banner", trigger);
      if (!ad) return lastImpAt > 0; // 204/no-fill: nothing to report
      return await reportImpression(ad, trigger);
    } catch (e) {
      log("warm failed: " + (e?.message ?? e));
      return false;
    }
  })();
  warmInFlight = p;
  try { return await p; } finally { if (warmInFlight === p) warmInFlight = null; }
}

/** Warm with a hard deadline — the model call proceeds regardless. */
async function warmBounded(trigger, opts, ms = AD_WARM_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      warmAds(trigger, opts),
      new Promise((r) => { timer = setTimeout(() => r(lastImpAt > 0), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

export default {
  id: "freepi",
  async setup(ctx) {
    // background keeper: an idle OpenCode must not let the impression window expire
    const timer = setInterval(() => { void warmAds("refresh", { force: true }); }, AD_REFRESH_MS);
    timer.unref?.();
    void warmAds("launch", { force: true });

    // await a fresh impression before every freepi model call, then stamp the
    // request with the same session id the impression was reported under
    try {
      await ctx.session.hook(
        "model.request",
        async (event) => {
          currentTurnId = crypto.randomUUID();
          const warm = await warmBounded("user_message", {});
          event.headers["x-session-id"] = adSessionId;
          event.headers["x-client-version"] = AD_CLIENT_VERSION;
          event.headers["x-turn-id"] = currentTurnId;
          log(`model.request kind=${event.kind ?? "?"} warm=${warm} turn=${currentTurnId.slice(0, 8)}`);
        },
        { providerID: PROVIDER },
      );
      log("model.request hook registered");
    } catch (e) { log("model.request hook failed: " + (e?.message ?? e)); }

    // a paused account answers 403 ads_required — report an ad, then retry
    try {
      await ctx.session.hook("retry", async (event) => {
        const msg = String(event.error?.message ?? "");
        const status = Number(event.error?.status ?? 0);
        if (!/ads/i.test(msg)) return;
        if (status && status !== 403) return;
        if (event.attempt >= 3) return;
        log(`ads_required on attempt ${event.attempt} — re-reporting an ad`);
        const ok = await warmBounded("retry", { force: true }, 6_000);
        if (ok) event.decision = { retry: true, delay: 500 };
        else log("still paused after re-report — letting it fail");
      });
      log("retry hook registered");
    } catch (e) { log("retry hook failed: " + (e?.message ?? e)); }

    // debug event dump (FREEPI_METER_DEBUG)
    const ctl = new AbortController();
    if (process.env.FREEPI_METER_DEBUG) {
      try {
        void (async () => {
          for await (const ev of ctx.event.subscribe({ signal: ctl.signal })) {
            const t = ev?.type ?? "?";
            if (/error|execution|step|message\.updated|message\.part\.updated/.test(t)) {
              try { appendFileSync("/tmp/freepi-events.log", t + " " + JSON.stringify(ev).slice(0, 400) + "\n"); } catch {}
            }
          }
        })();
      } catch (e) { log("event subscribe failed: " + (e?.message ?? e)); }
    }

    return () => { clearInterval(timer); ctl.abort(); };
  },
};
