import { describe, expect, it } from "vitest";
import { RobotSimulator } from "../src/robot.js";

describe("RobotSimulator", () => {
  it("applies the normal mission command transitions", () => {
    const robot = new RobotSimulator("test-robot");

    expect(robot.applyCommand("start_mission")).toMatchObject({
      accepted: true,
      state: "running"
    });
    expect(robot.applyCommand("pause")).toMatchObject({
      accepted: true,
      state: "paused"
    });
    expect(robot.applyCommand("resume")).toMatchObject({
      accepted: true,
      state: "running"
    });
    expect(robot.applyCommand("stop")).toMatchObject({
      accepted: true,
      state: "idle"
    });
  });

  it("rejects unsafe transitions instead of silently changing state", () => {
    const robot = new RobotSimulator("test-robot");

    const result = robot.applyCommand("pause");

    expect(result.accepted).toBe(false);
    expect(result.state).toBe("idle");
  });

  it("puts the robot into error state on emergency stop", () => {
    const robot = new RobotSimulator("test-robot");

    robot.applyCommand("start_mission");
    const result = robot.applyCommand("emergency_stop");

    expect(result).toMatchObject({
      accepted: true,
      state: "error"
    });
    expect(result.telemetry.lastStopReason).toBe("emergency_stop");
  });
});
