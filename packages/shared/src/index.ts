// Keeping these as literal arrays gives us one runtime allow-list and one
// TypeScript union. Adding a state here updates both sides of the contract.
export const ROBOT_STATES = ["idle", "running", "paused", "error"] as const;
export type RobotState = (typeof ROBOT_STATES)[number];

// Command names are protocol values, not UI labels. A dashboard, mobile app,
// or future API client must all ask the robot for the same operations.
export const ROBOT_COMMANDS = [
  "start_mission",
  "pause",
  "resume",
  "stop",
  "emergency_stop"
] as const;
export type RobotCommand = (typeof ROBOT_COMMANDS)[number];

// Keep URL spelling at the edge of the system; the domain uses the more useful
// `start_mission` form while the REST API remains conventional kebab-case.
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

// This is the stable, public view of the robot. The simulator can keep richer
// internal state, but every consumer agrees on this small contract.
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

// Transport health belongs next to telemetry rather than inside it: a robot can
// be healthy while the route used to observe it is not.
export interface GatewayStatus {
  simulatorConnected: boolean;
  lastTelemetryAt: number | null;
  lastTelemetryReceivedAt: number | null;
  serverTime: number;
}

// Sending gateway status with every browser message means a newly connected UI
// does not have to infer link health from an old telemetry timestamp alone.
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
  // Do not cast arbitrary route text into a command. This is the small
  // allow-list used by both HTTP servers before touching robot state.
  const match = ROBOT_COMMANDS.find((command) => COMMAND_PATHS[command] === path);
  return match ?? null;
}

export function isRobotCommand(value: string): value is RobotCommand {
  return ROBOT_COMMANDS.includes(value as RobotCommand);
}

export function clampPercent(value: number): number {
  // Simulation drains resources in small fractions. Preserve two decimals for
  // telemetry while never allowing UI meters to exceed their natural bounds.
  return Math.max(0, Math.min(100, Number(value.toFixed(2))));
}
