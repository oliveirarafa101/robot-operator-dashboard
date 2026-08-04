import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Battery,
  Bug,
  Droplets,
  Pause,
  Play,
  RotateCcw,
  Siren,
  Square,
  Wifi,
  WifiOff,
  Zap
} from "lucide-react";
import { COMMAND_PATHS, type RobotCommand, type RobotTelemetry } from "@robot/shared";
import { useTelemetrySocket, type LinkStatus } from "./useTelemetrySocket";

const API_HTTP_URL = import.meta.env.VITE_API_HTTP_URL ?? "http://localhost:4020";
const API_WS_URL =
  import.meta.env.VITE_API_WS_URL ?? API_HTTP_URL.replace(/^http/, "ws").concat("/ws");

interface AlertItem {
  key: string;
  title: string;
  detail: string;
  severity: "warning" | "danger";
}

export function App() {
  const {
    telemetry,
    ageMs,
    linkStatus,
    socketConnected,
    simulatorConnected,
    isSafeForCommands
  } = useTelemetrySocket(API_WS_URL);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(() => new Set());

  const alerts = useMemo(() => buildAlerts(telemetry), [telemetry]);
  const activeAlertKeys = useMemo(() => new Set(alerts.map((alert) => alert.key)), [alerts]);

  useEffect(() => {
    setDismissedAlerts((current) => {
      const next = new Set<string>();

      for (const key of current) {
        if (activeAlertKeys.has(key)) {
          next.add(key);
        }
      }

      return next;
    });
  }, [activeAlertKeys]);

  const visibleAlerts = alerts.filter((alert) => !dismissedAlerts.has(alert.key));
  const controlsLocked = !isSafeForCommands || pendingAction !== null;

  async function sendCommand(command: RobotCommand) {
    setPendingAction(command);
    setActionError(null);

    try {
      const response = await fetch(`${API_HTTP_URL}/commands/${COMMAND_PATHS[command]}`, {
        method: "POST"
      });
      const payload = (await response.json()) as { reason?: string; error?: string };

      if (!response.ok) {
        throw new Error(payload.reason ?? payload.error ?? "Command failed.");
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Command failed.");
    } finally {
      setPendingAction(null);
    }
  }

  async function injectFault(path: "drop-connection" | "error") {
    setPendingAction(path);
    setActionError(null);

    try {
      const response = await fetch(`${API_HTTP_URL}/faults/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: path === "drop-connection" ? JSON.stringify({ seconds: 5 }) : "{}"
      });

      if (!response.ok) {
        throw new Error("Fault injection failed.");
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Fault injection failed.");
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <main className="app-shell">
      <section className="top-bar">
        <div>
          <p className="eyebrow">Greenhouse Robot</p>
          <h1>Operator Dashboard</h1>
        </div>
        <StatusBadge status={linkStatus} ageMs={ageMs} />
      </section>

      <section className="status-strip" aria-live="polite">
        <div>
          <span>API</span>
          <strong>{socketConnected ? "connected" : "offline"}</strong>
        </div>
        <div>
          <span>Simulator</span>
          <strong>{simulatorConnected ? "connected" : "reconnecting"}</strong>
        </div>
        <div>
          <span>Last data</span>
          <strong>{formatAge(ageMs)}</strong>
        </div>
        <div>
          <span>Sequence</span>
          <strong>{telemetry?.sequence ?? "--"}</strong>
        </div>
      </section>

      <div className="dashboard-grid">
        <RobotMap telemetry={telemetry} status={linkStatus} />

        <section className="side-panel">
          <MetricPanel telemetry={telemetry} />
          <MissionControls
            telemetry={telemetry}
            controlsLocked={controlsLocked}
            pendingAction={pendingAction}
            onCommand={sendCommand}
          />
          <FaultPanel
            disabled={!socketConnected || pendingAction !== null}
            pendingAction={pendingAction}
            onInject={injectFault}
          />
        </section>
      </div>

      <section className="alerts-panel">
        <div className="panel-heading">
          <h2>Alerts</h2>
          <span>{visibleAlerts.length} active</span>
        </div>

        {visibleAlerts.length === 0 ? (
          <p className="empty-alerts">No active robot alerts.</p>
        ) : (
          <div className="alert-list">
            {visibleAlerts.map((alert) => (
              <article className={`alert-card ${alert.severity}`} key={alert.key}>
                <AlertTriangle size={20} aria-hidden="true" />
                <div>
                  <strong>{alert.title}</strong>
                  <p>{alert.detail}</p>
                </div>
                <button
                  className="icon-button"
                  type="button"
                  aria-label={`Dismiss ${alert.title}`}
                  onClick={() =>
                    setDismissedAlerts((current) => new Set(current).add(alert.key))
                  }
                >
                  x
                </button>
              </article>
            ))}
          </div>
        )}

        {actionError ? <p className="action-error">{actionError}</p> : null}
      </section>
    </main>
  );
}

function StatusBadge({ status, ageMs }: { status: LinkStatus; ageMs: number | null }) {
  const isLive = status === "live";
  const Icon = isLive ? Wifi : WifiOff;

  return (
    <div className={`status-badge ${status}`}>
      <Icon size={20} aria-hidden="true" />
      <div>
        <strong>{status.toUpperCase()}</strong>
        <span>{formatAge(ageMs)}</span>
      </div>
    </div>
  );
}

function RobotMap({
  telemetry,
  status
}: {
  telemetry: RobotTelemetry | null;
  status: LinkStatus;
}) {
  const x = telemetry?.position.x ?? 50;
  const y = telemetry?.position.y ?? 50;

  return (
    <section className="map-panel">
      <div className="panel-heading">
        <h2>Field Map</h2>
        <span>{telemetry?.missionId ?? "no mission"}</span>
      </div>
      <svg className="field-map" viewBox="0 0 100 100" role="img" aria-label="Robot field map">
        <defs>
          <pattern id="field-grid" width="10" height="10" patternUnits="userSpaceOnUse">
            <path d="M 10 0 L 0 0 0 10" fill="none" stroke="rgba(44, 62, 80, 0.16)" />
          </pattern>
        </defs>
        <rect x="0" y="0" width="100" height="100" rx="1" fill="#eef7ef" />
        <rect x="0" y="0" width="100" height="100" fill="url(#field-grid)" />
        <path
          d="M10 76 C26 58 35 70 48 49 C61 28 77 38 90 18"
          fill="none"
          stroke="#8a9a5b"
          strokeWidth="1.4"
          strokeDasharray="3 3"
        />
        <circle className={`robot-dot ${status}`} cx={x} cy={y} r="4.2" />
        <circle cx={x} cy={y} r="8.5" fill="none" stroke="rgba(17, 112, 84, 0.2)" />
      </svg>
    </section>
  );
}

function MetricPanel({ telemetry }: { telemetry: RobotTelemetry | null }) {
  return (
    <section className="metric-panel">
      <div className="panel-heading">
        <h2>Telemetry</h2>
        <StatePill state={telemetry?.state ?? "idle"} />
      </div>
      <Metric
        icon={<Battery size={20} aria-hidden="true" />}
        label="Battery"
        value={telemetry?.batteryPercent}
        suffix="%"
      />
      <Metric
        icon={<Droplets size={20} aria-hidden="true" />}
        label="Spray tank"
        value={telemetry?.tankPercent}
        suffix="%"
      />
      <div className="coordinate-row">
        <span>X {formatNumber(telemetry?.position.x)}</span>
        <span>Y {formatNumber(telemetry?.position.y)}</span>
      </div>
    </section>
  );
}

function Metric({
  icon,
  label,
  value,
  suffix
}: {
  icon: ReactNode;
  label: string;
  value: number | undefined;
  suffix: string;
}) {
  const percent = value ?? 0;

  return (
    <div className="metric-row">
      <div className="metric-label">
        {icon}
        <span>{label}</span>
      </div>
      <strong>
        {value === undefined ? "--" : Math.round(value)}
        {value === undefined ? "" : suffix}
      </strong>
      <div className="meter" aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function MissionControls({
  telemetry,
  controlsLocked,
  pendingAction,
  onCommand
}: {
  telemetry: RobotTelemetry | null;
  controlsLocked: boolean;
  pendingAction: string | null;
  onCommand: (command: RobotCommand) => void;
}) {
  const state = telemetry?.state ?? "idle";

  return (
    <section className="controls-panel">
      <div className="panel-heading">
        <h2>Mission Controls</h2>
        <span>{controlsLocked ? "locked" : "ready"}</span>
      </div>
      <div className="control-grid">
        <ControlButton
          command="start_mission"
          icon={<Play size={18} />}
          label="Start"
          disabled={controlsLocked || state !== "idle"}
          pending={pendingAction === "start_mission"}
          onCommand={onCommand}
        />
        <ControlButton
          command="pause"
          icon={<Pause size={18} />}
          label="Pause"
          disabled={controlsLocked || state !== "running"}
          pending={pendingAction === "pause"}
          onCommand={onCommand}
        />
        <ControlButton
          command="resume"
          icon={<RotateCcw size={18} />}
          label="Resume"
          disabled={controlsLocked || state !== "paused"}
          pending={pendingAction === "resume"}
          onCommand={onCommand}
        />
        <ControlButton
          command="stop"
          icon={<Square size={18} />}
          label="Stop"
          disabled={controlsLocked || state === "idle"}
          pending={pendingAction === "stop"}
          onCommand={onCommand}
        />
      </div>
      <button
        className="emergency-button"
        type="button"
        disabled={controlsLocked}
        onClick={() => onCommand("emergency_stop")}
      >
        <Siren size={20} aria-hidden="true" />
        Emergency Stop
      </button>
    </section>
  );
}

function ControlButton({
  command,
  icon,
  label,
  disabled,
  pending,
  onCommand
}: {
  command: RobotCommand;
  icon: ReactNode;
  label: string;
  disabled: boolean;
  pending: boolean;
  onCommand: (command: RobotCommand) => void;
}) {
  return (
    <button type="button" disabled={disabled} onClick={() => onCommand(command)}>
      {icon}
      {pending ? "Sending" : label}
    </button>
  );
}

function FaultPanel({
  disabled,
  pendingAction,
  onInject
}: {
  disabled: boolean;
  pendingAction: string | null;
  onInject: (fault: "drop-connection" | "error") => void;
}) {
  return (
    <section className="fault-panel">
      <div className="panel-heading">
        <h2>Fault Injection</h2>
      </div>
      <div className="control-grid">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onInject("drop-connection")}
          title="Drop simulator connection for five seconds"
        >
          <Zap size={18} aria-hidden="true" />
          {pendingAction === "drop-connection" ? "Dropping" : "Drop 5s"}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onInject("error")}
          title="Put simulator into error state"
        >
          <Bug size={18} aria-hidden="true" />
          {pendingAction === "error" ? "Triggering" : "Error"}
        </button>
      </div>
    </section>
  );
}

function StatePill({ state }: { state: RobotTelemetry["state"] }) {
  return <span className={`state-pill ${state}`}>{state}</span>;
}

function buildAlerts(telemetry: RobotTelemetry | null): AlertItem[] {
  if (!telemetry) {
    return [];
  }

  const alerts: AlertItem[] = [];

  if (telemetry.batteryPercent <= 20) {
    alerts.push({
      key: "battery-low",
      title: "Battery low",
      detail: `${Math.round(telemetry.batteryPercent)}% remaining`,
      severity: telemetry.batteryPercent <= 10 ? "danger" : "warning"
    });
  }

  if (telemetry.tankPercent <= 5) {
    alerts.push({
      key: "tank-empty",
      title: "Tank empty",
      detail: `${Math.round(telemetry.tankPercent)}% spray tank remaining`,
      severity: "danger"
    });
  }

  if (telemetry.state === "error") {
    alerts.push({
      key: "robot-error",
      title: "Robot error",
      detail: telemetry.lastStopReason
        ? `Stopped because of ${telemetry.lastStopReason.replace("_", " ")}`
        : "Robot requires operator attention",
      severity: "danger"
    });
  }

  return alerts;
}

function formatAge(ageMs: number | null): string {
  if (ageMs === null) {
    return "--";
  }

  if (ageMs < 1000) {
    return `${Math.round(ageMs)} ms`;
  }

  return `${(ageMs / 1000).toFixed(1)} s`;
}

function formatNumber(value: number | undefined): string {
  return value === undefined ? "--" : value.toFixed(1);
}
