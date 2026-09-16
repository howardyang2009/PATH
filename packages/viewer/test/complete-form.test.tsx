import { PathApiClient, type FetchLike, type JsonValue } from "@path/client-core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CompleteForm } from "../src/complete-form.js";

const SCHEMA: JsonValue = {
  type: "object",
  required: ["approved", "reviewer", "riskLevel"],
  properties: {
    approved: { type: "boolean", title: "Approved" },
    reviewer: { type: "string", title: "Reviewer name" },
    riskLevel: { type: "string", title: "Risk level", enum: ["low", "medium", "high"] },
  },
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A client whose one `fetch` records the last request and returns a canned response. */
function makeClient(handler: (init: RequestInit | undefined) => Response): { client: PathApiClient; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const fetch: FetchLike = async (_url, init) => {
    bodies.push(init?.body ? JSON.parse(init.body as string) : undefined);
    return handler(init);
  };
  return { client: new PathApiClient({ baseUrl: "", fetch }), bodies };
}

describe("CompleteForm", () => {
  it("renders one control per schema property, typed by the schema", () => {
    const { client } = makeClient(() => json({ step_run_id: "s", root_run_id: "r" }, 202));
    render(<CompleteForm client={client} stepRunId="s1" outputSchema={SCHEMA} onCompleted={() => {}} />);

    expect(screen.getByTestId("complete-field-approved").querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(screen.getByTestId("complete-field-reviewer").querySelector('input[type="text"]')).not.toBeNull();
    expect(screen.getByTestId("complete-field-riskLevel").querySelector("select")).not.toBeNull();
  });

  it("blocks submit on a missing required field and never calls the server", () => {
    const { client, bodies } = makeClient(() => json({ step_run_id: "s", root_run_id: "r" }, 202));
    render(<CompleteForm client={client} stepRunId="s1" outputSchema={SCHEMA} onCompleted={() => {}} />);

    fireEvent.click(screen.getByTestId("complete-submit"));

    expect(screen.getByTestId("complete-field-reviewer")).toHaveTextContent(/required/i);
    expect(bodies).toEqual([]);
  });

  it("sends { output } and calls onCompleted on a 202", async () => {
    const onCompleted = vi.fn();
    const { client, bodies } = makeClient(() => json({ step_run_id: "s1", root_run_id: "r1" }, 202));
    render(<CompleteForm client={client} stepRunId="s1" outputSchema={SCHEMA} onCompleted={onCompleted} />);

    fireEvent.click(screen.getByLabelText(/Approved/));
    fireEvent.change(screen.getByTestId("complete-field-reviewer").querySelector("input")!, { target: { value: "Dana" } });
    fireEvent.change(screen.getByTestId("complete-field-riskLevel").querySelector("select")!, { target: { value: "high" } });
    fireEvent.click(screen.getByTestId("complete-submit"));

    await waitFor(() => expect(onCompleted).toHaveBeenCalledOnce());
    expect(bodies[0]).toEqual({ output: { approved: true, reviewer: "Dana", riskLevel: "high" } });
  });

  it("shows the server's field errors verbatim on a 400 and stays for a retry", async () => {
    const onCompleted = vi.fn();
    const details = [
      { instancePath: "/riskLevel", keyword: "enum", message: "must be equal to one of the allowed values" },
    ];
    const { client } = makeClient(() => json({ error: { message: "output does not match the step's outputSchema", details } }, 400));
    render(<CompleteForm client={client} stepRunId="s1" outputSchema={SCHEMA} onCompleted={onCompleted} />);

    // A client-clean submit (all required present) still reaches the server, which rejects it.
    fireEvent.click(screen.getByLabelText(/Approved/));
    fireEvent.change(screen.getByTestId("complete-field-reviewer").querySelector("input")!, { target: { value: "Dana" } });
    fireEvent.change(screen.getByTestId("complete-field-riskLevel").querySelector("select")!, { target: { value: "high" } });
    fireEvent.click(screen.getByTestId("complete-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("complete-field-riskLevel")).toHaveTextContent("must be equal to one of the allowed values"),
    );
    expect(onCompleted).not.toHaveBeenCalled();
    expect(screen.getByTestId("complete-form")).toBeInTheDocument();
  });

  it("shows a form-level error on a 409 (double-submit / not awaiting)", async () => {
    const { client } = makeClient(() => json({ error: { message: `step run "s1" is succeeded, not awaiting` } }, 409));
    render(<CompleteForm client={client} stepRunId="s1" outputSchema={null} onCompleted={() => {}} />);

    fireEvent.click(screen.getByTestId("complete-submit"));

    await waitFor(() => expect(screen.getByTestId("complete-form-error")).toHaveTextContent(/not awaiting/));
  });
});
