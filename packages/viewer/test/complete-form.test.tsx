import { type FetchLike, type JsonValue, PathApiClient } from "@path/client-core";
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
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A client whose one `fetch` records the last request and returns a canned response. */
function makeClient(handler: (init: RequestInit | undefined) => Response): {
  client: PathApiClient;
  bodies: unknown[];
} {
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
    render(
      <CompleteForm client={client} stepRunId="s1" outputSchema={SCHEMA} onCompleted={() => {}} />,
    );

    expect(
      screen.getByTestId("complete-field-approved").querySelector('input[type="checkbox"]'),
    ).not.toBeNull();
    expect(
      screen.getByTestId("complete-field-reviewer").querySelector('input[type="text"]'),
    ).not.toBeNull();
    expect(screen.getByTestId("complete-field-riskLevel").querySelector("select")).not.toBeNull();
  });

  it("blocks submit on a missing required field and never calls the server", () => {
    const { client, bodies } = makeClient(() => json({ step_run_id: "s", root_run_id: "r" }, 202));
    render(
      <CompleteForm client={client} stepRunId="s1" outputSchema={SCHEMA} onCompleted={() => {}} />,
    );

    fireEvent.click(screen.getByTestId("complete-submit"));

    expect(screen.getByTestId("complete-field-reviewer")).toHaveTextContent(/required/i);
    expect(bodies).toEqual([]);
  });

  it("sends { output } and calls onCompleted on a 202", async () => {
    const onCompleted = vi.fn();
    const { client, bodies } = makeClient(() =>
      json({ step_run_id: "s1", root_run_id: "r1" }, 202),
    );
    render(
      <CompleteForm
        client={client}
        stepRunId="s1"
        outputSchema={SCHEMA}
        onCompleted={onCompleted}
      />,
    );

    fireEvent.click(screen.getByLabelText(/Approved/));
    fireEvent.change(screen.getByTestId("complete-field-reviewer").querySelector("input")!, {
      target: { value: "Dana" },
    });
    fireEvent.change(screen.getByTestId("complete-field-riskLevel").querySelector("select")!, {
      target: { value: "high" },
    });
    fireEvent.click(screen.getByTestId("complete-submit"));

    await waitFor(() => expect(onCompleted).toHaveBeenCalledOnce());
    expect(bodies[0]).toEqual({ output: { approved: true, reviewer: "Dana", riskLevel: "high" } });
  });

  it("shows the server's field errors verbatim on a 400 and stays for a retry", async () => {
    const onCompleted = vi.fn();
    const details = [
      {
        instancePath: "/riskLevel",
        keyword: "enum",
        message: "must be equal to one of the allowed values",
      },
    ];
    const { client } = makeClient(() =>
      json({ error: { message: "output does not match the step's outputSchema", details } }, 400),
    );
    render(
      <CompleteForm
        client={client}
        stepRunId="s1"
        outputSchema={SCHEMA}
        onCompleted={onCompleted}
      />,
    );

    // A client-clean submit (all required present) still reaches the server, which rejects it.
    fireEvent.click(screen.getByLabelText(/Approved/));
    fireEvent.change(screen.getByTestId("complete-field-reviewer").querySelector("input")!, {
      target: { value: "Dana" },
    });
    fireEvent.change(screen.getByTestId("complete-field-riskLevel").querySelector("select")!, {
      target: { value: "high" },
    });
    fireEvent.click(screen.getByTestId("complete-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("complete-field-riskLevel")).toHaveTextContent(
        "must be equal to one of the allowed values",
      ),
    );
    expect(onCompleted).not.toHaveBeenCalled();
    expect(screen.getByTestId("complete-form")).toBeInTheDocument();
  });

  it("shows a form-level error on a 409 (double-submit / not awaiting)", async () => {
    const { client } = makeClient(() =>
      json({ error: { message: `step run "s1" is succeeded, not awaiting` } }, 409),
    );
    render(
      <CompleteForm client={client} stepRunId="s1" outputSchema={null} onCompleted={() => {}} />,
    );

    fireEvent.click(screen.getByTestId("complete-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("complete-form-error")).toHaveTextContent(/not awaiting/),
    );
  });

  it("draws a free-text output control when the node has no outputSchema", () => {
    const { client } = makeClient(() => json({ step_run_id: "s", root_run_id: "r" }, 202));
    render(
      <CompleteForm client={client} stepRunId="s1" outputSchema={null} onCompleted={() => {}} />,
    );

    expect(screen.getByTestId("complete-raw-output")).not.toBeNull();
  });

  it("sends parsed JSON as the output when the raw text is JSON", async () => {
    const onCompleted = vi.fn();
    const { client, bodies } = makeClient(() =>
      json({ step_run_id: "s1", root_run_id: "r1" }, 202),
    );
    render(
      <CompleteForm client={client} stepRunId="s1" outputSchema={null} onCompleted={onCompleted} />,
    );

    fireEvent.change(screen.getByTestId("complete-raw-output"), {
      target: { value: '{ "confirmed": true }' },
    });
    fireEvent.click(screen.getByTestId("complete-submit"));

    await waitFor(() => expect(onCompleted).toHaveBeenCalledOnce());
    expect(bodies[0]).toEqual({ output: { confirmed: true } });
  });

  it("sends plain text as a JSON string, never rejecting non-JSON", async () => {
    const onCompleted = vi.fn();
    const { client, bodies } = makeClient(() =>
      json({ step_run_id: "s1", root_run_id: "r1" }, 202),
    );
    render(
      <CompleteForm client={client} stepRunId="s1" outputSchema={null} onCompleted={onCompleted} />,
    );

    fireEvent.change(screen.getByTestId("complete-raw-output"), {
      target: { value: "ship it please" },
    });
    fireEvent.click(screen.getByTestId("complete-submit"));

    await waitFor(() => expect(onCompleted).toHaveBeenCalledOnce());
    expect(bodies[0]).toEqual({ output: "ship it please" });
  });

  it("submits an empty output when the raw control is left blank", async () => {
    const onCompleted = vi.fn();
    const { client, bodies } = makeClient(() =>
      json({ step_run_id: "s1", root_run_id: "r1" }, 202),
    );
    render(
      <CompleteForm client={client} stepRunId="s1" outputSchema={null} onCompleted={onCompleted} />,
    );

    fireEvent.click(screen.getByTestId("complete-submit"));

    await waitFor(() => expect(onCompleted).toHaveBeenCalledOnce());
    expect(bodies[0]).toEqual({ output: {} });
  });

  it("prefills a launch-secret config skeleton and sends the re-entered values (ADR 0046)", async () => {
    const onCompleted = vi.fn();
    const { client, bodies } = makeClient(() =>
      json({ step_run_id: "s1", root_run_id: "r1" }, 202),
    );
    render(
      <CompleteForm
        client={client}
        stepRunId="s1"
        outputSchema={null}
        launchSecretKeys={["github.token"]}
        onCompleted={onCompleted}
      />,
    );

    // A dot-path nests: the operator fills values in the shape the engine's config lookup reads.
    const field = screen.getByTestId("complete-config") as HTMLTextAreaElement;
    expect(JSON.parse(field.value)).toEqual({ github: { token: "" } });
    expect(screen.getByTestId("complete-config-note")).toHaveTextContent(/masked/i);

    fireEvent.change(field, { target: { value: '{"github":{"token":"sk-live"}}' } });
    fireEvent.change(screen.getByTestId("complete-raw-output"), {
      target: { value: '{"approved":true}' },
    });
    fireEvent.click(screen.getByTestId("complete-submit"));

    await waitFor(() => expect(onCompleted).toHaveBeenCalledOnce());
    expect(bodies[0]).toEqual({
      output: { approved: true },
      config: { github: { token: "sk-live" } },
    });
  });

  it("draws no launch-secret config field when the launch recorded none", () => {
    const { client } = makeClient(() => json({ step_run_id: "s", root_run_id: "r" }, 202));
    render(
      <CompleteForm client={client} stepRunId="s1" outputSchema={null} onCompleted={() => {}} />,
    );

    expect(screen.queryByTestId("complete-config")).toBeNull();
  });

  it("blocks submit on an unparseable launch-secret config, spending no request", () => {
    const { client, bodies } = makeClient(() => json({ step_run_id: "s", root_run_id: "r" }, 202));
    render(
      <CompleteForm
        client={client}
        stepRunId="s1"
        outputSchema={null}
        launchSecretKeys={["token"]}
        onCompleted={() => {}}
      />,
    );

    fireEvent.change(screen.getByTestId("complete-config"), { target: { value: "{not json" } });
    fireEvent.click(screen.getByTestId("complete-submit"));

    expect(screen.getByTestId("complete-form-error")).toBeInTheDocument();
    expect(bodies).toEqual([]);
  });

  it("disables submit and names the blank launch secret while one is unsupplied", () => {
    const { client, bodies } = makeClient(() => json({ step_run_id: "s", root_run_id: "r" }, 202));
    render(
      <CompleteForm
        client={client}
        stepRunId="s1"
        outputSchema={null}
        launchSecretKeys={["github.token"]}
        onCompleted={() => {}}
      />,
    );

    expect(screen.getByTestId("complete-submit")).toBeDisabled();
    expect(screen.getByTestId("complete-secret-error")).toHaveTextContent('"github.token"');

    fireEvent.click(screen.getByTestId("complete-submit"));

    expect(bodies).toEqual([]);
  });

  it("treats a whitespace-only launch secret as blank", () => {
    const { client, bodies } = makeClient(() => json({ step_run_id: "s", root_run_id: "r" }, 202));
    render(
      <CompleteForm
        client={client}
        stepRunId="s1"
        outputSchema={null}
        launchSecretKeys={["token"]}
        onCompleted={() => {}}
      />,
    );

    fireEvent.change(screen.getByTestId("complete-config"), {
      target: { value: '{"token":"   "}' },
    });

    expect(screen.getByTestId("complete-submit")).toBeDisabled();
    expect(screen.getByTestId("complete-secret-error")).toHaveTextContent('"token"');
    expect(bodies).toEqual([]);
  });

  it("enables submit once every launch secret has a non-blank value", async () => {
    const onCompleted = vi.fn();
    const { client, bodies } = makeClient(() =>
      json({ step_run_id: "s1", root_run_id: "r1" }, 202),
    );
    render(
      <CompleteForm
        client={client}
        stepRunId="s1"
        outputSchema={null}
        launchSecretKeys={["token"]}
        onCompleted={onCompleted}
      />,
    );

    fireEvent.change(screen.getByTestId("complete-config"), {
      target: { value: '{"token":"sk-live"}' },
    });

    expect(screen.queryByTestId("complete-secret-error")).toBeNull();
    expect(screen.getByTestId("complete-submit")).not.toBeDisabled();
    fireEvent.click(screen.getByTestId("complete-submit"));

    await waitFor(() => expect(onCompleted).toHaveBeenCalledOnce());
    expect(bodies[0]).toEqual({ output: {}, config: { token: "sk-live" } });
  });
});
