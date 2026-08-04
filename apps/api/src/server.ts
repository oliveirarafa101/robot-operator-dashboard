import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { WebSocket, WebSocketServer } from "ws";
import {
  commandFromPath,
  type BrowserSocketMessage,
  type GatewayStatus
} from "@robot/shared";
import { SimulatorClient } from "./simulatorClient.js";

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
  simulator: SimulatorClient;
}

export function createApiService(options: ApiServiceOptions): ApiService {
  const app = Fastify({ logger: options.logger ?? true });
  const simulator = new SimulatorClient({
    wsUrl: options.simulatorWsUrl,
    httpUrl: options.simulatorHttpUrl,
    reconnectMinMs: options.reconnectMinMs,
    reconnectMaxMs: options.reconnectMaxMs
  });
  const browserServer = new WebSocketServer({ noServer: true });
  const browsers = new Set<WebSocket>();

  void app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "OPTIONS"]
  });

  app.server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }

    browserServer.handleUpgrade(request, socket, head, (webSocket) => {
      browserServer.emit("connection", webSocket, request);
    });
  });

  browserServer.on("connection", (socket) => {
    browsers.add(socket);
    send(socket, {
      type: "snapshot",
      telemetry: simulator.latestTelemetry,
      status: getGatewayStatus()
    });

    socket.on("close", () => {
      browsers.delete(socket);
    });
  });

  simulator.on("telemetry", (telemetry) => {
    broadcast({
      type: "telemetry",
      telemetry,
      status: getGatewayStatus()
    });
  });

  simulator.on("connection", () => {
    broadcast({
      type: "simulator_connection",
      status: getGatewayStatus()
    });
  });

  app.addHook("onReady", async () => {
    simulator.start();
  });

  app.get("/health", async () => ({
    ok: true,
    service: "api",
    simulatorConnected: simulator.isConnected,
    browserClients: browsers.size
  }));

  app.get("/telemetry/latest", async () => ({
    telemetry: simulator.latestTelemetry,
    status: getGatewayStatus()
  }));

  app.post<{ Params: { command: string } }>("/commands/:command", async (request, reply) => {
    const command = commandFromPath(request.params.command);

    if (!command) {
      return reply.status(404).send({ error: "Unknown command." });
    }

    if (!simulator.isConnected) {
      return reply.status(503).send({
        error: "Simulator connection is not live; command not sent."
      });
    }

    try {
      const result = await simulator.sendCommand(command);
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
      return await simulator.dropConnection(seconds);
    } catch (error) {
      return reply.status(502).send({
        error: error instanceof Error ? error.message : "Fault injection failed."
      });
    }
  });

  app.post("/faults/error", async (_request, reply) => {
    try {
      return await simulator.triggerError();
    } catch (error) {
      return reply.status(502).send({
        error: error instanceof Error ? error.message : "Fault injection failed."
      });
    }
  });

  app.addHook("preClose", async () => {
    simulator.stop();

    for (const browser of browsers) {
      browser.terminate();
    }
  });

  app.addHook("onClose", async () => {
    browserServer.close();
  });

  function getGatewayStatus(): GatewayStatus {
    const telemetry = simulator.latestTelemetry;

    return {
      simulatorConnected: simulator.isConnected,
      lastTelemetryAt: telemetry?.timestamp ?? null,
      lastTelemetryReceivedAt: simulator.lastTelemetryReceivedAt,
      serverTime: Date.now()
    };
  }

  function broadcast(message: BrowserSocketMessage): void {
    for (const browser of browsers) {
      send(browser, message);
    }
  }

  return { app, simulator };
}

function send(socket: WebSocket, message: BrowserSocketMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}
