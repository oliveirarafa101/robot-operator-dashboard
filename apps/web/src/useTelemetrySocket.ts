import { useEffect, useMemo, useState } from "react";
import type {
  BrowserSocketMessage,
  GatewayStatus,
  RobotTelemetry
} from "@robot/shared";

export type LinkStatus = "connecting" | "live" | "stale" | "disconnected";

const STALE_AFTER_MS = 2000;
const RECONNECT_AFTER_MS = 1000;

interface TelemetrySocketState {
  socketConnected: boolean;
  simulatorConnected: boolean;
  telemetry: RobotTelemetry | null;
  lastTelemetryReceivedAt: number | null;
}

export function useTelemetrySocket(wsUrl: string) {
  const [state, setState] = useState<TelemetrySocketState>({
    socketConnected: false,
    simulatorConnected: false,
    telemetry: null,
    lastTelemetryReceivedAt: null
  });
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let disposed = false;

    const connect = () => {
      socket = new WebSocket(wsUrl);

      socket.onopen = () => {
        setState((current) => ({
          ...current,
          socketConnected: true
        }));
      };

      socket.onmessage = (event) => {
        const message = JSON.parse(event.data as string) as BrowserSocketMessage;
        setState((current) => applySocketMessage(current, message));
      };

      socket.onclose = () => {
        setState((current) => ({
          ...current,
          socketConnected: false,
          simulatorConnected: false
        }));

        if (!disposed) {
          reconnectTimer = window.setTimeout(connect, RECONNECT_AFTER_MS);
        }
      };

      socket.onerror = () => {
        socket?.close();
      };
    };

    connect();

    return () => {
      disposed = true;

      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }

      socket?.close();
    };
  }, [wsUrl]);

  const ageMs =
    state.telemetry && state.lastTelemetryReceivedAt
      ? Math.max(0, now - state.lastTelemetryReceivedAt)
      : null;

  const linkStatus = useMemo<LinkStatus>(() => {
    if (!state.socketConnected) {
      return "disconnected";
    }

    if (!state.telemetry) {
      return "connecting";
    }

    if (!state.simulatorConnected || (ageMs !== null && ageMs > STALE_AFTER_MS)) {
      return "stale";
    }

    return "live";
  }, [ageMs, state.simulatorConnected, state.socketConnected, state.telemetry]);

  return {
    ...state,
    ageMs,
    linkStatus,
    isSafeForCommands: linkStatus === "live"
  };
}

function applySocketMessage(
  current: TelemetrySocketState,
  message: BrowserSocketMessage
): TelemetrySocketState {
  if (message.type === "simulator_connection") {
    return {
      ...current,
      simulatorConnected: message.status.simulatorConnected
    };
  }

  return {
    socketConnected: true,
    simulatorConnected: message.status.simulatorConnected,
    telemetry: message.telemetry,
    lastTelemetryReceivedAt: deriveBrowserReceivedAt(message.status)
  };
}

function deriveBrowserReceivedAt(status: GatewayStatus): number | null {
  if (!status.lastTelemetryReceivedAt) {
    return null;
  }

  const ageAtServer = Math.max(0, status.serverTime - status.lastTelemetryReceivedAt);
  return Date.now() - ageAtServer;
}
