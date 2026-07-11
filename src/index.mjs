#!/usr/bin/env node
// index.mjs — connect a Marlin FDM printer (e.g. a Creality Ender 3 V3 SE) to
// CommandAGI as a bring-your-own (BYO) device, publish its build-plate status,
// go online in the marketplace, and run print jobs that come to it.
//
// This is a deliberately small, readable EXAMPLE. A production host would use the
// first-party runtime (apps/host-node / packages/host-core in the CommandAGI
// monorepo), which also streams a camera and joins each job's realtime WebSocket
// control plane. Here we keep it to plain `fetch` + a serial driver so the shape
// of the integration is easy to follow.
//
// Flow:
//   1. Load config from the environment (.env).
//   2. Register / announce the printer to CommandAGI with a device API key.
//   3. Open the serial port and start polling temperatures (src/fdm.mjs).
//   4. Publish periodic status (nozzle/bed temp, phase, progress).
//   5. Go online via presence, then poll for nearby jobs and run their gcode.
//
// Docs: https://commandagi.com/docs/work  and  https://commandagi.com/docs/host

import { FdmSerial } from "./fdm.mjs";

// ─── 1. config ──────────────────────────────────────────────────────────────

const cfg = {
  apiKey: requireEnv("CAGI_API_KEY"), // a device/operator key, "cagi_…", from the app
  apiBase: (process.env.CAGI_API_BASE ?? "https://api.commandagi.com").replace(/\/$/, ""),
  serialPort: process.env.PRINTER_SERIAL_PORT ?? "/dev/ttyUSB0",
  baud: Number(process.env.PRINTER_BAUD ?? 115200),
  printerName: process.env.PRINTER_NAME ?? "Ender 3 V3 SE",
  // Where the printer physically is + how far it will serve jobs. A printer is
  // stationary, so its "service radius" is really just the pool it belongs to.
  lat: numOrUndef(process.env.PRINTER_LAT),
  lng: numOrUndef(process.env.PRINTER_LNG),
  radiusM: Number(process.env.SERVICE_RADIUS_M ?? 25000),
  // Poll cadences.
  statusEveryMs: 5000,
  jobsEveryMs: 8000,
};

// The BYO resource class for an FDM printer. Maps from kind "printer" →
// "byo.printer" in the platform ontology (packages/core/src/ontology.ts).
const RESOURCE_CLASS = "byo.printer";

// ─── a tiny CommandAGI REST client ────────────────────────────────────────────

/**
 * Authenticated JSON fetch against the CommandAGI API. All endpoints accept a
 * `cagi_` key as a Bearer token (see docs/AUTH.md / docs/DEVICES.md).
 * @param {string} method
 * @param {string} path   e.g. "/me/presence"
 * @param {object} [body]
 */
async function api(method, path, body) {
  const res = await fetch(`${cfg.apiBase}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${cfg.apiKey}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// ─── 2. register / announce the device ────────────────────────────────────────

/**
 * Register this printer as a rentable BYO device and get back its device id.
 *
 * We use the documented seller-device registration endpoint (POST /rental-devices,
 * see https://commandagi.com/docs/host). A printer has no `desktop|robot|simulation`
 * kind of its own yet, so we register it as a `robot`-shaped device and pin its
 * resource class to "byo.printer".
 *
 * TODO(commandagi): a first-class printer registration + capability announce
 *   (build volume, extruders, materials, camera-monitorable) is on the roadmap —
 *   track it at https://commandagi.com/docs/devices . When it lands, swap this
 *   call for the printer-native endpoint and send the capabilities block below.
 */
async function registerDevice() {
  const capabilities = {
    technology: "fdm",
    firmware: "marlin",
    buildVolumeMm: { x: 220, y: 220, z: 250 }, // Ender 3 V3 SE
    extruders: 1,
    cameraMonitorable: true,
  };
  const reg = await api("POST", "/rental-devices", {
    kind: "robot",
    name: cfg.printerName,
    resourceClass: RESOURCE_CLASS,
    // `capabilities` is accepted-but-ignored by the current endpoint; sent here to
    // show the intended shape (and forward-compatible with the printer-native API).
    capabilities,
  });
  log(`registered device ${reg.id} as ${RESOURCE_CLASS} (${cfg.printerName})`);
  return reg;
}

// ─── 4. publish status ────────────────────────────────────────────────────────

/**
 * Publish the printer's live build-plate status.
 *
 * In the full runtime this is a frame on the device's realtime WebSocket (a
 * `status` channel alongside the build-plate camera). This example just logs it
 * and, best-effort, refreshes presence so the pool knows we're alive. Replace the
 * body of this function with your own telemetry sink (or the WS runtime) as needed.
 * @param {FdmSerial} printer
 */
async function publishStatus(printer, deviceId) {
  const s = printer.status;
  log(
    `status device=${deviceId} phase=${s.phase} progress=${s.progressPct}% ` +
      `nozzle=${s.nozzleTempC}/${s.nozzleTargetC}C bed=${s.bedTempC}/${s.bedTargetC}C`,
  );
  // Heartbeat presence so we stay in the "online workers" set.
  await goOnline().catch((err) => log(`presence heartbeat failed: ${err.message}`, "warn"));
}

// ─── 5. presence + accept loop ────────────────────────────────────────────────

/** Announce (or refresh) availability: our location, radius, and the classes we serve. */
async function goOnline() {
  await api("POST", "/me/presence", {
    online: true,
    lat: cfg.lat ?? null,
    lng: cfg.lng ?? null,
    radiusM: cfg.radiusM,
    classes: [RESOURCE_CLASS],
    notifyEnabled: true,
  });
}

/** Stop advertising availability (called on shutdown). */
async function goOffline() {
  await api("DELETE", "/me/presence").catch(() => {});
}

/**
 * Poll for nearby jobs matching our class; if one is open, accept it and run it.
 *
 * NOTE ON GOING LIVE: accepting located, paid work is gated server-side on a fully
 * onboarded worker (identity/KYC + payout account + consent). Until that's done the
 * accept call returns 403 — expected, and handled below. See
 * https://commandagi.com/docs/work .
 * @param {FdmSerial} printer
 */
async function pollAndRunJobs(printer) {
  if (cfg.lat == null || cfg.lng == null) return; // no location → nothing to match against
  if (printer.status.phase === "printing" || printer.status.phase === "paused") return; // busy

  const q = new URLSearchParams({
    lat: String(cfg.lat),
    lng: String(cfg.lng),
    radiusM: String(cfg.radiusM),
    class: RESOURCE_CLASS,
  });
  const { jobs } = await api("GET", `/jobs/nearby?${q.toString()}`);
  if (!jobs?.length) return;

  const job = jobs[0];
  log(`found nearby job ${job.id} (${RESOURCE_CLASS}) — accepting`);
  try {
    // Accept the resting bid: POST /market/:resourceClass/orders/:id/accept
    await api("POST", `/market/${RESOURCE_CLASS}/orders/${job.id}/accept`, {
      geo: { lat: cfg.lat, lng: cfg.lng, radiusM: cfg.radiusM },
    });
  } catch (err) {
    if (err.status === 403) {
      log(`accept blocked (worker onboarding incomplete): ${JSON.stringify(err.body)}`, "warn");
      return;
    }
    throw err;
  }

  // Fetch the job's gcode. The exact field carrying the gcode (a URL vs inline)
  // depends on how the job was posted; support both shapes honestly.
  // TODO(commandagi): confirm the job payload's gcode field name once the printer
  //   job schema is finalized — see https://commandagi.com/docs/devices .
  const gcodeUrl = job.gcodeUrl ?? job.payload?.gcodeUrl;
  let gcode = job.gcode ?? job.payload?.gcode;
  if (!gcode && gcodeUrl) gcode = await (await fetch(gcodeUrl)).text();
  if (!gcode) {
    log(`job ${job.id} accepted but carried no gcode — skipping run`, "warn");
    return;
  }

  log(`running job ${job.id} (${gcode.length} bytes of gcode)`);
  await printer.start({ id: job.id, gcode });
  // printer.status advances to 100% / idle on its own; publishStatus reports it.
}

// ─── orchestration ────────────────────────────────────────────────────────────

async function main() {
  log(`CommandAGI printer host — ${cfg.printerName} on ${cfg.serialPort} @ ${cfg.baud}`);

  // 2. register with CommandAGI.
  const device = await registerDevice();

  // 3. open the serial port.
  const printer = new FdmSerial({ path: cfg.serialPort, baud: cfg.baud });
  try {
    await printer.connect();
    log(`serial connected on ${cfg.serialPort}`);
  } catch (err) {
    // Honest degrade: without the printer plugged in (or `serialport` uninstalled)
    // we still register + report, but can't run jobs. Great for a dry run.
    log(`serial unavailable (${err.message}) — running in report-only mode`, "warn");
  }

  // 5a. go online.
  await goOnline().catch((err) => log(`initial go-online failed: ${err.message}`, "warn"));
  log("online — advertising as a byo.printer worker");

  // graceful shutdown: go offline + release the port.
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log("shutting down — going offline");
    await goOffline();
    await printer.dispose().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // 4 + 5b. status heartbeat and job loop.
  const statusTimer = setInterval(
    () => void publishStatus(printer, device.id).catch((e) => log(e.message, "warn")),
    cfg.statusEveryMs,
  );
  const jobTimer = setInterval(
    () => void pollAndRunJobs(printer).catch((e) => log(`job loop: ${e.message}`, "warn")),
    cfg.jobsEveryMs,
  );
  if (typeof statusTimer.unref === "function") statusTimer.unref();
  if (typeof jobTimer.unref === "function") jobTimer.unref();

  // Keep the process alive.
  await new Promise(() => {});
}

// ─── small helpers ─────────────────────────────────────────────────────────────

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name}. Copy .env.example → .env and fill it in.`);
    process.exit(1);
  }
  return v;
}

function numOrUndef(v) {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function log(msg, level = "info") {
  const ts = new Date().toISOString();
  const tag = level === "warn" ? "WARN" : "INFO";
  console.log(`${ts} [${tag}] ${msg}`);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
