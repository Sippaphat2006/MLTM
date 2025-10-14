# Machine Tower Light Monitoring (MLTM)

Real-time factory tower-light monitoring with **ESP32 + TCS34725**, a **Node.js/Express** API, a **MySQL** schema for interval logging, and a **Chart.js** dashboard for live visualization.

* Devices report color changes (`green | yellow | red`) and heartbeats to the API.
* The API **closes previous intervals and opens new ones atomically**, runs an **inactivity watchdog**, and serves the dashboard + assets.
* The dashboard shows **daily/weekly timelines**, **per-day totals**, and **month views**, with a time window pinned to **07:30 → next-day 07:30**. 

---

## Table of contents

* [Architecture](#architecture)
* [Features](#features)
* [Repo structure](#repo-structure)
* [Getting started](#getting-started)

  * [1) Database](#1-database)
  * [2) Server/API](#2-serverapi)
  * [3) Dashboard](#3-dashboard)
  * [4) ESP32 firmware](#4-esp32-firmware)
* [API](#api)
* [Data model](#data-model)
* [Operational behavior](#operational-behavior)
* [Configuration & environment](#configuration--environment)
* [Troubleshooting](#troubleshooting)
* [Roadmap](#roadmap)
* [License](#license)

---

## Architecture

```mermaid
flowchart LR
  subgraph Edge
    ESP[ESP32 + TCS34725\n(debounced color, heartbeat)]
  end

  subgraph Backend
    API[Node.js/Express API\n/ingest, /ingest/now, /ingest/upsert]
    DB[(MySQL\nmachines, status_colors, machine_status)]
  end

  subgraph Frontend
    Dash[Chart.js Dashboard\nDaily/Monthly/Timeline]
  end

  ESP -- HTTP JSON --> API
  API <--> DB
  Dash -- fetch --> API
  API -- static --> Dash
```

* Static files (dashboard & images) are served from `public/` (also aliased under `/assets`). 
* The API surface and controller functions live in `server_router.js` and `server_controller.js`. 

---

## Features

* **Interval logging**: Each color run is stored as a row with `start_time` and `end_time`; open runs have `end_time = NULL`. 
* **Fast ingest**: `/api/ingest/now` and `/api/ingest/upsert` **ACK immediately with 202** and complete DB work on an in-process queue, keeping devices snappy on lossy Wi-Fi. 
* **Inactivity watchdog**: Auto-closes an open interval if a machine goes silent (default ~45s) and reconciles on boot. 
* **“Unknown” handling**: If a device reports `unknown`, the API closes any open interval (“stop the timer”). 
* **ESP32 color classification**:

  * Uses **g/r** and **b/r** ratios with tight bands + **nearest-centroid fallback** for stability.
  * **Debounce** window for stable color (~200 ms), **heartbeat** (~15 s), **send on boot**, and **midnight re-post** current state. 
* **Dashboard**:

  * **Daily totals** (hh:mm:ss on y-axis). 
  * **Monthly runtime** with status toggles (Active/Setup/Alarm). 
  * **Status timeline** drawn as colored bars, pinned to **07:30 → next-day 07:30**. 
  * **Machine preview images** loaded from `/assets/machines/*.jpg`. 

---

## Repo structure

```
.
├─ server.js                 # Express setup, static hosting, timeouts              ← run this
├─ server_router.js          # API routes (/api/*)
├─ server_controller.js      # Controllers, queue, watchdog, ingest logic
├─ db.js                     # MySQL pool (mysql2/promise), connection opts
├─ public/                   # Static root (dashboard HTML, assets/)
│  └─ assets/
│     └─ machines/OKUMA CNC *.jpg
├─ Dashboard copy.html       # Dashboard (can be moved to public/)
└─ mltm.sql                  # MySQL schema + sample data
```

Static hosting and `/assets` aliasing are set up in `server.js`. 

---

## Getting started

### 1) Database

1. Create a MySQL database and import `mltm.sql`:

   ```sql
   -- in MySQL
   SOURCE /path/to/mltm.sql;
   ```

   The dump defines `machines`, `status_colors`, and `machine_status`, with demo rows to get you started. 

2. (Optional) Add your actual machine codes/names into `machines`.

3. Ensure the Node server can reach MySQL (host/port/user/pass). See **Configuration** below and `db.js`. 

### 2) Server/API

```bash
# from repo root
npm i express cors mysql2 date-fns
node server.js
```

* Default port: **3001**. You’ll see `Server running on port 3001`. 
* Base path: API mounted under `/api` (e.g., `GET /api/machines`). 
* Static hosting: `public/` at `/` and `/assets`. Place images under `public/assets/machines/`. 

### 3) Dashboard

* Open `Dashboard copy.html` in a browser, or move/rename it to `public/index.html` to have the server host it.
* Edit `API_BASE` near the top to match your server origin, e.g.:

  ```js
  const API_BASE = 'http://<server-ip>:3001/api';
  ```

  The dashboard fetches machines, timelines, and daily/weekly aggregates from the API routes listed below. 

### 4) ESP32 firmware

* Open the sketch in Arduino IDE/PlatformIO and set:

  * Wi-Fi SSID/PASS (do **not** commit real secrets),
  * `SERVER_BASE` (e.g., `http://<server-ip>:3001/api`),
  * `MACHINE_CODE` (`CNC1`, `CNC2`, …). 
* The firmware:

  * reads TCS34725, computes `g/r` & `b/r`,
  * classifies into green/yellow/red using bands + centroid fallback,
  * debounces for stability, then calls **`POST /api/ingest/now`**,
  * sends periodic **heartbeats** via **`POST /api/ingest/upsert`**. 

---

## API

Base URL: `http://<server>:3001/api` 

### Health & metadata

* `GET /health/db` → `{ ok, db }` (simple DB check). 
* `GET /colors` → `[{ id, name, hex }, ...]`. 
* `GET /machines` → `[{ id, code, name }, ...]`. 

### Per-machine

* `GET /machines/:code/status/current` → `{ color, hex, start_time } | { color:'unknown' }`. 
* `GET /machines/:code/status/by-date?date=YYYY-MM-DD` → totals seconds per color for that day. 
* `GET /machines/:code/timeline?date=YYYY-MM-DD` → `[ { color, hex, start_time, end_time }, ... ]`. 
* `GET /machines/:code/status/weekly?week_start=YYYY-MM-DD` → 7-day buckets. 
* `GET /machines/:code/touch/timeline?date=YYYY-MM-DD` → worker-reported segments (if available). 

### Overview

* `GET /overview/today` → `{ date, overview:[ { machine, current, buckets:[{color,seconds}...] } ] }`. 

### Ingest (from devices)

All ingest endpoints **immediately ACK** with `202 Accepted` and process writes in a queue to keep devices responsive. 

* `POST /ingest`
  Body: `{ machine_code, color, at? }`
  Writes synchronously with optional timestamp `at`. 
* `POST /ingest/now`
  Body: `{ machine_code, color }`
  Closes any open interval (if color differs/unknown) and opens new at **NOW**. Queued. 
* `POST /ingest/upsert`
  Body: `{ machine_code, color, ts? }`
  Same as above but accepts optional timestamp `ts`. Queued. 

**Example (cURL)**

```bash
curl -X POST http://<server>:3001/api/ingest/now \
  -H "Content-Type: application/json" \
  -d '{"machine_code":"CNC1","color":"green"}'
```

---

## Data model

Tables (simplified):

* **`machines`**: `{ id PK, CODE UNIQUE, NAME }`
* **`status_colors`**: `{ id PK, NAME UNIQUE, HEX }`
* **`machine_status`**: `{ id PK, machine_id FK, color_id FK, start_time, end_time NULL }`
  Open intervals have `end_time = NULL`; queries aggregate overlapped seconds per day/week. 

The dump (`mltm.sql`) also includes demo rows so the dashboard can render immediately. 

---

## Operational behavior

* **Unknown handling**: `unknown` closes the current open interval (configurable). 
* **Inactivity watchdog**: checks every ~15 s and auto-closes if no ingest for ~45 s (closed at last-seen). Also reconciles stale open rows on boot. 
* **Server timeouts**: request/header/keep-alive timeouts are deliberately conservative. 
* **Static assets**: served from `public/` at `/` and `/assets`. Place machine photos under `public/assets/machines/`. 
* **Dashboard time window**: timelines are rendered from **07:30 to next-day 07:30** with a visible midnight guide. 

---

## Configuration & environment

Create a `.env` or set environment variables for the server:

```bash
# MySQL
export MYSQL_HOST=127.0.0.1
export MYSQL_PORT=3306
export MYSQL_USER=root
export MYSQL_PASS=your_password

# Server
export PORT=3001
# Optional behavior toggles (see server.js/server_controller.js)
export UNKNOWN_STOPS_TIMER=true
```

Defaults fallback to the values in `db.js` if env vars are not provided (change them for your environment). 

**ESP32 firmware knobs** (edit in code):

* `WIFI_SSID`, `WIFI_PASS`, `SERVER_BASE`, `MACHINE_CODE`, heartbeat interval, debounce window, TCS gain/integration time, etc. 

---

## Troubleshooting

* **`BadRequestError: request aborted`** from Node: typically a client dropped connection mid-body. The server swallows this safely. Consider the device HTTP timeout (firmware uses ~15s) and server request timeouts.  
* **No data on dashboard**:

  * Check `API_BASE` in the dashboard matches your server origin. 
  * Confirm `GET /api/overview/today` returns machines and colors. 
* **Images not loading**:

  * Place files under `public/assets/machines/…` and access via `http://<server>:3001/assets/machines/<file>.jpg`. 
* **Intervals not closing**:

  * Ensure devices send `unknown` when light is undetectable, or rely on the inactivity watchdog thresholds. 

---

## Roadmap

* Auth/API key enforcement + rate limiting.
* Multi-tenant machine groups & roles.
* CSV export and per-shift analytics.
* OTA updates/config for ESP32 (thresholds & gains).

---

## License

Choose a license (e.g., MIT) and add `LICENSE` here.

---

### Appendix: Notes on color classification (ESP32)

* Ratios used: `gr = g/r`, `br = b/r`. Tight bands:

  * **GREEN**: `gr ≥ 0.875` and `br ≥ 0.890`
  * **YELLOW**: `gr ≤ 0.820` and `br ≤ 0.835`
  * **RED**: `0.830 ≤ gr ≤ 0.860` and `0.860 ≤ br ≤ 0.880`
* If between bands, **nearest centroid** in `(gr, br)` picks the label.
* Debounce (**~200 ms**) before committing; **heartbeat ~15 s** via `/ingest/upsert`.
  All implemented in the firmware sketch. 

---

> *Tip:* Keep secrets out of source control. Replace real Wi-Fi, DB, and API keys with environment variables or CI secrets.
