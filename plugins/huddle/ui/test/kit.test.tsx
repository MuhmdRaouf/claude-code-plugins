import { render, screen } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { Avatar, Empty, Pill, SessionPill, Skeleton, Stat, StatusIcon, Time } from "../src/kit.tsx";
import { avatarColor, type Session, type Task } from "../src/status.ts";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const find = (id: string): Task | null => (id === "t1" ? { status: "blocked" } : null);
const PAUSED: Session = { control: "pause", control_by: "owner", control_at: "2026-10-08T11:59:00Z" };

describe("Pill", () => {
  it("maps every status word of the table to its hue", () => {
    const tones: readonly (readonly [string, string])[] = [
      ["todo", "badge-ghost"],
      ["doing", "badge-info"],
      ["done", "badge-success"],
      ["skipped", "badge-ghost"],
      ["blocked", "badge-error"],
      ["waiting", "badge-warning"],
      ["paused", "badge-secondary"],
      ["working", "badge-info"],
      ["idle", "badge-ghost"],
      ["left", "badge-ghost"],
      ["needs", "badge-error"],
      ["info", "badge-info"],
      ["violet", "badge-secondary"],
    ];
    for (const [status, tone] of tones) {
      const { container, unmount } = render(<Pill status={status} />);
      const pill = container.querySelector(".badge");
      expect(pill?.className).toBe(`badge badge-sm ${tone}`);
      unmount();
    }
  });

  it("labels from the status tables, takes a label, and falls back to the word itself", () => {
    render(
      <div>
        <Pill status="todo" />
        <Pill status="paused" />
        <Pill status="todo" label="To do now" />
        <Pill status="mysterious" />
      </div>,
    );
    expect(screen.getByText("To do")).not.toBeNull();
    expect(screen.getByText("Paused")).not.toBeNull();
    expect(screen.getByText("To do now")).not.toBeNull();
    expect(screen.getByText("mysterious")).not.toBeNull();
  });
});

describe("StatusIcon", () => {
  it("shows the status word as icon colour, title and screen-reader text", () => {
    render(<StatusIcon status="done" />);
    const icon = screen.getByTitle("Done");
    expect(icon.className).toBe("c-green ink inline-flex");
    expect(icon.querySelector("svg")).not.toBeNull();
    expect(icon.querySelector(".sr-only")?.textContent).toBe("Done");
  });

  it("reads an unknown word as to do and sizes the icon as asked", () => {
    render(<StatusIcon status="mysterious" class="size-3.5" />);
    const icon = screen.getByTitle("To do");
    expect(icon.className).toBe("c-idle ink inline-flex");
    expect(icon.querySelector("svg")?.getAttribute("class")).toBe("size-3.5 shrink-0");
  });
});

describe("SessionPill", () => {
  it("shows the derived status and keeps the reason in its title", () => {
    render(
      <div>
        <SessionPill session={{ state: "working" }} taskById={find} now={NOW} />
        <SessionPill session={PAUSED} taskById={find} now={NOW} />
        <SessionPill session={{ state: "idle", step: "t1" }} taskById={find} now={NOW} />
      </div>,
    );
    expect(screen.getByText("Working").className).toBe("badge badge-info");
    expect(
      screen.getByTitle("Paused by you 1 min ago. Its changes are refused until you resume it.").textContent,
    ).toBe("Paused");
    expect(screen.getByTitle("Blocked: it cannot go on without help.").className).toContain("badge-error");
  });

  it("goes small when asked", () => {
    render(<SessionPill session={{ state: "working" }} taskById={find} now={NOW} small />);
    expect(screen.getByText("Working").className).toBe("badge badge-info badge-sm");
  });
});

describe("Avatar", () => {
  it("initials the last dot segment and colours it from the name", () => {
    render(<Avatar name="greta.sub" />);
    const av = screen.getByText("S");
    expect(av.className).toBe("ink text-sm font-semibold");
    const disc = av.closest(".avatar");
    expect(disc?.className).toBe(`avatar avatar-placeholder ${avatarColor("greta.sub")}`);
    expect(disc?.getAttribute("aria-hidden")).toBe("true");
  });

  it("renders the owner as a mauve Y, and goes small when asked", () => {
    render(
      <div>
        <Avatar name="owner" small />
        <Avatar name="owner" />
      </div>,
    );
    const avs = screen.getAllByText("Y");
    expect(avs.every((av) => av.closest(".avatar")?.className.includes("c-mauve"))).toBe(true);
    expect(avs[0]?.closest(".avatar")?.querySelector("span span")?.className).toBe("w-6 rounded-full tinted");
    expect(avs[1]?.closest(".avatar")?.querySelector("span span")?.className).toBe("w-8 rounded-full tinted");
  });

  it("draws an empty disc for a name without a letter", () => {
    const { container } = render(<Avatar name="" />);
    const av = container.querySelector(".avatar");
    expect(av?.textContent).toBe("");
    expect(av?.className).toBe(`avatar avatar-placeholder ${avatarColor("")}`);
  });
});

describe("Stat", () => {
  it("lays out label, delta, tinted icon, value and subline", () => {
    const { container } = render(
      <Stat
        icon="users"
        tint="c-green"
        label="Members"
        value={7}
        sub="3 working"
        delta={{ up: true, text: "+2" }}
      />,
    );
    expect(screen.getByText("Members").className).toBe("min-w-0 flex-1 truncate");
    expect(screen.getByText("+2").className).toBe("badge badge-sm badge-success tnum");
    expect(container.querySelector(".stat-figure")?.className).toBe(
      "stat-figure tinted ink inline-flex size-7 shrink-0 items-center justify-center rounded-lg c-green",
    );
    expect(container.querySelector(".stat-figure svg")).not.toBeNull();
    expect(screen.getByText("7")).not.toBeNull();
    expect(screen.getByText("3 working")).not.toBeNull();
  });

  it("marks a falling delta and skips what is not given", () => {
    const { container } = render(
      <Stat icon="activity" label="Events" value={0} delta={{ up: false, text: "-1" }} />,
    );
    expect(screen.getByText("-1").className).toBe("badge badge-sm badge-error tnum");
    expect(screen.getByText("0")).not.toBeNull();
    expect(container.querySelector(".stat-figure")?.className).toBe(
      "stat-figure tinted ink inline-flex size-7 shrink-0 items-center justify-center rounded-lg",
    );
    expect(container.querySelector(".stat-desc")).toBeNull();
  });

  it("shows the bare value when no delta, sub or tint is given", () => {
    const { container } = render(<Stat icon="inbox" label="Signed in" value={2} />);
    expect(screen.getByText("2")).not.toBeNull();
    expect(container.querySelector(".badge-success")).toBeNull();
    expect(container.querySelector(".badge-error")).toBeNull();
    expect(container.querySelector(".stat-desc")).toBeNull();
    expect(container.querySelector(".stat-figure")).not.toBeNull();
  });
});

describe("Empty", () => {
  it("shows its text, and the hint and icon only when given", () => {
    const { container } = render(<Empty text="No events yet" />);
    expect(screen.getByText("No events yet")).not.toBeNull();
    expect(container.querySelector(".max-w-sm")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("shows hint and icon when given", () => {
    const { container } = render(
      <Empty text="No events yet" hint="Say something in the channel" icon="inbox" />,
    );
    expect(screen.getByText("No events yet")).not.toBeNull();
    expect(screen.getByText("Say something in the channel").className).toBe("max-w-sm text-sm muted");
    expect(container.querySelector("svg")?.getAttribute("class")).toBe("size-6 mb-1 shrink-0");
  });
});

describe("Skeleton", () => {
  it("shows four h-14 rows and announces loading", () => {
    const { container } = render(<Skeleton />);
    const box = container.querySelector("[aria-busy='true']");
    expect(box?.getAttribute("aria-label")).toBe("Loading");
    expect(box?.className).toBe("flex flex-col gap-2");
    expect(container.querySelectorAll(".skeleton").length).toBe(4);
    expect(container.querySelector(".skeleton")?.className).toBe("skeleton h-14");
  });

  it("takes a row count and a row height", () => {
    const { container } = render(<Skeleton rows={2} class="h-28" />);
    expect(container.querySelectorAll(".skeleton").length).toBe(2);
    expect(container.querySelector(".skeleton")?.className).toBe("skeleton h-28");
  });
});

describe("Time", () => {
  it("shows the relative text, and the absolute time in datetime, title and data-ts", () => {
    render(<Time ts="2026-10-08T11:55:00Z" now={NOW} />);
    const el = screen.getByText("5 min ago");
    expect(el.tagName).toBe("TIME");
    expect(el.getAttribute("datetime")).toBe("2026-10-08T11:55:00Z");
    expect(el.getAttribute("data-ts")).toBe("2026-10-08T11:55:00Z");
    expect(el.getAttribute("title")).toBe(new Date("2026-10-08T11:55:00Z").toLocaleString());
  });

  it("says — for an unknown time", () => {
    render(<Time ts={null} now={NOW} />);
    const el = screen.getByText("—");
    expect(el.getAttribute("datetime")).toBe("");
    expect(el.getAttribute("title")).toBe("");
  });
});
