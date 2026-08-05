import Fastify, { type FastifyInstance } from "fastify";
import { WebSocket, WebSocketServer } from "ws";
import {
  commandFromPath,
  type SimulatorTelemetryMessage
} from "@robot/shared";
import { RobotSimulator } from "./robot.js";

interface DropConnectionBody {
  seconds?: number;
}

export interface SimulatorServiceOptions {
  logger?: boolean;
  robot?: RobotSimulator;
}

export interface SimulatorService {
  app: FastifyInstance;
  robot: RobotSimulator;
}

const TELEMETRY_INTERVAL_MS = 200;

// This factory wires the transport around a robot model but does not bind a
// port itself. Keeping `listen` in main.ts makes the service easy to exercise
// in tests with a custom RobotSimulator instance.
export function createSimulatorService(options: SimulatorServiceOptions = {}): SimulatorService {
  const app = Fastify({ logger: options.logger ?? true });
  const robot = options.robot ?? new RobotSimulator();

  // `noServer` means this WebSocket handler shares Fastify's HTTP port. It only
  // receives connections after we explicitly accept an Upgrade for /telemetry.
  const telemetryServer = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();

  // The fault models a radio outage, so robot state continues to progress while
  // telemetry is intentionally withheld from connected observers.
  let dropUntil = 0;

  // The robot keeps ticking even with no subscribers. A browser reconnecting
  // later gets the robot's current state, not a simulation paused by networking.
  const telemetryTimer = setInterval(() => {
    const telemetry = robot.tick();
    if (Date.now() >= dropUntil) {
      broadcast({ type: "telemetry", telemetry });
    }
  }, TELEMETRY_INTERVAL_MS);

  // Do not let this background heartbeat keep a completed test process alive.
  telemetryTimer.unref();

  telemetryServer.on("connection", (socket) => {
    clients.add(socket);

    // New clients start with the current state rather than waiting as long as
    // one interval for the following periodic broadcast.
    send(socket, { type: "telemetry", telemetry: robot.getTelemetry() });

    socket.on("close", () => {
      clients.delete(socket);
    });
  });

  app.server.on("upgrade", (request, socket, head) => {
    // WebSocket starts as an HTTP request. Only the telemetry route is allowed
    // to upgrade on this service; every other path is a normal HTTP route.
    const url = new URL(request.url ?? "/", "http://localhost");

    if (url.pathname !== "/telemetry") {
      socket.destroy();
      return;
    }

    if (Date.now() < dropUntil) {
      // Reject new upgrades too; otherwise the fault would only affect clients
      // that happened to be connected when the drop was triggered.
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    telemetryServer.handleUpgrade(request, socket, head, (webSocket) => {
      telemetryServer.emit("connection", webSocket, request);
    });
  });

  app.get("/health", async () => ({
    ok: true,
    service: "simulator",
    clients: clients.size,
    droppingConnections: Date.now() < dropUntil
  }));

  app.get("/status", async () => robot.getTelemetry());

  app.post<{ Params: { command: string } }>("/commands/:command", async (request, reply) => {
    const command = commandFromPath(request.params.command);

    if (!command) {
      return reply.status(404).send({ error: "Unknown command." });
    }

    // Fastify is only the transport adapter here. The RobotSimulator enforces
    // legal state transitions so direct callers cannot bypass safety rules.
    const result = robot.applyCommand(command);
    return reply.status(result.accepted ? 202 : 409).send(result);
  });

  app.post<{ Body: DropConnectionBody }>("/faults/drop-connection", async (request) => {
    const seconds = normalizeDropSeconds(request.body?.seconds);
    dropUntil = Date.now() + seconds * 1000;

    // Close current clients now and reject new upgrades until the window ends.
    // Doing only one of these would make the simulated outage incomplete.
    for (const client of clients) {
      client.close(1011, "Simulated greenhouse Wi-Fi drop");
    }

    return {
      accepted: true,
      seconds,
      dropUntil
    };
  });

  app.post("/faults/error", async () => {
    const telemetry = robot.injectError();
    broadcast({ type: "telemetry", telemetry });
    return {
      accepted: true,
      telemetry
    };
  });

  app.addHook("preClose", async () => {
    for (const client of clients) {
      client.terminate();
    }
  });

  app.addHook("onClose", async () => {
    clearInterval(telemetryTimer);
    telemetryServer.close();
  });

  function broadcast(message: SimulatorTelemetryMessage): void {
    // Fan-out is intentionally best effort. `send` checks socket state because
    // a client can close between this loop beginning and its turn to receive.
    for (const client of clients) {
      send(client, message);
    }
  }

  return { app, robot };
}


function send(socket: WebSocket, message: SimulatorTelemetryMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function normalizeDropSeconds(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 5;
  }

  // Keep the demo controllable and avoid accidental permanent disconnects.
  return Math.max(1, Math.min(30, value));
}
