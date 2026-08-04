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

export function createSimulatorService(options: SimulatorServiceOptions = {}): SimulatorService {
  const app = Fastify({ logger: options.logger ?? true });
  const robot = options.robot ?? new RobotSimulator();
  const telemetryServer = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();
  let dropUntil = 0;
  const telemetryTimer = setInterval(() => {
    const telemetry = robot.tick();
    if (Date.now() >= dropUntil) {
      broadcast({ type: "telemetry", telemetry });
    }
  }, TELEMETRY_INTERVAL_MS);

  telemetryTimer.unref();

  telemetryServer.on("connection", (socket) => {
    clients.add(socket);
    send(socket, { type: "telemetry", telemetry: robot.getTelemetry() });

    socket.on("close", () => {
      clients.delete(socket);
    });
  });

  app.server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (url.pathname !== "/telemetry") {
      socket.destroy();
      return;
    }

    if (Date.now() < dropUntil) {
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

    const result = robot.applyCommand(command);
    return reply.status(result.accepted ? 202 : 409).send(result);
  });

  app.post<{ Body: DropConnectionBody }>("/faults/drop-connection", async (request) => {
    const seconds = normalizeDropSeconds(request.body?.seconds);
    dropUntil = Date.now() + seconds * 1000;

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

  return Math.max(1, Math.min(30, value));
}
