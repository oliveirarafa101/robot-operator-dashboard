import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { BrowserSocketMessage } from "@robot/shared";
import { createSimulatorService } from "../../simulator/src/server.js";
import { createApiService } from "../src/server.js";

const openSockets: WebSocket[] = [];

describe("API simulator reconnect flow", () => {
  afterEach(() => {
    for (const socket of openSockets.splice(0)) {
      socket.terminate();
    }
  });

  it("marks simulator data stale during a drop and resumes telemetry after reconnect", async () => {
    const simulatorService = createSimulatorService({ logger: false });
    await simulatorService.app.listen({ port: 0, host: "127.0.0.1" });
    const simulatorPort = getPort(simulatorService.app);

    const apiService = createApiService({
      logger: false,
      simulatorHttpUrl: `http://127.0.0.1:${simulatorPort}`,
      simulatorWsUrl: `ws://127.0.0.1:${simulatorPort}/telemetry`,
      reconnectMinMs: 50,
      reconnectMaxMs: 100
    });
    await apiService.app.listen({ port: 0, host: "127.0.0.1" });
    const apiPort = getPort(apiService.app);

    try {
      const browserSocket = await connectBrowser(`ws://127.0.0.1:${apiPort}/ws`);
      const firstTelemetry = await waitForMessage(
        browserSocket,
        (message) => message.type === "telemetry"
      );

      expect(firstTelemetry.type).toBe("telemetry");
      const firstSequence =
        firstTelemetry.type === "telemetry" ? firstTelemetry.telemetry.sequence : 0;

      const dropResponse = await fetch(`http://127.0.0.1:${apiPort}/faults/drop-connection`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ seconds: 1 })
      });

      expect(dropResponse.ok).toBe(true);

      const staleMessage = await waitForMessage(
        browserSocket,
        (message) =>
          message.type === "simulator_connection" && !message.status.simulatorConnected
      );
      expect(staleMessage.status.simulatorConnected).toBe(false);

      const resumedTelemetry = await waitForMessage(
        browserSocket,
        (message) =>
          message.type === "telemetry" &&
          message.status.simulatorConnected &&
          message.telemetry.sequence > firstSequence
      );

      expect(resumedTelemetry.type).toBe("telemetry");
      expect(resumedTelemetry.status.simulatorConnected).toBe(true);
    } finally {
      await apiService.app.close();
      await simulatorService.app.close();
    }
  });
});

function getPort(app: { server: { address(): string | { port: number } | null } }): number {
  const address = app.server.address();

  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port.");
  }

  return address.port;
}

async function connectBrowser(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  openSockets.push(socket);

  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  return socket;
}

async function waitForMessage(
  socket: WebSocket,
  predicate: (message: BrowserSocketMessage) => boolean,
  timeoutMs = 5000
): Promise<BrowserSocketMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket message."));
    }, timeoutMs);

    const onMessage = (data: Buffer) => {
      const message = JSON.parse(data.toString()) as BrowserSocketMessage;

      if (predicate(message)) {
        cleanup();
        resolve(message);
      }
    };

    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed while waiting for message."));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };

    socket.on("message", onMessage);
    socket.on("close", onClose);
  });
}
