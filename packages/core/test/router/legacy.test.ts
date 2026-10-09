// The one-time migration off the OS services: commands are recorded, never run.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findLegacyService, migrateLegacyService } from "../../src/router/legacy.ts";
import { tempDir } from "../support/tmp.ts";

describe("the legacy service migration (commands recorded, never run)", () => {
  function home(kind: "launchd" | "systemd" | "none"): string {
    const dir = tempDir("router-legacy-");
    if (kind === "launchd") {
      mkdirSync(join(dir, "Library", "LaunchAgents"), { recursive: true });
      writeFileSync(join(dir, "Library", "LaunchAgents", "test.acme-router.plist"), "<plist/>");
    } else if (kind === "systemd") {
      mkdirSync(join(dir, ".config", "systemd", "user"), { recursive: true });
      writeFileSync(join(dir, ".config", "systemd", "user", "test.acme-router.service"), "[Unit]");
    }
    return dir;
  }

  it("finds nothing where nothing was installed", () => {
    expect(findLegacyService("test.acme-router", home("none"))).toBeUndefined();
  });

  it("stops the LaunchAgent, starts the new router, and only then removes the plist", async () => {
    const dir = home("launchd");
    const service = findLegacyService("test.acme-router", dir);
    expect(service?.kind).toBe("launchd");
    const calls: string[] = [];
    const result = await migrateLegacyService(
      service as NonNullable<typeof service>,
      (bin, args) => {
        calls.push(`${bin} ${args.join(" ")}`);
        return true;
      },
      async () => {
        calls.push("start new");
        expect(existsSync(service?.definition ?? "")).toBe(true);
        return true;
      },
      501,
    );
    expect(calls).toEqual(["launchctl bootout gui/501/test.acme-router", "start new"]);
    expect(result).toEqual({
      migrated: true,
      line: expect.stringContaining("replaced the old launchd service"),
    });
    expect(existsSync(service?.definition ?? "")).toBe(false);
  });

  it("leaves the old systemd unit running when the new router does not come up", async () => {
    const dir = home("systemd");
    const service = findLegacyService("test.acme-router", dir);
    const calls: string[] = [];
    const run = (bin: string, args: readonly string[]): boolean => {
      calls.push(`${bin} ${args.join(" ")}`);
      return true;
    };
    const kept = await migrateLegacyService(
      service as NonNullable<typeof service>,
      run,
      async () => false,
      1000,
    );
    expect(kept.migrated).toBe(false);
    expect(calls).toEqual([
      "systemctl --user stop test.acme-router.service",
      "systemctl --user start test.acme-router.service",
    ]);
    expect(existsSync(service?.definition ?? "")).toBe(true);

    calls.length = 0;
    const replaced = await migrateLegacyService(
      service as NonNullable<typeof service>,
      run,
      async () => true,
      1000,
    );
    expect(replaced.migrated).toBe(true);
    expect(calls).toEqual([
      "systemctl --user stop test.acme-router.service",
      "systemctl --user disable --now test.acme-router.service",
      "systemctl --user daemon-reload",
    ]);
    expect(existsSync(service?.definition ?? "")).toBe(false);
  });

  it("restarts a LaunchAgent the new router could not replace", async () => {
    const service = findLegacyService("test.acme-router", home("launchd"));
    const calls: string[] = [];
    await migrateLegacyService(
      service as NonNullable<typeof service>,
      (bin, args) => calls.push(`${bin} ${args.join(" ")}`) > 0,
      async () => false,
      7,
    );
    expect(calls).toEqual([
      "launchctl bootout gui/7/test.acme-router",
      `launchctl bootstrap gui/7 ${service?.definition}`,
    ]);
  });
});
