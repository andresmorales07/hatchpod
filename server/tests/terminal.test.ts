import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock node-pty before importing terminal.ts
const mockOnData = vi.fn();
const mockOnExit = vi.fn();
const mockKill = vi.fn();
const mockSpawn = vi.fn();

vi.mock("node-pty", () => ({
  default: { spawn: mockSpawn },
}));

// Import after mock is in place
const { createPtySession } = await import("../src/terminal.js");

describe("createPtySession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawn.mockReturnValue({
      onData: mockOnData,
      onExit: mockOnExit,
      kill: mockKill,
    });
  });

  it("spawns the shell with -l (login shell) flag", () => {
    createPtySession("/bin/bash", "/home/hatchpod/workspace");

    expect(mockSpawn).toHaveBeenCalledOnce();
    const [_shell, args] = mockSpawn.mock.calls[0] as [string, string[], unknown];
    expect(args).toContain("-l");
  });

  it("uses the provided shell path", () => {
    createPtySession("/bin/zsh", "/tmp");

    const [shell] = mockSpawn.mock.calls[0] as [string, string[], unknown];
    expect(shell).toBe("/bin/zsh");
  });

  it("uses the provided cwd", () => {
    createPtySession("/bin/bash", "/home/hatchpod/workspace");

    const [, , opts] = mockSpawn.mock.calls[0] as [string, string[], { cwd: string }];
    expect(opts.cwd).toBe("/home/hatchpod/workspace");
  });
});
