import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { WebSocket, WebSocketServer } from "ws";
import {
  commandFromPath,
  type BrowserSocketMessage,
  type GatewayStatus
} from "@robot/shared";
import { SimulatorLink } from "./simulatorLink.js";

interface ApiServiceOptions {
  logger?: boolean;
  simulatorHttpUrl: string;
  simulatorWsUrl: string;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
}

interface DropConnectionBody {
  seconds?: number;
}

export interface ApiService {
  app: FastifyInstance;
  simulatorLink: SimulatorLink;
}

// This factory is the gateway composition root. It keeps the upstream adapter,
// REST routes, and browser WebSocket fan-out in one testable service instance.
export function createApiService(options: ApiServiceOptions): ApiService {
  const app = Fastify({ logger: options.logger ?? true });
  const browserTelemetryServer = new WebSocketServer({ noServer: true });
  const browserSockets = new Set<WebSocket>();
  let simulatorLink: SimulatorLink;

  simulatorLink = new SimulatorLink({
    wsUrl: options.simulatorWsUrl,
    httpUrl: options.simulatorHttpUrl,
    reconnectMinMs: options.reconnectMinMs,
    reconnectMaxMs: options.reconnectMaxMs,
    // The link owns the simulator protocol; this server owns browser sockets.
    // Direct callbacks keep that single hand-off explicit without an event bus.
    onTelemetry: (telemetry) => {
      broadcastToBrowsers({
        type: "telemetry",
        telemetry,
        status: getGatewayStatus()
      });
    },
    onConnectionChange: () => {
      broadcastToBrowsers({
        type: "simulator_connection",
        status: getGatewayStatus()
      });
    }
  });

  // Broad CORS makes the local dashboard easy to run. Production should replace
  // `origin: true` with the known operator-dashboard origin(s).
  void app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "OPTIONS"]
  });

  app.server.on("upgrade", (request, socket, head) => {
    // Fastify owns the HTTP listener; ws only takes over connections intended
    // for the browser telemetry endpoint.
    const url = new URL(request.url ?? "/", "http://localhost");

    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }

    browserTelemetryServer.handleUpgrade(request, socket, head, (webSocket) => {
      registerBrowserSocket(webSocket);
    });
  });

  function registerBrowserSocket(browserSocket: WebSocket): void {
    browserSockets.add(browserSocket);

    // A snapshot avoids a blank dashboard while waiting for the next 5 Hz tick.
    sendBrowserMessage(browserSocket, {
      type: "snapshot",
      telemetry: simulatorLink.latestTelemetry,
      status: getGatewayStatus()
    });

    browserSocket.on("close", () => {
      browserSockets.delete(browserSocket);
    });
  }

  app.addHook("onReady", async () => {
    simulatorLink.start();
  });

  app.get("/health", async () => ({
    ok: true,
    service: "api",
    simulatorConnected: simulatorLink.isConnected,
    browserClients: browserSockets.size
  }));

  app.get("/telemetry/latest", async () => ({
    // A diagnostic/bootstrap REST view. The live dashboard normally uses /ws
    // because polling would be wasteful for a 5 Hz server-driven stream.
    telemetry: simulatorLink.latestTelemetry,
    status: getGatewayStatus()
  }));

  app.post<{ Params: { command: string } }>("/commands/:command", async (request, reply) => {
    const command = commandFromPath(request.params.command);

    if (!command) {
      return reply.status(404).send({ error: "Unknown command." });
    }

    if (!simulatorLink.isConnected) {
      // Refuse commands when the gateway cannot prove it has a live robot link.
      return reply.status(503).send({
        error: "Simulator connection is not live; command not sent."
      });
    }

    try {
      const result = await simulatorLink.sendCommand(command);
      return reply.status(result.accepted ? 202 : 409).send(result);
    } catch (error) {
      return reply.status(502).send({
        error: error instanceof Error ? error.message : "Simulator command failed."
      });
    }
  });

  app.post<{ Body: DropConnectionBody }>("/faults/drop-connection", async (request, reply) => {
    const seconds = request.body?.seconds ?? 5;

    try {
      return await simulatorLink.dropConnection(seconds);
    } catch (error) {
      return reply.status(502).send({
        error: error instanceof Error ? error.message : "Fault injection failed."
      });
    }
  });

  app.post("/faults/error", async (_request, reply) => {
    try {
      return await simulatorLink.triggerError();
    } catch (error) {
      return reply.status(502).send({
        error: error instanceof Error ? error.message : "Fault injection failed."
      });
    }
  });

  app.addHook("preClose", async () => {
    simulatorLink.stop();

    for (const browserSocket of browserSockets) {
      browserSocket.terminate();
    }
  });

  app.addHook("onClose", async () => {
    browserTelemetryServer.close();
  });

  function getGatewayStatus(): GatewayStatus {
    const telemetry = simulatorLink.latestTelemetry;

    // Keep robot time and gateway receive time separate. Clock domains differ,
    // and the UI needs the latter to estimate how old the stream really is.
    return {
      simulatorConnected: simulatorLink.isConnected,
      lastTelemetryAt: telemetry?.timestamp ?? null,
      lastTelemetryReceivedAt: simulatorLink.lastTelemetryReceivedAt,
      serverTime: Date.now()
    };
  }

  function broadcastToBrowsers(message: BrowserSocketMessage): void {
    for (const browserSocket of browserSockets) {
      sendBrowserMessage(browserSocket, message);
    }
  }

  return { app, simulatorLink };
}

function sendBrowserMessage(socket: WebSocket, message: BrowserSocketMessage): void {
  // Browser tabs can close at any moment; never throw while broadcasting to a
  // stale entry that has not yet emitted its close event.
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}
