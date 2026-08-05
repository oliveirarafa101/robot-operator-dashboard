# Interview Code Walkthrough

Use this as a presentation order. It follows the data path instead of jumping between
files or starting with React components.

## One-Minute Overview

> The simulator owns the robot state machine. The API gateway maintains one resilient
> upstream simulator connection, exposes commands as REST, and fans telemetry out over
> WebSockets. The React dashboard renders only confirmed telemetry and locks controls
> whenever the end-to-end link is unsafe.

```text
RobotSimulator -> simulator WebSocket -> API gateway -> browser WebSocket -> React UI
                                                    ^
Browser REST command -> API REST route -> simulator REST command
```

## 1. Start With the Shared Contract

Open `packages/shared/src/index.ts` first.

- `RobotTelemetry` is the stable public representation of a robot. It deliberately
  contains operational data, not simulator implementation details such as heading.
- `RobotCommand` and `COMMAND_PATHS` keep UI, API, and simulator command names aligned.
- `BrowserSocketMessage` differs from `SimulatorTelemetryMessage`: the gateway adds
  status so the UI can judge whether telemetry is trustworthy.

Useful line to explain:

```ts
export type RobotState = (typeof ROBOT_STATES)[number];
```

This creates a TypeScript union from the same list used for runtime validation, avoiding
two independently maintained lists of valid states.

## 2. Explain Robot Authority

Move to `apps/simulator/src/robot.ts`.

- `snapshot` is the only mutable robot state.
- `applyCommand()` delegates to `transition()`, which owns command legality.
- `tick()` changes position and resources only while the state is `running`.
- Sequence and timestamp advance in every state so an idle robot is distinguishable
  from a broken data stream.

Useful line to explain:

```ts
if (this.snapshot.state === "running") {
  this.advanceMotion();
  this.drainConsumables();
}
```

The UI may disable an invalid button, but the simulator makes the final decision. Any
client that calls the API directly receives the same state-machine protection.

## 3. Add the Simulator Transport

Then open `apps/simulator/src/server.ts`.

- Fastify exposes HTTP health, command, and fault routes.
- `WebSocketServer({ noServer: true })` shares Fastify's port; it accepts only the
  `/telemetry` HTTP Upgrade path.
- The 200 ms timer calls `robot.tick()` even if nobody is connected.
- A new telemetry client gets a snapshot immediately, then periodic updates.
- The simulated radio drop closes existing clients and rejects new upgrades for the
  whole fault window.

Tip: Say “the simulator service is a transport adapter around the pure robot model,”
not “the robot is a WebSocket server.”

## 4. Explain the Gateway in Two Directions

Open `apps/api/src/simulatorClient.ts`, then `apps/api/src/server.ts`.

### Upstream: gateway to simulator

`SimulatorClient` creates one outbound WebSocket to the configured
`SIMULATOR_WS_URL`. Its `message` handler can receive only simulator frames because that
specific socket was opened to the simulator endpoint. It saves the latest telemetry,
records gateway receive time, emits an internal `telemetry` event, and reconnects with
backoff after a close.

### Downstream: gateway to browsers

The API accepts inbound browser WebSocket upgrades only at `/ws`. Each browser socket is
stored in `browsers`, receives an immediate snapshot, and receives the gateway's fan-out
of future telemetry. The gateway never creates a browser connection; each tab creates
one when the dashboard mounts.

Useful line to explain:

```ts
if (!simulator.isConnected) {
  return reply.status(503).send({
    error: "Simulator connection is not live; command not sent."
  });
}
```

Commands are not queued during an outage. A delayed mission command could be unsafe once
connectivity returns.

## 5. Explain REST Versus WebSocket

Use this short explanation:

> WebSocket is used for telemetry because the server produces a frequent stream that
> multiple dashboards need without polling. REST is used for commands because an operator
> needs one explicit accepted, rejected, or unavailable result. The subsequent telemetry
> event, not the REST response alone, is the authoritative confirmation of robot state.

## 6. Finish With the Browser Safety Model

Open `apps/web/src/useTelemetrySocket.ts`, then `apps/web/src/App.tsx`.

- The hook starts a browser-to-gateway WebSocket after React mounts.
- It tracks browser-to-gateway and gateway-to-simulator connectivity independently.
- A 250 ms local timer keeps `Last data` increasing even when messages stop.
- `LIVE` requires a connected browser socket, a connected simulator link, and fresh data.
- The hook retries after a browser socket closes; the gateway independently retries the
  simulator link.
- `App` uses REST to send a command, but deliberately waits for WebSocket telemetry to
  update visible robot state.

Useful line to explain:

```ts
const controlsLocked = !isSafeForCommands || pendingAction !== null;
```

This locks controls on stale/disconnected data and prevents duplicate clicks while a
command request is in flight.

## Demo Script

1. Open `http://localhost:4030`; call out `LIVE`, `Last data`, and `Sequence`.
2. Start the mission; show position movement and slowly changing resources.
3. Pause and show that position stops but sequence continues as a heartbeat.
4. Click `Drop 5s`; show `STALE`, the frozen last-known state, rising data age, and locked controls.
5. Wait for automatic reconnect; show a new snapshot/telemetry makes the UI `LIVE` again.
6. Trigger Error; show robot state, mission stop reason, and dismissible alert.

## Honest Production Follow-Ups

- Validate all WebSocket JSON at runtime; TypeScript type assertions do not validate data.
- Authenticate browsers and use mutual TLS or another strong identity mechanism for robots.
- Add an operator-control lease, idempotency keys, and an audit trail for concurrent users.
- Persist missions and telemetry as required by the product, instead of relying on process memory.
- Serve the built UI through a production static server/CDN and supply its public API URL at build or runtime.
