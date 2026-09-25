import type { TemplateSummary } from "@path/client-core";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { stubClient } from "./stub-server.js";

/**
 * #577: the palette lists templates. A `Templates` tab beside `Build` (variant C of #564) holds a
 * Template category (the only kind, ADR 0063), populated from `GET /v0/templates` — shipped and user
 * rows alike. An invalid row is listed with its error and cannot be selected.
 */

function template(overrides: Partial<TemplateSummary> & Pick<TemplateSummary, "name" | "kind">): TemplateSummary {
  return {
    id: `${overrides.name}-id`,
    description: `${overrides.name} blurb`,
    origin: "user",
    read_only: false,
    valid: true,
    error: null,
    ...overrides,
  };
}

const TEMPLATES: TemplateSummary[] = [
  template({ name: "person-switch", kind: "step", origin: "shipped", read_only: true, description: "A person picks the next node" }),
  template({ name: "review-gate", kind: "step" }),
  template({ name: "nightly", kind: "step" }),
  template({
    name: "broken-flow",
    kind: "step",
    valid: false,
    error: { message: 'unregistered step type "api-call"' },
  }),
];

async function openTemplatesTab(): Promise<HTMLElement> {
  const palette = screen.getByRole("region", { name: "Palette" });
  fireEvent.click(within(palette).getByRole("tab", { name: "Templates" }));
  return within(palette).getByRole("tabpanel", { name: "Templates" });
}

describe("Designer palette lists templates (#577)", () => {
  it("keeps Step and Controller on the Build tab, selected by default", async () => {
    render(<App client={stubClient({ templates: { templates: TEMPLATES } })} />);
    const palette = screen.getByRole("region", { name: "Palette" });
    expect(within(palette).getByRole("tab", { name: "Build" })).toHaveAttribute("aria-selected", "true");
    const build = within(palette).getByRole("tabpanel", { name: "Build" });
    expect(within(build).getByRole("region", { name: "Step" })).toBeInTheDocument();
    expect(within(build).getByRole("region", { name: "Controller" })).toBeInTheDocument();
    expect(within(palette).queryByRole("region", { name: "Templates" })).not.toBeInTheDocument();
  });

  it("lists shipped and user templates under Templates, with no Workflow-Template category", async () => {
    render(<App client={stubClient({ templates: { templates: TEMPLATES } })} />);
    const panel = await openTemplatesTab();

    const stepTemplates = await within(panel).findByRole("region", { name: "Templates" });
    expect(within(stepTemplates).getByText("person-switch")).toBeInTheDocument();
    expect(within(stepTemplates).getByText("A person picks the next node")).toBeInTheDocument();
    expect(within(stepTemplates).getByText("review-gate")).toBeInTheDocument();
    expect(within(stepTemplates).getByText("nightly")).toBeInTheDocument();
    expect(within(stepTemplates).getByText("broken-flow")).toBeInTheDocument();
    expect(within(panel).queryByRole("region", { name: "Workflow-Template" })).not.toBeInTheDocument();

    // The shipped row says so, the user row does not.
    const shipped = within(stepTemplates).getByRole("button", { name: /person-switch/ });
    expect(within(shipped).getByText("shipped")).toBeInTheDocument();
    const user = within(stepTemplates).getByRole("button", { name: /review-gate/ });
    expect(within(user).queryByText("shipped")).not.toBeInTheDocument();
  });

  it("surfaces an invalid template with its error and makes it unselectable", async () => {
    render(<App client={stubClient({ templates: { templates: TEMPLATES } })} />);
    const panel = await openTemplatesTab();

    const broken = await within(panel).findByRole("button", { name: /^broken-flow/ });
    expect(broken).toHaveAttribute("aria-disabled", "true");
    expect(within(broken).getByText('unregistered step type "api-call"')).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: /^nightly/ })).toHaveAttribute("aria-disabled", "false");
  });

  it("says so when there are no templates", async () => {
    render(<App client={stubClient({ templates: { templates: [] } })} />);
    const panel = await openTemplatesTab();

    const stepTemplates = await within(panel).findByRole("region", { name: "Templates" });
    expect(within(stepTemplates).getByText("No templates")).toBeInTheDocument();
  });

  it("reports a failed template scan instead of an empty list", async () => {
    render(<App client={stubClient({ templates: { error: { message: "scan failed" } }, templatesStatus: 500 })} />);
    const panel = await openTemplatesTab();

    expect(await within(panel).findByRole("alert")).toHaveTextContent("scan failed");
  });
});
