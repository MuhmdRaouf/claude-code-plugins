import { screen } from "@testing-library/preact";
import { userEvent } from "@testing-library/user-event";
import { createRef } from "preact";
import { describe, expect, it, vi } from "vitest";
import { type Column, ExportButton, Table, TableHead, TableRow, timeText } from "../../src/ui/app/table.tsx";
import { fmtTime } from "../../src/ui/fmt.ts";
import { initialClientState } from "../../src/ui/state.ts";
import { renderApp } from "./render.tsx";

/** The indexed item; throws instead of letting `noUncheckedIndexedAccess` turn into an undefined deref. */
function at<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`nothing at index ${index}`);
  return item;
}

const COLUMNS: Column<"alpha" | "count">[] = [
  { key: "alpha", label: "Alpha" },
  { key: "count", label: "Count", numeric: true },
];

describe("TableHead", () => {
  it("renders one sortable header per column, numeric columns right-aligned", () => {
    const { container } = renderApp(
      <TableHead columns={COLUMNS} sort={{ key: "alpha", dir: "desc" }} action="sort-things" />,
    );
    const heads = [...container.querySelectorAll("th")];
    expect(heads.map((th) => th.textContent)).toEqual(["Alpha", "Count"]);
    expect(heads.map((th) => th.className)).toEqual([
      "bg-base-200/60 text-sm font-medium text-base-content/70",
      "bg-base-200/60 text-sm font-medium text-base-content/70 num text-right",
    ]);
    expect(heads.map((th) => th.getAttribute("scope"))).toEqual(["col", "col"]);
    // numeric sort buttons run the arrow before the label
    expect(at(heads, 1).querySelector("button")?.className).toContain("flex-row-reverse");
    expect(at(heads, 0).querySelector("button")?.className).not.toContain("flex-row-reverse");
  });

  it("marks the sorted column with aria-sort, its arrow and the sort-on class", () => {
    const descending = renderApp(
      <TableHead columns={COLUMNS} sort={{ key: "alpha", dir: "desc" }} action="sort-things" />,
    );
    const heads = [...descending.container.querySelectorAll("th")];
    expect(heads.map((th) => th.getAttribute("aria-sort"))).toEqual(["descending", "none"]);
    expect(at(heads, 0).querySelector('svg[data-icon="chevronDown"]')).toBeTruthy();
    expect(at(heads, 1).querySelector('svg[data-icon="chevronsUpDown"]')).toBeTruthy();
    const buttons = [...descending.container.querySelectorAll("button")];
    expect(buttons.map((button) => button.className)).toEqual([
      "sort-btn -mx-1.5 inline-flex items-center gap-1 rounded-field px-1.5 py-1 hover:text-base-content sort-on text-base-content",
      "sort-btn -mx-1.5 inline-flex items-center gap-1 rounded-field px-1.5 py-1 hover:text-base-content flex-row-reverse",
    ]);
    expect(buttons.map((button) => button.getAttribute("title"))).toEqual(["Sort by alpha", "Sort by count"]);

    const ascending = renderApp(
      <TableHead columns={COLUMNS} sort={{ key: "count", dir: "asc" }} action="sort-things" />,
    );
    const upHead = at([...ascending.container.querySelectorAll("th")], 1);
    expect(upHead.getAttribute("aria-sort")).toBe("ascending");
    expect(upHead.querySelector('svg[data-icon="chevronUp"]')).toBeTruthy();
    expect(upHead.className).toBe("bg-base-200/60 text-sm font-medium text-base-content/70 num text-right");
    expect(upHead.querySelector("button")?.className).toContain("sort-on");
  });

  it("runs the header's sort action with the column key on click", async () => {
    const { container, act } = renderApp(
      <TableHead columns={COLUMNS} sort={{ key: "alpha", dir: "desc" }} action="sort-things" />,
    );
    await userEvent.click(at([...container.querySelectorAll("button")], 1));
    expect(act).toHaveBeenCalledWith("sort-things", "count");
  });
});

describe("timeText", () => {
  it("shows the age with the clock as its tooltip, and the reverse in absolute mode", () => {
    const state = initialClientState();
    expect(timeText(state, 60_000, 70_000)).toEqual({ text: "10s ago", title: fmtTime(60_000) });
    expect(timeText({ ...state, timeMode: "absolute" }, 60_000, 70_000)).toEqual({
      text: fmtTime(60_000),
      title: "10s ago",
    });
  });
});

describe("ExportButton", () => {
  it("offers the CSV download of the shown rows and runs the export on click", async () => {
    const { act } = renderApp(<ExportButton kind="things" count={1} />);
    const button = screen.getByRole("button");
    expect(button.className).toBe("btn btn-sm btn-ghost");
    expect(button.getAttribute("data-action")).toBe("export");
    expect(button.getAttribute("data-value")).toBe("things");
    expect(button.textContent).toBe("Export CSV");
    expect(button.querySelector('svg[data-icon="download"]')).toBeTruthy();
    await userEvent.click(button);
    expect(act).toHaveBeenCalledWith("export", "things");
  });

  it("pluralises the row count in its tooltip", () => {
    renderApp(<ExportButton kind="things" count={2} />);
    expect(screen.getByRole("button").getAttribute("title")).toBe("Download the 2 rows shown as CSV");
  });
});

describe("Table", () => {
  it("wraps the daisyUI table in its scrollable, marked wrap", () => {
    const { container } = renderApp(
      <Table dataKey="things-table">
        <tbody>
          <tr>
            <td>cell</td>
          </tr>
        </tbody>
      </Table>,
    );
    const wrap = container.querySelector(".table-wrap");
    expect(wrap?.getAttribute("data-key")).toBe("things-table");
    expect(wrap?.className).toBe("table-wrap max-h-[calc(100dvh-17rem)] min-h-64 overflow-auto");
    expect(wrap?.querySelector("table")?.className).toBe("table table-pin-rows text-row");
    expect(container.textContent).toContain("cell");
  });

  it("omits the data-key when none is given and carries extra classes through", () => {
    const { container } = renderApp(
      <Table class="table-zebra">
        <tbody>
          <tr>
            <td>cell</td>
          </tr>
        </tbody>
      </Table>,
    );
    expect(container.querySelector(".table-wrap")?.hasAttribute("data-key")).toBe(false);
    expect(container.querySelector("table")?.className).toBe("table table-pin-rows text-row table-zebra");
  });

  it("lays out fixed widths from its columns and leaves the rest to share what is left", () => {
    const { container } = renderApp(
      <Table
        dataKey="things-table"
        columns={[{ key: "a", width: "w-24" }, { key: "b" }, { key: "c", width: "w-32" }]}
      >
        <tbody>
          <tr>
            <td>one</td>
            <td>two</td>
            <td>three</td>
          </tr>
        </tbody>
      </Table>,
    );
    expect(container.querySelector("table")?.className).toBe("table table-pin-rows text-row table-fixed");
    const cols = [...container.querySelectorAll("col")];
    expect(cols.map((col) => col.className)).toEqual(["w-24", "", "w-32"]);
  });

  it("hands the scrollable wrap to wrapRef", () => {
    const ref = createRef<HTMLDivElement>();
    renderApp(
      <Table wrapRef={ref}>
        <tbody>
          <tr>
            <td>cell</td>
          </tr>
        </tbody>
      </Table>,
    );
    expect(ref.current?.className).toBe("table-wrap max-h-[calc(100dvh-17rem)] min-h-64 overflow-auto");
  });
});

describe("TableRow", () => {
  it("renders a plain row carrying its state classes", () => {
    const { container } = renderApp(
      <table>
        <tbody>
          <TableRow>
            <td>plain</td>
          </TableRow>
          <TableRow failed active fresh>
            <td>marked</td>
          </TableRow>
        </tbody>
      </table>,
    );
    const rows = [...container.querySelectorAll("tr")];
    expect(rows.map((row) => row.className)).toEqual(["row", "row bg-error/5 bg-primary/8 row-new"]);
    expect(rows[0]?.hasAttribute("tabindex")).toBe(false);
    expect(screen.getByText("plain")).toBeTruthy();
  });

  it("focuses a clickable row and opens it on click, Enter and Space", async () => {
    const onOpen = vi.fn();
    const { container } = renderApp(
      <table>
        <tbody>
          <TableRow onOpen={onOpen}>
            <td>open me</td>
          </TableRow>
        </tbody>
      </table>,
    );
    const row = container.querySelector("tr");
    expect(row?.getAttribute("tabindex")).toBe("0");
    await userEvent.click(row as HTMLElement);
    expect(onOpen).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledTimes(2);
    await userEvent.keyboard(" ");
    expect(onOpen).toHaveBeenCalledTimes(3);
  });
});
