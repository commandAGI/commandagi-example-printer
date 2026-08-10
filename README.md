# commandagi-example-printer

Turn an idle 3D printer into camera-monitorable, marketplace-available capacity on
[**CommandAGI**](https://commandagi.com).

This is a small, self-contained **example host**: it connects a Marlin-firmware FDM
printer — a [Creality Ender 3 V3 SE](https://www.creality.com/) and friends — to
CommandAGI as a **bring-your-own (`byo.printer`) device**, publishes its build-plate
status, goes online, and runs print jobs that come to it.

It's intentionally minimal and dependency-light so you can read the whole integration
in one sitting. A production deployment would use the first-party runtime (which also
streams a camera and joins each job's realtime control plane) — this repo shows the
_shape_ of the connection in ~450 lines of plain Node.

> [!WARNING]
> **This software moves real hardware.** When it runs a job it will home the axes,
> **heat the nozzle (200 °C+) and bed (60 °C+)**, and drive the motors. Never run it
> on an unattended printer, keep it in view, and know where your power switch is.

---

## What it is

- **`src/fdm.mjs`** — a self-contained Marlin gcode driver over serial: `ok`-based
  flow control (one command in flight at a time), `M105` temperature polling, and the
  lifecycle verbs (`G28` home, `M104`/`M140` set temps, `M24`/`M25` resume/pause,
  `M0`/`M84` stop + motors-off). Mirrors the production driver, standalone.
- **`src/index.mjs`** — the connector: register the printer with CommandAGI, open the
  serial port, publish periodic status, go online, and poll for + run nearby print jobs.

## Why

Your printer sits idle most of the day. CommandAGI is a marketplace for real-world
machine capacity: bring a device online and located jobs come to it, you accept the
ones you want, and you're paid per job. A 3D printer is a natural fit — a well-defined,
camera-verifiable unit of work (a print) with a clean start/finish.

## Prerequisites

- A **Marlin-firmware FDM printer** (Ender 3 V3 SE tested) connected over **USB**.
- **Node.js 20+**.
- A **CommandAGI account** and a **device API key** (`cagi_…`) — mint one in the app
  under Settings → API keys.

## Quickstart

```bash
git clone https://github.com/CommandAGI/commandagi-example-printer
cd commandagi-example-printer
npm install
cp .env.example .env          # then edit .env — paste your cagi_ key + serial port
# plug the printer in over USB, power it on
npm start
```

You should see it register the device, connect to the serial port, and go online.
No printer handy? Leave `PRINTER_SERIAL_PORT` pointing at a device that doesn't exist
and it degrades honestly to **register + report-only** mode (no job running).

## What happens

1. **Register** — announces the printer to CommandAGI as a `byo.printer` device with
   its capabilities (FDM, Marlin, 220×220×250 build volume, single extruder).
2. **Connect** — opens the serial port and starts an `M105` temperature poll.
3. **Publish status** — reports phase, progress, and nozzle/bed temps on a heartbeat.
4. **Go online** — announces presence (location + `byo.printer` class) so the pool can
   route jobs to it.
5. **Accept + run** — polls `GET /jobs/nearby`, accepts a matching job, fetches its
   gcode, and streams it to the printer line-by-line with flow control.

### The endpoints it uses

| Step            | Call                                                    |
| --------------- | ------------------------------------------------------- |
| Register device | `POST /rental-devices`                                  |
| Go online       | `POST /me/presence`                                     |
| Find work       | `GET /jobs/nearby?lat=&lng=&radiusM=&class=byo.printer` |
| Accept a job    | `POST /market/byo.printer/orders/:id/accept`            |
| Go offline      | `DELETE /me/presence`                                   |

All authenticated with your `cagi_` key as a `Bearer` token. A couple of payload
details (the printer-native registration + the job's gcode field) are marked with
`TODO(commandagi)` in the source and linked to the docs — they'll firm up as the
printer device type is finalized.

## Going live (earning)

Accepting **paid, located** work is gated server-side on a fully onboarded worker —
identity verification (KYC), a payout account, and per-job consent. Until that's
complete, `POST …/accept` returns `403` and this example logs it and keeps polling.
See [commandagi.com/docs/work](https://commandagi.com/docs/work) for the onboarding.

## Safety notes

- It **heats the nozzle and bed and moves the printer.** Supervise every run.
- On cancel or completion it turns heaters **off** and (on cancel) disables steppers
  (`M104 S0` / `M140 S0` / `M84`) to leave a safe machine.
- Gcode is streamed as-is. Only accept jobs whose gcode is sliced for **your** printer
  and material — wrong start-gcode can crash the nozzle into the bed.
- This is example code with **no warranty** (MIT). You are responsible for your machine.

## Learn more

- [Go online & earn](https://commandagi.com/docs/work)
- [Host hardware to earn](https://commandagi.com/docs/host)
- [CommandAGI](https://commandagi.com)

## License

MIT © CommandAGI — see [LICENSE](./LICENSE).
