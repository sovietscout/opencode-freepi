/** @jsxImportSource @opentui/solid */
/** free-pi for OpenCode — self-contained replacement for the free-pi CLI.
 *
 * Meter   : footer credit meter, only while a free-pi model is selected.
 * Login   : /freepi-login — GitHub device flow; stores the token in OpenCode's
 *           credential store (live) and mirrors it to ~/.free-pi/agent/credentials.json.
 * Catalog : model catalog auto-syncs at startup and after every sign-in, so the
 *           config's model entries are plugin-maintained, never manual.
 * Ads     : pulls banner/inline ads on the same cadence as the free-pi CLI
 *           (launch + every user turn, inline every 5th turn) and reports
 *           impressions, without rendering anything.
 *
 * Env knobs: FREEPI_METER_POLL_MS, FREEPI_AD_INLINE_TURN_FREQUENCY,
 *           FREEPI_AD_CLIENT_VERSION, FREEPI_CREDS, FREEPI_METER_DEBUG.
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { arch, homedir } from "node:os";
import { join } from "node:path";
import { createSignal, onCleanup } from "solid-js";

const HOME = homedir();
const CREDS = process.env.FREEPI_CREDS || join(HOME, ".free-pi/agent/credentials.json");
const BASE = "https://api.freepi.ai";
const PROVIDER = "freepi";
const CONSENT_VERSION = "4";
const POLL_MS = Number(process.env.FREEPI_METER_POLL_MS ?? 60_000);
const AD_CLIENT_VERSION = process.env.FREEPI_AD_CLIENT_VERSION ?? "0.6.22";
const BANNER_MIN_REFRESH_MS = 60_000;
const LAUNCH_AD_MAX_AGE_MS = 60 * 60_000;
const INLINE_TURN_FREQUENCY = Number(process.env.FREEPI_AD_INLINE_TURN_FREQUENCY ?? 5);

function log(msg: string) {
  if (!process.env.FREEPI_METER_DEBUG) return;
  try { appendFileSync("/tmp/freepi-plugin.log", msg + "\n"); } catch {}
}

function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(HOME, ".config");
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const p = join(base, "opencode", name);
    if (existsSync(p)) return p;
  }
  return join(base, "opencode", "opencode.json");
}

/** Token mirror used by the meter (the live store is the server credential DB). */
function readToken(): string {
  try { return JSON.parse(readFileSync(CREDS, "utf8")).token ?? ""; } catch { return ""; }
}

async function post(path: string, body: unknown, token?: string, headers?: Record<string, string>): Promise<{ ok: boolean; status: number; data: any }> {
  const h: Record<string, string> = { "content-type": "application/json", ...(headers ?? {}) };
  if (token) h.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method: "POST", headers: h, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/* ---------------- meter ---------------- */

type Meter = { text: string; kind: "ok" | "auth" | "error" };

async function readMeter(): Promise<Meter> {
  const tok = readToken();
  if (!tok) return { text: "free-pi login required", kind: "auth" };
  try {
    const res = await fetch(BASE + "/me", { headers: { authorization: `Bearer ${tok}` } });
    if (res.status === 401 || res.status === 403) return { text: "free-pi login required", kind: "auth" };
    if (!res.ok) return { text: `free-pi err ${res.status}`, kind: "error" };
    const me = await res.json();
    // pools: daily allowance (resets 00:00 UTC), bonus wallet, premium (bought/gifted)
    const daily = me.remaining_credits_today;
    const fmt = (n: number) => n.toLocaleString("en-US");
    if (typeof daily !== "number") {
      const left = Number(me.remaining_usd_today ?? 0);
      const cap = Number(me.cap_usd_today ?? 0) || 1;
      const pct = Math.min(100, Math.max(0, Math.round((100 * (cap - left)) / cap)));
      return { text: `free-pi ${pct}% used`, kind: pct >= 90 ? "error" : "ok" };
    }
    const pools = [fmt(daily)];
    const bonus = Number(me.bonus_credits ?? me.bonus_wallet_credits ?? 0);
    if (bonus > 0) pools.push(fmt(bonus));
    const premium = Number(me.premium_credits ?? 0);
    if (premium > 0) pools.push(fmt(premium));
    const allowance = Number(me.allowance_credits ?? 0);
    const kind: Meter["kind"] = allowance > 0 && daily < allowance * 0.1 ? "error" : "ok";
    return { text: `free-pi ${pools.join("+")}`, kind };
  } catch {
    return { text: "free-pi offline", kind: "error" };
  }
}

// Shared meter state lives at module level so mode switches (which remount the footer
// slot) restore the last value instantly — no loading flash, no extra /me fetch.
let sharedMeter: Meter | null = null;
let sharedInflight = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollUsers = 0;
const meterListeners = new Set<() => void>();

async function refreshMeter() {
  if (sharedInflight) return;
  sharedInflight = true;
  try {
    const next = await readMeter();
    if (next.text !== sharedMeter?.text || next.kind !== sharedMeter.kind) {
      sharedMeter = next;
      meterListeners.forEach((fn) => fn());
    }
  } finally { sharedInflight = false; }
}

function subscribeMeter(fn: () => void): () => void {
  meterListeners.add(fn);
  pollUsers += 1;
  if (!pollTimer) pollTimer = setInterval(() => void refreshMeter(), POLL_MS);
  void refreshMeter();
  return () => {
    meterListeners.delete(fn);
    pollUsers -= 1;
    if (pollUsers <= 0 && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  };
}

function Meter(props: any) {
  const api = props.api;
  const [meter, setMeter] = createSignal<Meter | null>(sharedMeter);
  onCleanup(subscribeMeter(() => setMeter(sharedMeter)));
  const hex = (c: any): string | undefined => {
    const b = c?.buffer;
    if (b && typeof b === "object") {
      return "#" + [b[0] ?? 0, b[1] ?? 0, b[2] ?? 0]
        .map((v: number) => Number(v).toString(16).padStart(2, "0")).join("");
    }
    return typeof c === "string" ? c : undefined;
  };
  const color = (m: Meter | null) => {
    const t = api?.theme?.text;
    if (!m || !t) return undefined;
    if (m.kind === "auth") return hex(t.feedback?.warning?.base);
    if (m.kind === "error") return hex(t.feedback?.error?.base);
    return hex(t.muted);
  };
  return <text fg={color(meter())}>{meter() ? ` ${meter().text}` : " free-pi …"}</text>;
}

/* ---------------- login (GitHub device flow) ---------------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function deviceFlow(status: (s: string) => void, isCancelled: () => boolean): Promise<string> {
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } })();

  const base0 = "Open: https://github.com/login/device\nwaiting for a device code…";
  status(base0);
  const start = await post("/auth/github/device", {});
  if (start.status >= 500) throw new Error("free-pi is unreachable right now — try again later");
  if (!start.ok || !start.data?.session_id) throw new Error(`could not start sign-in (HTTP ${start.status})`);
  const { session_id, user_code, verification_uri, interval = 5, expires_in = 899 } = start.data;

  const consent = await post("/auth/consent", { session_id, consent_version: CONSENT_VERSION });
  if (!consent.ok) throw new Error(`consent failed (HTTP ${consent.status})`);

  const base = `Open: ${verification_uri ?? "https://github.com/login/device"}\ncode: ${user_code}\nwaiting for approval…`;
  status(base);
  const deadline = Date.now() + expires_in * 1000;
  let wait = interval;
  while (Date.now() < deadline) {
    if (isCancelled()) throw new Error("cancelled");
    await sleep(wait * 1000);
    if (isCancelled()) throw new Error("cancelled");
    let res: { ok: boolean; status: number; data: any };
    try {
      res = await post("/auth/token", { session_id, timezone: tz });
    } catch {
      status(base + "\nnetwork hiccup — still waiting…");   // transient; keep polling
      continue;
    }
    if (res.ok && res.data?.token) return res.data.token;
    if (res.ok && res.data?.status === "pending") {
      if (typeof res.data.retry_after === "number" && res.data.retry_after > wait) wait = res.data.retry_after;
      continue;
    }
    if (res.status === 403 && res.data?.code === "denied") throw new Error("sign-in denied — approve the request in the browser, or start over");
    if (res.status === 410 || res.data?.code === "expired") throw new Error("code expired — run /freepi-login again");
    if (res.status >= 500) { status(base + "\nfree-pi hiccup — still waiting…"); continue; }
    throw new Error(`sign-in failed (HTTP ${res.status})`);
  }
  throw new Error("timed out — run /freepi-login again");
}

/** Store the token: mirror file for the meter + live OpenCode credential store. */
async function storeToken(api: any, token: string): Promise<void> {
  mkdirSync(join(HOME, ".free-pi/agent"), { recursive: true });
  writeFileSync(CREDS, JSON.stringify({ token }, null, 2) + "\n");
  try {
    // replace any older freepi credentials, then register the fresh one (live, no restart)
    const cred = (api.client as any)?.credential;
    if (cred?.list && cred?.create) {
      const list = await cred.list();
      const rows = Array.isArray(list) ? list : (list?.data?.data ?? list?.data ?? []);
      for (const c of rows.filter((c: any) => c.integrationID === PROVIDER)) {
        try { await cred.remove({ credentialID: c.id }); } catch { try { await cred.remove({ id: c.id }); } catch (e: any) { log("cred remove failed: " + (e?.message ?? e)); } }
      }
      await cred.create({ integrationID: PROVIDER, value: { type: "key", key: token }, label: "free-pi", activate: true });
    } else {
      const raw = (api.client as any)?.client;
      const list = await raw.get({ url: "/api/credential" });
      for (const c of (list?.data?.data ?? []).filter((c: any) => c.integrationID === PROVIDER)) {
        try { await raw.delete({ url: `/api/credential/${c.id}` }); } catch (e: any) { log("cred delete failed: " + (e?.message ?? e)); }
      }
      await raw.post({ url: "/api/credential", body: { integrationID: PROVIDER, value: { type: "key", key: token }, label: "free-pi", activate: true } });
    }
  } catch (e: any) {
    throw new Error(`token saved, but OpenCode's credential store update failed (${e?.message ?? e}) — requests may fail until you restart and re-run /freepi-login`);
  }
}

/* ---------------- catalog sync ---------------- */

function modelLabel(m: any): string {
  let label = m.display_name ?? m.id;
  if (m.section) label += ` (${m.section})`;
  if (m.free) label += " (free)";
  if (m.usage_x) label += ` (~${m.usage_x}x usage)`;
  return label;
}

function buildModels(list: any[]): Record<string, any> {
  return Object.fromEntries(list.map((m: any) => [m.id, {
    name: modelLabel(m),
    modelID: m.id,
    limit: { context: 200000, output: 32768 },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
  }]));
}

async function fetchCatalog(token: string): Promise<any[]> {
  const res = await fetch(BASE + "/client-version", { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 401 || res.status === 403) throw new Error("not signed in or token expired — run /freepi-login");
  if (!res.ok) throw new Error(`/client-version HTTP ${res.status}`);
  const data = await res.json();
  const list = data.models ?? [];
  if (!list.length) throw new Error("catalog returned no models");
  return list;
}

/** Write models into the config file. Returns "written" | "unchanged" | throws. */
function writeCatalog(list: any[]): "written" | "unchanged" {
  const p = configPath();
  let cfg: any;
  try { cfg = JSON.parse(readFileSync(p, "utf8")); } catch { throw new Error(`cannot parse ${p} (JSONC not supported)`); }
  cfg.providers ??= {};
  if (!cfg.providers[PROVIDER]) {
    cfg.providers[PROVIDER] = {
      name: "free-pi",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: BASE + "/v1" },
    };
  }
  const models = buildModels(list);
  if (JSON.stringify(cfg.providers[PROVIDER].models ?? null) === JSON.stringify(models)) return "unchanged";
  cfg.providers[PROVIDER].models = models;
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
  return "written";
}

async function syncCatalog(): Promise<number> {
  const tok = readToken();
  if (!tok) throw new Error("not signed in — run /freepi-login first");
  const list = await fetchCatalog(tok);
  const result = writeCatalog(list);
  if (result === "unchanged") return -list.length;   // negative = already current
  return list.length;
}

/* ---------------- ads (pull + report impressions, never render) ----------------
 * Mirrors the free-pi CLI cadence: banner on launch and on every user turn
 * (forced), inline slot every 5th turn end, banner re-fetch throttled to 60s.
 * Impression = gravity pixel GET (when applicable) + POST /ads/impression,
 * deduped per click_token exactly like the CLI. */

const adSessionId = crypto.randomUUID();
let currentTurnId = "";
let lastBannerAt = 0;
let bannerInFlight = false;
let launchToken: string | undefined;
let launchAt = 0;
let launchTurnUnused = false;
let lastBannerClickToken: string | undefined;
let lastInlineClickToken: string | undefined;
let turnCount = 0;

function isGravityImpUrl(raw: any): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && /(^|\.)trygravity\.(ai|com)$/.test(u.hostname);
  } catch { return false; }
}

async function fetchAd(slot: string, trigger?: string): Promise<any> {
  const tok = readToken();
  if (!tok) return;
  const headers: Record<string, string> = {
    authorization: `Bearer ${tok}`,
    "x-session-id": adSessionId,
    "x-client-version": AD_CLIENT_VERSION,
    "x-client-os": process.platform,
    "x-client-arch": arch(),
  };
  if (currentTurnId) headers["x-turn-id"] = currentTurnId;
  if (trigger) headers["x-ad-trigger"] = trigger;
  const res = await fetch(`${BASE}/ads/next?slot=${slot}`, { headers });
  log(`ads/next slot=${slot} trigger=${trigger ?? "-"} -> ${res.status}`);
  if (res.status === 204 || !res.ok) return;
  return await res.json().catch(() => undefined);
}

async function reportImpression(ad: any, slot: "banner" | "inline"): Promise<void> {
  if (!ad?.ad_id || !ad?.click_token) return;
  const last = slot === "inline" ? lastInlineClickToken : lastBannerClickToken;
  if (last === ad.click_token) return;
  if (slot === "inline") lastInlineClickToken = ad.click_token;
  else lastBannerClickToken = ad.click_token;
  log(`impression: ad=${ad.ad_id} slot=${slot} source=${ad.source ?? "?"} token_changed=yes`);
  let impFired = false;
  if (ad.source === "gravity" && isGravityImpUrl(ad.imp_url)) {
    try { fetch(ad.imp_url, { method: "GET" }).catch(() => {}); impFired = true; } catch {}
  }
  try {
    await post("/ads/impression", { ad_id: ad.ad_id, click_token: ad.click_token, ...(impFired ? { imp_fired: true } : {}) }, readToken());
  } catch (e: any) { log("impression POST failed: " + (e?.message ?? e)); }
}

async function pullBanner(trigger: "launch" | "user_message" | "turn_end", force = false): Promise<void> {
  if (bannerInFlight) return;
  if (!force && Date.now() - lastBannerAt < BANNER_MIN_REFRESH_MS) return;
  bannerInFlight = true;
  lastBannerAt = Date.now();
  try {
    const ad = await fetchAd("banner", trigger);
    if (ad) await reportImpression(ad, "banner");
  } catch (e: any) { log("banner pull failed: " + (e?.message ?? e)); }
  finally { bannerInFlight = false; }
}

async function pullInline(): Promise<void> {
  if (INLINE_TURN_FREQUENCY === 0) return;
  turnCount += 1;
  if (turnCount % INLINE_TURN_FREQUENCY !== 0) return;
  try {
    const ad = await fetchAd("inline");
    if (ad) await reportImpression(ad, "inline");
  } catch (e: any) { log("inline pull failed: " + (e?.message ?? e)); }
}

/** Per user turn: fresh turn id + forced banner pull, with the CLI's launch dedupe. */
function onUserTurn(): void {
  if (launchTurnUnused) {
    launchTurnUnused = false;
    const token = readToken();
    if (token && token === launchToken && Date.now() - launchAt < LAUNCH_AD_MAX_AGE_MS) return;
  }
  currentTurnId = crypto.randomUUID();
  void pullBanner("user_message", true);
}

/* ---------------- plugin ---------------- */

export default {
  id: "freepi",
  setup(api: any) {
    const isFreepi = () => api.ui.model.current?.()?.providerID === PROVIDER;

    api.ui.slot({
      append: "prompt.footer.status",
      render: () => (isFreepi() ? <Meter api={api} /> : null),
    });

    let loggingIn = false;

    const runLogin = async () => {
      if (loggingIn) { api.ui.toast.show({ message: "free-pi login already running", variant: "warning" }); return; }
      loggingIn = true;
      const cancelled = { v: false };
      const [status, setStatus] = createSignal("starting…");
      try {
        let choice = "yes";
        try {
          const c = await api.ui.dialog.select({
            title: "free-pi sign-in",
            options: [
              { title: "Accept and sign in — ads + may train on data (freepi.ai/terms)", value: "yes" },
              { title: "Cancel", value: "no" },
            ],
          });
          if (c != null) choice = c;
        } catch (e: any) { log("dialog.select unavailable: " + (e?.message ?? e)); }
        if (choice !== "yes") return;

        let dialogOk = true;
        try {
          api.ui.dialog.show(
            () => (
              <box flexDirection="column" gap={1} padding={2}>
                <text>free-pi sign-in</text>
                <text>{status()}</text>
                <text>Esc to cancel</text>
              </box>
            ),
            () => { cancelled.v = true; },
          );
        } catch (e: any) {
          dialogOk = false;
          log("dialog.show unavailable: " + (e?.message ?? e));
        }

        const onStatus = (s: string) => {
          setStatus(s);
          if (!dialogOk) api.ui.toast.show({ message: `free-pi: ${s}`, variant: "info", duration: 10000 });
        };

        const token = await deviceFlow(onStatus, () => cancelled.v);
        try { api.ui.dialog.clear(); } catch {}
        await storeToken(api, token);

        // sync the catalog as part of every sign-in
        let syncNote = "";
        try {
          const n = await syncCatalog();
          syncNote = n >= 0 ? ` — ${n} models synced` : " — model catalog already current";
        } catch (e: any) {
          syncNote = ` — model sync failed: ${e?.message ?? e}`;
          log("post-login sync failed: " + (e?.message ?? e));
        }
        api.ui.toast.show({ message: `free-pi: signed in${syncNote}`, variant: "success", duration: 8000 });
        log("login ok");
      } catch (e: any) {
        try { api.ui.dialog.clear(); } catch {}
        const msg = e?.message ?? String(e);
        if (msg !== "cancelled") api.ui.toast.show({ message: `free-pi login failed: ${msg}`, variant: "error", duration: 8000 });
        log("login failed: " + msg);
      } finally {
        loggingIn = false;
      }
    };

    // /freepi-sync removed — the catalog auto-syncs at startup and after every sign-in,
    // so a manual command would only ever repeat what already happens.

    // slash commands — must match the built-in command shape (palette: true, mode: "global")
    api.keymap.layer(() => ({
      mode: "global",
      commands: [
        { id: "freepi.login", group: "free-pi", bind: false, palette: true, title: "Sign in to free-pi", suggested: true, slash: { name: "freepi-login" }, run: () => void runLogin() },
      ],
    }));

    // startup: restore the credential into OpenCode's store if missing (e.g. migrating
    // from the free-pi CLI), auto-sync the catalog, and pull the launch ad
    void (async () => {
      const tok = readToken();
      if (!tok) return;
      try {
        const cred = (api.client as any)?.credential;
        const list = cred?.list ? await cred.list() : undefined;
        const rows = Array.isArray(list) ? list : (list?.data?.data ?? list?.data ?? []);
        const mine = (Array.isArray(rows) ? rows : []).filter((c: any) => c.integrationID === PROVIDER);
        // keep one freepi credential (prefer active/current-token), drop the rest
        const keep = mine.find((c: any) => c.active && c.value?.key === tok)
          ?? mine.find((c: any) => c.value?.key === tok)
          ?? mine.find((c: any) => c.active)
          ?? mine[0];
        const has = Boolean(keep && keep.value?.key === tok);
        for (const c of mine.filter((c: any) => c.id !== keep?.id)) {
          let removed = false;
          for (const arg of [{ credentialID: c.id }, { id: c.id }]) {
            try { await cred.remove(arg); removed = true; break; } catch (e: any) { log("remove " + JSON.stringify(arg) + " ERR: " + (e?.message ?? e).slice(0, 120)); }
          }
          log("dedupe remove " + c.id + " -> " + (removed ? "ok" : "failed"));
        }
        log(`credential check: rows=${mine.length} has=${has}`);
        if (!has) {
          await storeToken(api, tok);
          log("credential auto-restored at startup (silent)");
        }
      } catch (e: any) { log("credential restore failed: " + (e?.message ?? e)); }
      try {
        const cat = await fetchCatalog(tok);
        if (writeCatalog(cat) === "written") {
          api.ui.toast.show({ message: "free-pi: model catalog updated — restart to apply", variant: "info", duration: 6000 });
        }
      } catch (e: any) { log("startup sync failed: " + (e?.message ?? e)); }
      launchToken = tok;
      launchAt = Date.now();
      launchTurnUnused = true;
      void pullBanner("launch", true);
    })();

    // turn lifecycle: banner ad per user turn, inline ad every 5th turn end,
    // meter refresh on turn completion
    let turnAdPulled = false;
    try {
      api.data.on("session.step.started", () => {
        if (turnAdPulled || !isFreepi()) return;
        turnAdPulled = true;
        onUserTurn();
      });
      api.data.on("session.execution.succeeded", () => {
        turnAdPulled = false;
        void pullInline();
        void refreshMeter();
      });
    } catch (e: any) { log("turn event subscribe failed: " + (e?.message ?? e)); }

    // surface auth failures on free-pi requests as an actionable hint
    // (verified: both "missing bearer token" and "invalid or expired token" arrive as
    //  session.execution.failed with data.error = {type:"provider.auth", status:401})
    let lastAuthToast = 0;
    try {
      api.data.on("session.execution.failed", (evt: any) => {
        try {
          turnAdPulled = false;
          const err = evt?.data?.error ?? evt?.error;
          const type = err?.type ?? "";
          const status = Number(err?.status ?? 0);
          const msg = String(err?.message ?? "");
          log("execution.failed: type=" + type + " status=" + status + " msg=" + msg.slice(0, 120));
          if (!isFreepi()) return;
          // stale-daemon failure mode: config gained/changed freepi models after the
          // service daemon started — it never reloads, so runs fail until restart.
          if (/model unavailable/i.test(msg)) {
            const now2 = Date.now();
            if (now2 - lastAuthToast >= 30_000) {
              lastAuthToast = now2;
              api.ui.toast.show({ message: "free-pi: opencode needs a restart to pick up model changes (not a sign-in issue)", variant: "warning", duration: 10000 });
            }
            return;
          }
          const authFail = type === "provider.auth" || status === 401 || status === 403 || /token|unauthorized|bearer/i.test(msg);
          if (!authFail) return;
          const now = Date.now();
          if (now - lastAuthToast < 30_000) return;
          lastAuthToast = now;
          api.ui.toast.show({ message: "free-pi: sign-in required or token expired — run /freepi-login", variant: "warning", duration: 10000 });
        } catch (e: any) { log("execution.failed handler error: " + (e?.message ?? e)); }
      });
    } catch (e: any) { log("execution.failed subscribe failed: " + (e?.message ?? e)); }
  },
};
