import { WebSocket } from "ws";
import {
  COMMAND_PATHS,
  type CommandResult,
  type RobotCommand,
  type RobotTelemetry,
  type SimulatorTelemetryMessage
} from "@robot/shared";

interface SimulatorLinkOptions {
  wsUrl: string;
  httpUrl: string;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  onTelemetry: (telemetry: RobotTelemetry) => void;
  onConnectionChange: (connected: boolean) => void;
}

// This is the gateway's long-lived integration with the simulator. The gateway
// opens the WebSocket handshake to the simulator's telemetry endpoint; after
// it opens, the simulator pushes telemetry frames through this full-duplex link.
// It reports updates through direct callbacks supplied by server.ts; it never
// owns or sends to browser sockets. Commands use HTTP below.
export class SimulatorLink {
  private upstreamSocket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  // `stopped` distinguishes intentional shutdown from a network loss; shutdown
  // must not schedule another reconnect after Fastify begins closing.
  private stopped = false;
  private reconnectAttempt = 0;
  private connected = false;
  private latest: RobotTelemetry | null = null;

  // This uses gateway time rather than the robot timestamp. It answers when we
  // actually last heard from the upstream link, which drives stale-data checks.
  private latestReceivedAt: number | null = null;

  constructor(private readonly options: SimulatorLinkOptions) {}

  get isConnected(): boolean {
    return this.connected;
  }

  get latestTelemetry(): RobotTelemetry | null {
    return this.latest;
  }

  get lastTelemetryReceivedAt(): number | null {
    return this.latestReceivedAt;
  }

  start(): void {
    this.stopped = false;

    // Connection setup is intentionally non-blocking. The API can start and
    // report an unhealthy simulator link while reconnecting in the background.
    this.connectTelemetrySocket();
  }

  stop(): void {
    this.stopped = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    // Termination triggers the normal `close` handler, but `stopped` prevents it
    // from treating planned shutdown as an outage that needs recovery.
    this.upstreamSocket?.terminate();
    this.upstreamSocket = null;
    this.connected = false;
  }

  async sendCommand(command: RobotCommand): Promise<CommandResult> {
    // Commands use request/response semantics: the caller needs an explicit
    // accepted/rejected result, while telemetry is a continuous stream.
    const response = await fetch(`${this.options.httpUrl}/commands/${COMMAND_PATHS[command]}`, {
      method: "POST"
    });

    const payload = (await response.json()) as CommandResult;

    if (!response.ok) {
      throw new Error(payload.reason ?? `Simulator rejected ${command}.`);
    }

    return payload;
  }

  async dropConnection(seconds: number): Promise<unknown> {
    return this.postJson("/faults/drop-connection", { seconds });
  }

  async triggerError(): Promise<unknown> {
    return this.postJson("/faults/error", {});
  }

  private connectTelemetrySocket(): void {
    if (this.stopped || this.upstreamSocket) {
      return;
    }

    // The gateway initiates this handshake to the simulator's /telemetry
    // endpoint. Once open, both services own one endpoint of the same link.
    const upstreamSocket = new WebSocket(this.options.wsUrl);
    this.upstreamSocket = upstreamSocket;

    upstreamSocket.on("open", () => {
      this.reconnectAttempt = 0;
      this.setConnected(true);
    });

    upstreamSocket.on("message", (data) => {
      // These frames come from the simulator because this is the gateway's
      // endpoint of the simulator link. Browser frames never enter this class.
      // A real robot integration should schema-validate parsed JSON here.
      const message = JSON.parse(data.toString()) as SimulatorTelemetryMessage;

      if (message.type === "telemetry") {
        this.latest = message.telemetry;
        this.latestReceivedAt = Date.now();
        // This is a direct in-process call to the API server's one telemetry
        // consumer. It is not a socket message or a general event bus.
        this.options.onTelemetry(message.telemetry);
      }
    });

    upstreamSocket.on("error", () => {
      upstreamSocket.terminate();
    });

    upstreamSocket.on("unexpected-response", (_request, response) => {
      // The simulator returns HTTP 503 during a simulated radio drop. Consume
      // that response before terminating so ws does not leave a socket hanging.
      response.resume();
      upstreamSocket.terminate();
    });

    upstreamSocket.on("close", () => {
      if (this.upstreamSocket === upstreamSocket) {
        this.upstreamSocket = null;
      }

      this.setConnected(false);
      this.scheduleReconnect();
    });
  }

  private setConnected(nextConnected: boolean): void {
    if (this.connected === nextConnected) {
      return;
    }

    // Notify the API server only when link health changes, not for every
    // low-level socket event.
    this.connected = nextConnected;
    this.options.onConnectionChange(nextConnected);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }

    const minDelay = this.options.reconnectMinMs ?? 250;
    const maxDelay = this.options.reconnectMaxMs ?? 2000;
    // Back off rather than hammering a robot or network that is already unhealthy.
    const delayMs = Math.min(maxDelay, minDelay * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectTelemetrySocket();
    }, delayMs);

    this.reconnectTimer.unref();
  }

  private async postJson(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${this.options.httpUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(`Simulator request failed: ${response.status}`);
    }

    return payload;
  }
}
