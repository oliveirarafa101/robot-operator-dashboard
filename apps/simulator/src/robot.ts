import {
  type CommandResult,
  clampPercent,
  type MissionEndReason,
  type RobotCommand,
  type RobotState,
  type RobotTelemetry
} from "@robot/shared";

interface RobotSnapshot {
  robotId: string;
  sequence: number;
  timestamp: number;
  position: {
    x: number;
    y: number;
  };
  batteryPercent: number;
  tankPercent: number;
  state: RobotState;
  missionId: string | null;
  lastCommand: RobotCommand | null;
  lastStopReason: MissionEndReason | null;
}

const FIELD_MIN = 0;
const FIELD_MAX = 100;
const STEP_DISTANCE = 0.8;

export class RobotSimulator {
  private missionCounter = 0;
  private headingRadians = -Math.PI / 7;
  private snapshot: RobotSnapshot;

  constructor(robotId = "greenhouse-robot-01") {
    const now = Date.now();
    this.snapshot = {
      robotId,
      sequence: 0,
      timestamp: now,
      position: { x: 18, y: 72 },
      batteryPercent: 100,
      tankPercent: 100,
      state: "idle",
      missionId: null,
      lastCommand: null,
      lastStopReason: null
    };
  }

  applyCommand(command: RobotCommand): CommandResult {
    const transition = this.transition(command);
    this.snapshot.lastCommand = command;

    return {
      accepted: transition.accepted,
      command,
      state: this.snapshot.state,
      reason: transition.reason,
      telemetry: this.getTelemetry()
    };
  }

  injectError(): RobotTelemetry {
    this.snapshot.state = "error";
    this.snapshot.missionId = null;
    this.snapshot.lastStopReason = "error";
    return this.getTelemetry();
  }

  tick(now = Date.now()): RobotTelemetry {
    if (this.snapshot.state === "running") {
      this.advanceMotion();
      this.drainConsumables();
    }

    this.snapshot.sequence += 1;
    this.snapshot.timestamp = now;
    return this.getTelemetry();
  }

  getTelemetry(): RobotTelemetry {
    return {
      robotId: this.snapshot.robotId,
      sequence: this.snapshot.sequence,
      timestamp: this.snapshot.timestamp,
      position: { ...this.snapshot.position },
      batteryPercent: this.snapshot.batteryPercent,
      tankPercent: this.snapshot.tankPercent,
      state: this.snapshot.state,
      missionId: this.snapshot.missionId,
      lastCommand: this.snapshot.lastCommand,
      lastStopReason: this.snapshot.lastStopReason
    };
  }

  private transition(command: RobotCommand): { accepted: boolean; reason?: string } {
    switch (command) {
      case "start_mission":
        if (this.snapshot.state !== "idle") {
          return { accepted: false, reason: "Mission can only start from idle." };
        }

        this.missionCounter += 1;
        this.snapshot.state = "running";
        this.snapshot.missionId = `mission-${this.missionCounter}`;
        this.snapshot.lastStopReason = null;
        return { accepted: true };

      case "pause":
        if (this.snapshot.state !== "running") {
          return { accepted: false, reason: "Robot is not running." };
        }

        this.snapshot.state = "paused";
        return { accepted: true };

      case "resume":
        if (this.snapshot.state !== "paused") {
          return { accepted: false, reason: "Robot is not paused." };
        }

        this.snapshot.state = "running";
        return { accepted: true };

      case "stop":
        if (this.snapshot.state === "idle") {
          return { accepted: false, reason: "Robot is already idle." };
        }

        this.snapshot.state = "idle";
        this.snapshot.missionId = null;
        this.snapshot.lastStopReason = "stopped";
        return { accepted: true };

      case "emergency_stop":
        this.snapshot.state = "error";
        this.snapshot.missionId = null;
        this.snapshot.lastStopReason = "emergency_stop";
        return { accepted: true };
    }

    return { accepted: false, reason: "Unsupported command." };
  }

  private advanceMotion(): void {
    const nextX = this.snapshot.position.x + Math.cos(this.headingRadians) * STEP_DISTANCE;
    const nextY = this.snapshot.position.y + Math.sin(this.headingRadians) * STEP_DISTANCE;

    if (nextX <= FIELD_MIN || nextX >= FIELD_MAX) {
      this.headingRadians = Math.PI - this.headingRadians;
    }

    if (nextY <= FIELD_MIN || nextY >= FIELD_MAX) {
      this.headingRadians = -this.headingRadians;
    }

    this.snapshot.position.x = Math.max(FIELD_MIN, Math.min(FIELD_MAX, nextX));
    this.snapshot.position.y = Math.max(FIELD_MIN, Math.min(FIELD_MAX, nextY));
  }

  private drainConsumables(): void {
    this.snapshot.batteryPercent = clampPercent(this.snapshot.batteryPercent - 0.015);
    this.snapshot.tankPercent = clampPercent(this.snapshot.tankPercent - 0.04);

    if (this.snapshot.batteryPercent <= 0 || this.snapshot.tankPercent <= 0) {
      this.snapshot.state = "error";
      this.snapshot.missionId = null;
      this.snapshot.lastStopReason = "error";
    }
  }
}
