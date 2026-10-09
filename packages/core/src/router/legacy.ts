// The one-time migration off the OS services an earlier release installed (a LaunchAgent on macOS, a systemd --user
// unit on Linux). This is the only file that names those tools. Order is everything: the old service is stopped, the
// new plugin-started router is started on the same port in the same call, and only once the new one answers health
// is the old definition removed. If the new router does not come up, the old service is started again and left
// alone, and the line says so. Every command goes through an injected runner; tests never run one.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Runs one command; true on exit 0. */
export type CommandRunner = (bin: string, args: readonly string[]) => boolean;

interface LegacyService {
  readonly kind: "launchd" | "systemd";
  /** The plist or unit file. */
  readonly definition: string;
  readonly label: string;
}

/** The legacy service definition for this label under the home directory, if one is still on disk. */
export function findLegacyService(label: string, home: string): LegacyService | undefined {
  const plist = join(home, "Library", "LaunchAgents", `${label}.plist`);
  if (existsSync(plist)) return { kind: "launchd", definition: plist, label };
  const unit = join(home, ".config", "systemd", "user", `${label}.service`);
  if (existsSync(unit)) return { kind: "systemd", definition: unit, label };
  return undefined;
}

interface MigrationResult {
  /** True once the old service is gone and the new router holds the port. */
  readonly migrated: boolean;
  readonly line: string;
}

/** Replaces the legacy service with the plugin-started router, never leaving the port without one for longer than
 *  the start takes. `startNew` starts the new router and resolves true once it answers health. */
export async function migrateLegacyService(
  service: LegacyService,
  run: CommandRunner,
  startNew: () => Promise<boolean>,
  uid: number,
): Promise<MigrationResult> {
  const domain = `gui/${uid}`;
  const unit = `${service.label}.service`;
  if (service.kind === "launchd") run("launchctl", ["bootout", `${domain}/${service.label}`]);
  else run("systemctl", ["--user", "stop", unit]);
  if (!(await startNew())) {
    if (service.kind === "launchd") run("launchctl", ["bootstrap", domain, service.definition]);
    else run("systemctl", ["--user", "start", unit]);
    return {
      migrated: false,
      line: `kept the old ${service.kind} service ${service.label}: the new router did not come up`,
    };
  }
  if (service.kind === "systemd") run("systemctl", ["--user", "disable", "--now", unit]);
  rmSync(service.definition, { force: true });
  if (service.kind === "systemd") run("systemctl", ["--user", "daemon-reload"]);
  return {
    migrated: true,
    line: `replaced the old ${service.kind} service ${service.label} with the plugin's router`,
  };
}
