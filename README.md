# Greenhouse Robot Operator Dashboard

Full-stack take-home assessment for a simulated greenhouse robot. The main design goal is operator safety: live telemetry must be visually different from stale or disconnected data, and mission controls must lock when the link is unsafe.

## Run

```bash
docker compose up --build
```

Open the dashboard at `http://localhost:4030`.

Services:

- Simulator: `http://localhost:4010`
- API gateway: `http://localhost:4020`
- Dashboard: `http://localhost:4030`

## Local Development

```bash
corepack enable
pnpm install
pnpm dev
```

Useful commands:

```bash
pnpm test
pnpm build
pnpm typecheck
```

## Demo Faults

Trigger a five-second simulator connection drop:

```bash
curl -X POST http://localhost:4020/faults/drop-connection \
  -H 'content-type: application/json' \
  -d '{"seconds":5}'
```

Put the robot into error state:

```bash
curl -X POST http://localhost:4020/faults/error
```

## Architecture

The project is intentionally split into three apps and one shared protocol package:

- `apps/simulator`: owns robot state, command transitions, telemetry generation, and simulator fault injection.
- `apps/api`: connects to the simulator, reconnects automatically, exposes REST mission commands, and pushes browser WebSocket updates.
- `apps/web`: React operator dashboard with live/stale/disconnected states, telemetry map, controls, and dismissible alerts.
- `packages/shared`: command names, telemetry shapes, gateway messages, and URL path mappings.

This split keeps the simulator replaceable. For a real ROS2 robot, the API gateway is the adapter boundary: the simulator WebSocket client would be replaced by a `rosbridge_server` client while the browser contract stays stable.

## Connection Model

Telemetry is emitted by the simulator at roughly 5 Hz. The API records the latest telemetry snapshot and sends a snapshot immediately when a browser connects. The dashboard derives:

- `LIVE`: browser socket is connected, API is connected to the simulator, and telemetry is fresh.
- `STALE`: the API is reachable, but simulator telemetry stopped or the latest data is older than the freshness threshold.
- `DISCONNECTED`: the browser cannot reach the API WebSocket.

Mission controls are disabled outside `LIVE`. This is the most important product behavior in the assessment because silent stale data would be unsafe for an operator.

## Mission Commands

REST endpoints are exposed by the API:

- `POST /commands/start-mission`
- `POST /commands/pause`
- `POST /commands/resume`
- `POST /commands/stop`
- `POST /commands/emergency-stop`

The simulator accepts normal mission transitions and rejects unsafe transitions, for example pausing while idle.

## Tests

Backend tests cover:

- Simulator command state transitions.
- Unsafe command rejection.
- Emergency stop behavior.
- API disconnect/reconnect flow, including stale connection notification and resumed telemetry.
