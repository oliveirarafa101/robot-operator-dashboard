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
  // Keep browser-to-gateway health separate from gateway-to-simulator health.
  // A live WebSocket alone is not enough evidence that robot data is fresh.
  const [state, setState] = useState<TelemetrySocketState>({
    socketConnected: false,
    simulatorConnected: false,
    telemetry: null,
    lastTelemetryReceivedAt: null
  });
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    // Telemetry age must keep advancing when messages stop; it cannot be based
    // only on the timestamp captured by the last WebSocket event.
    const interval = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;

    // React cleanup sets this before closing the socket, so `onclose` knows not
    // to revive a connection for a component that no longer exists.
    let disposed = false;

    const connect = () => {
      // This runs in the operator's browser, not the web container. It creates
      // one browser-tab-to-gateway session at the supplied public API URL.
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
          // This reconnects the browser to the gateway. The gateway separately
          // owns reconnecting to the simulator, keeping those failures distinct.
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
      // A connected browser socket only proves the dashboard can reach the API;
      // it does not prove that telemetry is still arriving from the robot.
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
    // Link events deliberately retain the last robot position. The UI needs to
    // show what was last known while clearly marking it stale.
    return {
      ...current,
      simulatorConnected: message.status.simulatorConnected
    };
  }

  // `snapshot` and `telemetry` both carry a complete state, so they share the
  // same update path. Snapshot is simply the first state after connecting.
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

  // The browser and server do not share a clock. Preserve the age already
  // observed at the gateway instead of treating every forwarded message as new.
  const ageAtServer = Math.max(0, status.serverTime - status.lastTelemetryReceivedAt);
  return Date.now() - ageAtServer;
}
