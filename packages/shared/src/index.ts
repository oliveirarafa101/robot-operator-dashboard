export const ROBOT_STATES = ["idle", "running", "paused", "error"] as const;
export type RobotState = (typeof ROBOT_STATES)[number];

export const ROBOT_COMMANDS = [
  "start_mission",
  "pause",
  "resume",
  "stop",
  "emergency_stop"
] as const;
export type RobotCommand = (typeof ROBOT_COMMANDS)[number];

export const COMMAND_PATHS: Record<RobotCommand, string> = {
  start_mission: "start-mission",
  pause: "pause",
  resume: "resume",
  stop: "stop",
  emergency_stop: "emergency-stop"
};

export type MissionEndReason = "completed" | "stopped" | "error" | "emergency_stop";

export interface RobotPosition {
  x: number;
  y: number;
}

export interface RobotTelemetry {
  robotId: string;
  sequence: number;
  timestamp: number;
  position: RobotPosition;
  batteryPercent: number;
  tankPercent: number;
  state: RobotState;
  missionId: string | null;
  lastCommand: RobotCommand | null;
  lastStopReason: MissionEndReason | null;
}

export interface SimulatorTelemetryMessage {
  type: "telemetry";
  telemetry: RobotTelemetry;
}

export interface CommandResult {
  accepted: boolean;
  command: RobotCommand;
  state: RobotState;
  reason?: string;
  telemetry: RobotTelemetry;
}

export interface GatewayStatus {
  simulatorConnected: boolean;
  lastTelemetryAt: number | null;
  lastTelemetryReceivedAt: number | null;
  serverTime: number;
}

export type BrowserSocketMessage =
  | {
      type: "snapshot";
      telemetry: RobotTelemetry | null;
      status: GatewayStatus;
    }
  | {
      type: "telemetry";
      telemetry: RobotTelemetry;
      status: GatewayStatus;
    }
  | {
      type: "simulator_connection";
      status: GatewayStatus;
    };

export function commandFromPath(path: string): RobotCommand | null {
  const match = ROBOT_COMMANDS.find((command) => COMMAND_PATHS[command] === path);
  return match ?? null;
}

export function isRobotCommand(value: string): value is RobotCommand {
  return ROBOT_COMMANDS.includes(value as RobotCommand);
}

export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Number(value.toFixed(2))));
}
