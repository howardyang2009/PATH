import { DEFAULT_PLUGINS, type StubServerOptions, stubClient } from "@path/client-core/test-utils";
import { type Locale, loadMessages } from "@path/i18n";
import { FORMAT_VERSION, type WorkflowFile } from "@path/schema";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { ConflictMarker, ConflictProvider } from "../src/conflict-context.js";
import { openWorkflowFile } from "../src/open-workflow.js";
import { fileProblems, problemMarks } from "../src/problems.js";
import { ProblemsPanel } from "../src/problems-panel.js";
import { canonicalSerialize } from "../src/serialize.js";

/**
 * #392 — the launch warning badge and the dangling-`workflow`-ref marker. A create-new child ref
 * (#391) points the parent at a path with no file yet; that transient state surfaces as a per-node
 * ⚠ and a problems-panel row, badges (never blocks) launch, and clears when the child's first save
 * makes discovery list it.
 */

function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

const PARENT_PATH = "flows/parent.workflow.json";
const CHILD_PATH = "flows/child.workflow.json";

/** A parent whose one `workflow` node refs `child.workflow.json` (resolves to
 * `flows/child.workflow.json`). */
function parentFile(withId: boolean): Record<string, unknown> {
  return {
    format: FORMAT_VERSION,
    ...(withId ? { id: uuid(1) } : {}),
    name: "parent",
    body: [
      {
        type: "workflow",
        ...(withId ? { id: uuid(2) } : {}),
        name: "child",
        ref: "child.workflow.json",
      },
    ],
  };
}

/** The canonical on-disk bytes — what a save writes, so the file opens clean (launch not
 * dirty-gated). */
function canonical(f: Record<string, unknown>): string {
  const opened = openWorkflowFile(JSON.stringify(f), DEFAULT_PLUGINS);
  if (opened.status !== "opened") throw new Error(opened.status);
  return canonicalSerialize(opened.file);
}

/** A discovery summary row for a path (only `relative_path` matters to the dangling-ref check). */
function summary(relativePath: string) {
  return {
    relative_path: relativePath,
    origin: "user",
    root_path: relativePath,
    action: "open",
    id: null,
    name: null,
    valid: true,
    is_root: null,
    error: null,
  };
}

async function openParent(options: StubServerOptions) {
  render(<App client={stubClient(options)} initialPath={PARENT_PATH} />);
  await screen.findByText("child", { selector: ".node-name" });
  return screen.getByRole("region", { name: "Workflow canvas" });
}

describe("dangling-`workflow`-ref marker + launch badge", () => {
  it("marks the ref node and lists it in the problems panel when the target is unsaved", async () => {
    const canvas = await openParent({
      files: { [PARENT_PATH]: canonical(parentFile(true)) },
      workflows: { workflows: [summary(PARENT_PATH)] }, // child not discovered → dangling
    });

    // Per-node ⚠ on the ref chip.
    const marker = within(canvas).getByRole("img", { name: /Validation error/ });
    expect(marker).toHaveTextContent("⚠");

    // Aggregate panel row, tagged `ref`, naming the unsaved target.
    const panel = await screen.findByRole("region", { name: "Problems" });
    expect(within(panel).getByText(/has no saved file yet/)).toBeInTheDocument();
    expect(within(panel).getByText("ref")).toBeInTheDocument();
  });

  it("does not flag the ref once the target is a discovered (saved) file", async () => {
    await openParent({
      files: { [PARENT_PATH]: canonical(parentFile(true)) },
      workflows: { workflows: [summary(PARENT_PATH), summary(CHILD_PATH)] },
    });
    // Discovery lists the child, so the ref is not dangling — no panel, no marker.
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Problems" })).not.toBeInTheDocument(),
    );
  });

  it("badges launch with the dangling-ref count, and still lets the run launch", async () => {
    await openParent({
      files: { [PARENT_PATH]: canonical(parentFile(true)) },
      workflows: { workflows: [summary(PARENT_PATH)] },
    });

    fireEvent.click(screen.getByRole("button", { name: /Runs/ }));
    expect(await screen.findByTestId("run-launch-warning-badge")).toHaveTextContent("⚠ 1");
    // Launch is enabled (badged, not blocked) — a clean file whose ref target is merely unsaved.
    expect(screen.getByTestId("run-launch-submit")).not.toBeDisabled();
  });

  it("clears the marker when the child is saved and discovery next lists it", async () => {
    // Id-less parent opens dirty (ids stamped on import), so Save is enabled without a UI edit. The
    // stub reads `options.workflows` fresh per request, so flipping it before the save models the
    // child's first save landing on disk; the save re-fetches discovery and the ref stops being
    // dangling.
    const options: StubServerOptions = {
      files: { [PARENT_PATH]: JSON.stringify(parentFile(false)) },
      workflows: { workflows: [summary(PARENT_PATH)] },
    };
    await openParent(options);
    expect(await screen.findByRole("region", { name: "Problems" })).toBeInTheDocument();

    options.workflows = { workflows: [summary(PARENT_PATH), summary(CHILD_PATH)] };
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Problems" })).not.toBeInTheDocument(),
    );
  });
});

/** A file with one duplicate publish key and one goto of each refused rule. */
function schemaProblemsFile(): WorkflowFile {
  const goto = (id: number, name: string, target: string) =>
    ({ type: "goto", id: uuid(id), name, target, max_jumps: 3 }) as never;
  const leaf = (id: number, name: string, publish?: Record<string, string>) =>
    ({ type: "prompt", id: uuid(id), name, prompt: "x", ...(publish ? { publish } : {}) }) as never;
  return {
    format: FORMAT_VERSION,
    id: uuid(1),
    name: "flow",
    body: [
      {
        type: "parallel",
        id: uuid(2),
        name: "fan",
        join: "collect",
        branches: [leaf(3, "b1", { k: "${output.a}" }), leaf(4, "b2", { k: "${output.a}" })],
      } as never,
      { type: "sequence", id: uuid(5), name: "group", body: [leaf(6, "check")] } as never,
      goto(7, "self", "self"),
      goto(8, "inner", "check"),
      goto(9, "absent", "nowhere"),
      {
        type: "while-do",
        id: uuid(10),
        name: "poll",
        condition: { type: "exists", path: "context.k" },
        node: goto(11, "out", "group"),
      } as never,
    ],
  };
}

async function renderInLocale(locale: Locale, ui: JSX.Element): Promise<void> {
  const messages = await loadMessages(locale);
  render(ui, {
    wrapper: ({ children }) => (
      <IntlProvider locale={locale} messages={messages}>
        {children}
      </IntlProvider>
    ),
  });
}

describe("publish-set and goto problems in each Locale", () => {
  it.each([
    [
      "en",
      [
        'duplicate publish key "k": sibling parallel branches must not publish the same context key',
        'goto "self" targets itself',
        'goto target "check" is not a first-level node',
        'goto target "nowhere" not found in this file',
        'goto "out" may not sit under while-do "poll"',
      ],
    ],
    [
      "de",
      [
        "doppelter publish-Schlüssel „k“: parallele Geschwisterzweige dürfen nicht denselben Kontextschlüssel veröffentlichen",
        "goto „self“ zielt auf sich selbst",
        "goto-Ziel „check“ ist kein Knoten der ersten Ebene",
        "goto-Ziel „nowhere“ in dieser Datei nicht gefunden",
        "goto „out“ darf nicht unter while-do „poll“ stehen",
      ],
    ],
    [
      "zh-CN",
      [
        "publish 键“k”重复：同级并行分支不能发布相同的上下文键",
        "goto“self”的目标是它自己",
        "goto 目标“check”不是第一层节点",
        "在此文件中未找到 goto 目标“nowhere”",
        "goto“out”不能位于 while-do“poll”之下",
      ],
    ],
  ] as const)("%s renders the panel rows and the ⚠ markers", async (locale, texts) => {
    const problems = fileProblems(schemaProblemsFile());
    const marks = problemMarks(problems);
    await renderInLocale(
      locale,
      <ConflictProvider value={marks}>
        <ProblemsPanel problems={problems} />
        {[...marks.keys()].map((id) => (
          <ConflictMarker key={id} id={id} />
        ))}
      </ConflictProvider>,
    );
    const panel = screen.getByRole("region");
    const markerTitles = screen
      .getAllByRole("img", { name: /^Validation error|^Validierungsfehler|^校验错误/ })
      .map((marker) => marker.getAttribute("title") ?? "");
    expect(markerTitles).toHaveLength(problems.length);
    for (const text of texts) {
      expect(within(panel).getByText(text, { exact: false })).toBeInTheDocument();
      expect(markerTitles).toContain(text);
    }
  });
});

describe("ProblemsPanel in en", () => {
  it("counts the warnings and names each row's node and reason", () => {
    render(
      <ProblemsPanel
        problems={[
          {
            nodeId: uuid(2),
            nodeName: "reader",
            kind: "dangling-interpolation",
            message: { key: "designer.problems.danglingInterpolation", params: { key: "gone" } },
          },
          {
            nodeId: uuid(3),
            nodeName: "child",
            kind: "dangling-ref",
            message: {
              key: "designer.problems.danglingRef",
              params: { ref: "child.workflow.json" },
            },
          },
        ]}
      />,
    );
    const panel = screen.getByRole("region", { name: "Problems" });
    expect(within(panel).getByRole("img", { name: "2 warnings" })).toHaveTextContent(
      "⚠ 2 warnings",
    );
    expect(
      within(panel).getByRole("button", {
        name: "Jump to reader: reads `${context.gone}`, which no step in this file publishes",
      }),
    ).toHaveTextContent("context read");
    expect(
      within(panel).getByRole("button", {
        name: "Jump to child: references `child.workflow.json`, which has no saved file yet",
      }),
    ).toHaveTextContent("ref");
  });
});
