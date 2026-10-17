/**
 * The provider as the shared suites read it: the fields their checks name. Each plugin passes its own provider object
 * (plugins/<p>-plugin-cc/test/provider.ts), whose type carries more; TypeScript's structural typing accepts it here.
 */
export interface Provider {
  /** The CLI's name: message prefix `<name>: …`, `<name> job <id>`, the synopsis. */
  readonly name: string;
  /** The provider as people know it, e.g. "Z.ai GLM"; agent descriptions and setup lines name it. */
  readonly display: string;
  /** Slash-command prefix, e.g. "/zai:" in `/zai:board`. */
  readonly slash: string;
  /** Agent prefix, e.g. "zai:" in `zai:glm-5.3`. */
  readonly agentPrefix: string;
  /** Environment-variable prefix: `${envPrefix}_STATE_DIR`, `${envPrefix}_CLAUDE_BIN`, `${envPrefix}_ROUTER_PORT`. */
  readonly envPrefix: string;
  /** The dispatch agents (without the prefix) per tier: the shipped catalog's model ids. */
  readonly agents: { readonly main: string; readonly flash: string };
  /** The model behind each tier. */
  readonly catalog: {
    readonly main: { readonly id: string; readonly label: string };
    readonly flash: { readonly id: string; readonly label: string };
  };
  /** API key environment variables in priority order. */
  readonly keyEnv: readonly string[];
  /** This plugin's own router: its port and its GET health path. */
  readonly router: { readonly port: number; readonly healthPath: string };
}

/** The claude worker's effort levels (the plugin-core binary's claude-headless adapter); agent files ship `max`. */
export const CLAUDE_EFFORTS = ["low", "high", "max"] as const;
