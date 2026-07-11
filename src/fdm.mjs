// fdm.mjs — a self-contained Marlin/FDM gcode driver over a serial port.
//
// This mirrors the production host driver (apps/host-node/src/printer.ts in the
// CommandAGI monorepo) but is dependency-light and standalone so it reads as an
// example. It speaks the classic Marlin host protocol:
//
//   * write a gcode line, then wait for the board to ack with `ok` (flow control:
//     exactly one command in flight at a time);
//   * poll temperatures with `M105` and parse the `T:210 /210 B:60 /60` reports;
//   * map the print lifecycle onto gcode verbs — `G28` home, `M104`/`M140`
//     set nozzle/bed temp, `M24`/`M25` resume/pause, `M0` stop, `M84` motors off.
//
// The `serialport` npm package is the one dependency. It is dynamically imported
// so this file can be `node --check`ed / imported without hardware present.

/**
 * Split a gcode program into the executable lines to stream: trim whitespace,
 * drop blank lines and full-line comments, and strip trailing `; …` comments.
 * @param {string} gcode
 * @returns {string[]}
 */
export function parseGcode(gcode) {
  const out = [];
  for (const raw of gcode.split(/\r?\n/)) {
    let line = raw;
    const semi = line.indexOf(";");
    if (semi >= 0) line = line.slice(0, semi);
    line = line.trim();
    if (line) out.push(line);
  }
  return out;
}

/**
 * Parse a Marlin temperature report (`T:210.0 /210.0 B:60.0 /60.0 …`).
 * @param {string} line
 * @returns {{nozzle?:number,nozzleTarget?:number,bed?:number,bedTarget?:number}|null}
 */
export function parseTempReport(line) {
  if (!/\bT:/.test(line) && !/\bB:/.test(line)) return null;
  const res = {};
  const t = line.match(/\bT:\s*(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/);
  if (t) {
    res.nozzle = Number(t[1]);
    res.nozzleTarget = Number(t[2]);
  }
  const b = line.match(/\bB:\s*(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/);
  if (b) {
    res.bed = Number(b[1]);
    res.bedTarget = Number(b[2]);
  }
  return res.nozzle == null && res.bed == null ? null : res;
}

/**
 * A Marlin FDM printer driven by streaming gcode over a serial line.
 *
 * Keeps a synchronous last-known status object (updated by the temp poller and
 * the job runner) so a caller can publish it without blocking on the wire.
 */
export class FdmSerial {
  /**
   * @param {object} opts
   * @param {string} opts.path          serial device path, e.g. "/dev/ttyUSB0" or "COM3"
   * @param {number} [opts.baud=115200] baud rate (Ender 3 V3 SE default is 115200)
   * @param {number} [opts.tempPollMs=3000]      temperature-poll interval (0 disables)
   * @param {number} [opts.commandTimeoutMs=20000] per-command `ok`-await timeout
   */
  constructor(opts) {
    this.path = opts.path;
    this.baud = opts.baud ?? 115200;
    this.tempPollMs = opts.tempPollMs ?? 3000;
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 20000;

    /** @type {any} */ this.sp = null; // the serialport SerialPort instance
    this.connected = false;
    this.buf = ""; // inbound byte buffer, split on \n into lines

    // One-at-a-time command queue (Marlin acks each line with `ok`).
    /** @type {null | {resolve:Function,reject:Function,timer:any,lines:string[]}} */
    this.pending = null;
    /** @type {Array<() => void>} */ this.queue = [];
    this.tempTimer = null;

    // Job-runner state.
    this.jobLines = [];
    this.jobCursor = 0;
    this.paused = false;
    this.cancelling = false;
    this.running = false;

    this.status = {
      phase: "idle", // idle | printing | paused | error
      nozzleTempC: 0,
      bedTempC: 0,
      nozzleTargetC: 0,
      bedTargetC: 0,
      progressPct: 0,
      jobId: undefined,
      error: undefined,
    };
  }

  /** Open the serial port and start the temperature poll. Idempotent. */
  async connect() {
    if (this.connected) return;
    // Dynamic import so `serialport` is a soft dependency: the file loads without it.
    const mod = await import("serialport").catch((err) => {
      throw new Error(
        `serialport not available (${err?.message ?? err}) — run \`npm install\` first`,
      );
    });
    const SerialPort = mod.SerialPort;
    this.sp = new SerialPort({ path: this.path, baudRate: this.baud });
    this.sp.on("data", (chunk) => this._onBytes(chunk));
    this.sp.on("error", () => {}); // surfaced via command timeouts / reject
    await new Promise((resolve, reject) => {
      this.sp.once("open", () => resolve());
      this.sp.once("error", reject);
    });
    this.connected = true;
    if (this.tempPollMs > 0) this._scheduleTempPoll();
  }

  /** Home all axes (`G28`). */
  async home() {
    await this.sendCommand("G28");
  }

  /** Set nozzle and/or bed target temps (`M104`/`M140`, non-blocking — no wait-for-temp). */
  async setTemp({ nozzle, bed } = {}) {
    if (typeof nozzle === "number") {
      await this.sendCommand(`M104 S${Math.round(nozzle)}`);
      this.status.nozzleTargetC = Math.round(nozzle);
    }
    if (typeof bed === "number") {
      await this.sendCommand(`M140 S${Math.round(bed)}`);
      this.status.bedTargetC = Math.round(bed);
    }
  }

  /**
   * Start streaming a gcode program. Returns immediately; progress advances on
   * `this.status`. Rejects a second concurrent job.
   * @param {{id?:string, gcode:string}} job
   */
  async start(job) {
    if (this.running || this.status.phase === "printing" || this.status.phase === "paused") {
      throw new Error("already_printing");
    }
    this.jobLines = parseGcode(job.gcode);
    if (this.jobLines.length === 0) throw new Error("empty_gcode");
    this.jobCursor = 0;
    this.paused = false;
    this.cancelling = false;
    this.status = { ...this.status, phase: "printing", progressPct: 0, jobId: job.id, error: undefined };
    void this._runJob();
  }

  /** Pause the stream between lines (firmware-side `M25` too, harmless when host-streaming). */
  async pause() {
    if (this.status.phase !== "printing") return;
    this.paused = true;
    this.status.phase = "paused";
    await this.sendCommand("M25").catch(() => {});
  }

  /** Resume a paused stream (`M24`). */
  async resume() {
    if (this.status.phase !== "paused") return;
    this.paused = false;
    this.status.phase = "printing";
    await this.sendCommand("M24").catch(() => {});
    if (!this.running) void this._runJob();
  }

  /** Cancel the active job and leave a SAFE machine: stop, heaters off, steppers off. */
  async cancel() {
    if (this.status.phase !== "printing" && this.status.phase !== "paused") return;
    this.cancelling = true;
    this.paused = false;
    await this.sendCommand("M0").catch(() => {}); // stop
    await this.sendCommand("M104 S0").catch(() => {}); // nozzle off
    await this.sendCommand("M140 S0").catch(() => {}); // bed off
    await this.sendCommand("M84").catch(() => {}); // steppers off
    this.jobLines = [];
    this.jobCursor = 0;
    this.status = { ...this.status, phase: "idle", progressPct: 0, jobId: undefined, nozzleTargetC: 0, bedTargetC: 0 };
  }

  /** Close the port and stop timers. */
  async dispose() {
    this.cancelling = true;
    if (this.tempTimer) clearTimeout(this.tempTimer);
    this.tempTimer = null;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error("disposed"));
      this.pending = null;
    }
    this.queue = [];
    const s = this.sp;
    this.sp = null;
    this.connected = false;
    if (s) await new Promise((r) => s.close(() => r()));
  }

  // ── the flow-control job runner ─────────────────────────────────────────────

  async _runJob() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.jobCursor < this.jobLines.length) {
        if (this.cancelling) break;
        if (this.paused) break; // suspended; resume() re-enters _runJob
        const line = this.jobLines[this.jobCursor];
        try {
          await this.sendCommand(line);
        } catch {
          this.status = { ...this.status, phase: "error", error: `command_failed_at_line_${this.jobCursor}` };
          this.running = false;
          return;
        }
        this.jobCursor++;
        this.status.progressPct = Math.round((this.jobCursor / this.jobLines.length) * 100);
      }
      // Whole program streamed → idle, heaters off.
      if (!this.paused && !this.cancelling && this.jobCursor >= this.jobLines.length) {
        await this.sendCommand("M104 S0").catch(() => {});
        await this.sendCommand("M140 S0").catch(() => {});
        this.status = { ...this.status, phase: "idle", progressPct: 100, jobId: undefined, nozzleTargetC: 0, bedTargetC: 0 };
      }
    } finally {
      this.running = false;
    }
  }

  // ── serial plumbing ─────────────────────────────────────────────────────────

  /**
   * Write a gcode line and resolve when Marlin acks with `ok`. Serialized: one
   * in-flight command at a time. Rejects on timeout / disconnect / `error`.
   * @param {string} line
   * @returns {Promise<string[]>} the non-ok reply lines seen before the `ok`
   */
  sendCommand(line) {
    return new Promise((resolve, reject) => {
      const run = () => {
        if (!this.sp || !this.connected) {
          reject(new Error("not_connected"));
          this._dequeue();
          return;
        }
        const timer = setTimeout(() => {
          if (this.pending) {
            this.pending = null;
            reject(new Error(`command_timeout:${line}`));
            this._dequeue();
          }
        }, this.commandTimeoutMs);
        if (typeof timer.unref === "function") timer.unref();
        this.pending = {
          lines: [],
          timer,
          resolve: (lines) => {
            resolve(lines);
            this._dequeue();
          },
          reject: (err) => {
            reject(err);
            this._dequeue();
          },
        };
        try {
          this.sp.write(`${line}\n`);
        } catch (err) {
          clearTimeout(timer);
          this.pending = null;
          reject(err instanceof Error ? err : new Error(String(err)));
          this._dequeue();
        }
      };
      if (this.pending) this.queue.push(run);
      else run();
    });
  }

  _dequeue() {
    const next = this.queue.shift();
    if (next) next();
  }

  _onBytes(chunk) {
    this.buf += chunk.toString("utf8");
    let nl;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, "");
      this.buf = this.buf.slice(nl + 1);
      this._onLine(line);
    }
  }

  _onLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    const temps = parseTempReport(trimmed);
    if (temps) {
      this.status = {
        ...this.status,
        nozzleTempC: temps.nozzle ?? this.status.nozzleTempC,
        bedTempC: temps.bed ?? this.status.bedTempC,
        nozzleTargetC: temps.nozzleTarget ?? this.status.nozzleTargetC,
        bedTargetC: temps.bedTarget ?? this.status.bedTargetC,
      };
    }
    const p = this.pending;
    if (!p) return;
    if (/^ok\b/i.test(trimmed)) {
      clearTimeout(p.timer);
      this.pending = null;
      p.lines.push(trimmed);
      p.resolve(p.lines);
    } else if (/^(error|!!)/i.test(trimmed)) {
      clearTimeout(p.timer);
      this.pending = null;
      p.reject(new Error(trimmed));
    } else {
      p.lines.push(trimmed); // an informational reply line (e.g. an M105 echo) — buffer until `ok`
    }
  }

  _scheduleTempPoll() {
    this.tempTimer = setTimeout(() => {
      // Fire-and-forget an M105; its reply updates temps via _onLine.
      void this.sendCommand("M105").catch(() => {});
      if (this.connected) this._scheduleTempPoll();
    }, this.tempPollMs);
    if (this.tempTimer && typeof this.tempTimer.unref === "function") this.tempTimer.unref();
  }
}
