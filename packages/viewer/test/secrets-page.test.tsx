import { type FetchLike, PathApiClient } from "@path/client-core";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { formatTimestamp } from "../src/format-time.js";
import { SecretsPage } from "../src/secrets-page.js";

const AT = "2026-10-06T10:00:00.000Z";

function reply(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** An in-memory `/v0/secrets` with the Server's reserved-name refusal; it records each PUT body. */
function secretsServer(names: string[] = []) {
  const secrets = new Map(names.map((name) => [name, AT]));
  const putBodies: string[] = [];
  const deleted: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    const name = decodeURIComponent(url.split("/v0/secrets/")[1] ?? "");
    if (init?.method === "PUT") {
      putBodies.push(String(init.body));
      if (name === "PATH") return reply({ error: { message: `"PATH" is a reserved name` } }, 400);
      secrets.set(name, AT);
      return reply({ name, updated_at: AT });
    }
    if (init?.method === "DELETE") {
      deleted.push(name);
      secrets.delete(name);
      return reply(null, 204);
    }
    const list = [...secrets].map(([n, updated_at]) => ({ name: n, updated_at }));
    return reply({ secrets: list });
  };
  return { client: new PathApiClient({ baseUrl: "", fetch }), putBodies, deleted };
}

function setSecret(name: string, value: string): void {
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: name } });
  fireEvent.change(screen.getByLabelText("Value"), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));
}

describe("SecretsPage", () => {
  it("lists each User secret's name and when it was set", async () => {
    const server = secretsServer(["API_KEY", "DEEPSEEK_API_KEY"]);
    render(<SecretsPage client={server.client} />);

    const row = await screen.findByTestId("secret-row-API_KEY");
    expect(row).toHaveTextContent("API_KEY");
    expect(row).toHaveTextContent(formatTimestamp(AT));
    expect(screen.getByTestId("secret-row-DEEPSEEK_API_KEY")).toBeInTheDocument();
  });

  it("says so when no User secret is set", async () => {
    render(<SecretsPage client={secretsServer().client} />);
    expect(await screen.findByText("No secrets yet.")).toBeInTheDocument();
  });

  it("sets a value through a write-only input and never shows it", async () => {
    const server = secretsServer();
    const { container } = render(<SecretsPage client={server.client} />);
    await screen.findByText("No secrets yet.");

    expect(screen.getByLabelText("Value")).toHaveAttribute("type", "password");
    setSecret("API_KEY", "sk-very-secret");

    expect(await screen.findByTestId("secret-row-API_KEY")).toBeInTheDocument();
    expect(JSON.parse(server.putBodies[0] ?? "")).toEqual({ value: "sk-very-secret" });
    expect(screen.getByLabelText("Value")).toHaveValue("");
    expect(container.innerHTML).not.toContain("sk-very-secret");
  });

  it("shows the Server's message when a limit refuses the value, and keeps the form", async () => {
    const server = secretsServer();
    render(<SecretsPage client={server.client} />);
    await screen.findByText("No secrets yet.");

    setSecret("PATH", "x");

    expect(await screen.findByRole("alert")).toHaveTextContent(`"PATH" is a reserved name`);
    expect(screen.getByLabelText("Name")).toHaveValue("PATH");
  });

  it("deletes only after a confirm", async () => {
    const server = secretsServer(["API_KEY"]);
    render(<SecretsPage client={server.client} />);
    const row = await screen.findByTestId("secret-row-API_KEY");

    fireEvent.click(within(row).getByRole("button", { name: "Delete…" }));
    expect(server.deleted).toEqual([]);
    fireEvent.click(within(row).getByRole("button", { name: "Keep" }));
    expect(within(row).queryByRole("button", { name: "Confirm delete" })).toBeNull();

    fireEvent.click(within(row).getByRole("button", { name: "Delete…" }));
    fireEvent.click(within(row).getByRole("button", { name: "Confirm delete" }));

    await waitFor(() => expect(screen.queryByTestId("secret-row-API_KEY")).toBeNull());
    expect(server.deleted).toEqual(["API_KEY"]);
  });
});
