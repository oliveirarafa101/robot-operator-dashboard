import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import {
  COMMAND_PATHS,
  type CommandResult,
  type RobotCommand,
  type RobotTelemetry,
  type SimulatorTelemetryMessage
} from "@robot/shared";

interface SimulatorClientOptions {
  wsUrl: string;
  httpUrl: string;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
}

export class SimulatorClient extends EventEmitter {
  private socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private reconnectAttempt = 0;
  private connected = false;
  private latest: RobotTelemetry | null = null;
  private latestReceivedAt: number | null = null;

  constructor(private readonly options: SimulatorClientOptions) {
    super();
  }

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
    this.connect();
  }

  stop(): void {
    this.stopped = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.socket?.terminate();
    this.socket = null;
    this.connected = false;
  }

  async sendCommand(command: RobotCommand): Promise<CommandResult> {
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

  private connect(): void {
    if (this.stopped || this.socket) {
      return;
    }

    const socket = new WebSocket(this.options.wsUrl);
    this.socket = socket;

    socket.on("open", () => {
      this.reconnectAttempt = 0;
      this.setConnected(true);
    });

    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as SimulatorTelemetryMessage;

      if (message.type === "telemetry") {
        this.latest = message.telemetry;
        this.latestReceivedAt = Date.now();
        this.emit("telemetry", message.telemetry);
      }
    });

    socket.on("error", () => {
      socket.terminate();
    });

    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      socket.terminate();
    });

    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = null;
      }

      this.setConnected(false);
      this.scheduleReconnect();
    });
  }

  private setConnected(nextConnected: boolean): void {
    if (this.connected === nextConnected) {
      return;
    }

    this.connected = nextConnected;
    this.emit("connection", nextConnected);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }

    const minDelay = this.options.reconnectMinMs ?? 250;
    const maxDelay = this.options.reconnectMaxMs ?? 2000;
    const delayMs = Math.min(maxDelay, minDelay * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
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
