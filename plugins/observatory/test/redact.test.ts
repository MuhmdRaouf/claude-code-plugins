import { describe, expect, it } from "vitest";
import { FIELD_LIMIT, isEnvFilePath, isSecretKey, scrub, scrubText, truncate } from "../src/shared/redact.ts";

describe("isSecretKey", () => {
  it("matches the obvious shapes at any casing", () => {
    for (const key of [
      "api_key",
      "API_KEY",
      "authToken",
      "Authorization",
      "cookie",
      "PASSWORD",
      "clientSecret",
    ]) {
      expect(isSecretKey(key)).toBe(true);
    }
  });

  it("does not match ordinary keys", () => {
    for (const key of ["model", "command", "file_path", "cwd", "prompt", "tool_use_id"]) {
      expect(isSecretKey(key)).toBe(false);
    }
  });
});

describe("isEnvFilePath", () => {
  it("accepts .env, dotted variants and named env files, with or without a directory", () => {
    for (const value of [".env", ".env.local", "/srv/app/.env", "prod.env", "../secrets/staging.env"]) {
      expect(isEnvFilePath(value)).toBe(true);
    }
  });

  it("rejects ordinary paths and env-ish words", () => {
    for (const value of ["src/env.ts", ".environment", "environment", "notes.txt", ""]) {
      expect(isEnvFilePath(value)).toBe(false);
    }
  });
});

describe("truncate", () => {
  it("keeps short text as-is", () => {
    expect(truncate("hello")).toBe("hello");
  });

  it("cuts at the limit and reports what was dropped", () => {
    expect(truncate("abcdefghij", 8)).toBe("abcdefgh…[truncated 2 chars]");
    expect(truncate("x".repeat(FIELD_LIMIT + 3), FIELD_LIMIT)).toBe(
      `${"x".repeat(FIELD_LIMIT)}…[truncated 3 chars]`,
    );
  });

  it("counts characters, not bytes", () => {
    const text = "é".repeat(10);
    expect(truncate(text, 4)).toBe("éééé…[truncated 6 chars]");
  });
});

describe("scrubText", () => {
  it("returns undefined for anything that is not a string", () => {
    expect(scrubText(42)).toBeUndefined();
    expect(scrubText(null)).toBeUndefined();
    expect(scrubText({ content: "hi" })).toBeUndefined();
  });

  it("masks bearer headers and sk- keys inside free text", () => {
    expect(scrubText("Authorization: Bearer abc123XYZ")).toBe("Authorization: Bearer [redacted]");
    expect(scrubText("the key sk-abcdefgh123456 leaked")).toBe("the key [redacted] leaked");
    expect(scrubText("plain prompt text")).toBe("plain prompt text");
  });

  it("requires the sk- body to be long enough that ordinary words survive", () => {
    expect(scrubText("task-sk-123 done")).toBe("task-sk-123 done");
  });

  it("truncates to a custom limit", () => {
    expect(scrubText("0123456789", 4)).toBe("0123…[truncated 6 chars]");
  });
});

describe("scrub", () => {
  it("replaces the value of any secret key, at any depth, in objects and arrays", () => {
    const input = {
      model: "claude-sonnet-5-5",
      api_key: "sk-abcdefgh123456",
      nested: { sessionToken: "top", keep: "me" },
      list: [{ password: "hunter2" }, "plain item"],
    };
    const out = scrub(input) as Record<string, unknown>;
    expect(out.model).toBe("claude-sonnet-5-5");
    expect(out.api_key).toBe("[redacted]");
    const nested = out.nested as Record<string, unknown>;
    expect(nested.sessionToken).toBe("[redacted]");
    expect(nested.keep).toBe("me");
    const list = out.list as unknown[];
    expect((list[0] as Record<string, unknown>).password).toBe("[redacted]");
    expect(list[1]).toBe("plain item");
  });

  it("redacts content-bearing keys when the same object mentions an env file", () => {
    const out = scrub({
      file_path: ".env",
      command: "cat /etc/passwd",
      content: "SECRET=1",
      model: "glm-5.3",
    }) as Record<string, unknown>;
    expect(out.file_path).toBe(".env");
    expect(out.command).toBe("[redacted]");
    expect(out.content).toBe("[redacted]");
    expect(out.model).toBe("glm-5.3");
  });

  it("keeps content keys when no env path is in sight", () => {
    const out = scrub({ file_path: "src/app.ts", command: "npm test" }) as Record<string, unknown>;
    expect(out.command).toBe("npm test");
  });

  it("masks bearer/sk- material in plain string values and truncates everything", () => {
    const long = `${"a".repeat(100)} sk-abcdefgh123456 ${"b".repeat(3000)}`;
    const out = scrub({ note: long }, 64) as Record<string, unknown>;
    const note = out.note as string;
    expect(note.startsWith("a".repeat(64))).toBe(true);
    expect(note).toContain("…[truncated ");
    expect(note).not.toContain("sk-abcdefgh123456");
  });

  it("passes scalars through untouched", () => {
    expect(scrub(7)).toBe(7);
    expect(scrub(true)).toBe(true);
    expect(scrub(null)).toBe(null);
    expect(scrub(undefined)).toBeUndefined();
  });

  it("leaves the input unmodified (a fresh value comes back)", () => {
    const input = { api_key: "sk-abcdefgh123456", safe: "yes" };
    const out = scrub(input) as Record<string, unknown>;
    expect(input.api_key).toBe("sk-abcdefgh123456");
    expect(out.api_key).toBe("[redacted]");
    expect(out.safe).toBe("yes");
  });
});
