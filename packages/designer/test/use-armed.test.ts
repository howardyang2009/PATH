import type { GetTemplateResponse, PathApiClient, TemplateSummary } from "@path/client-core";
import { verbatim } from "@path/i18n";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useArmed } from "../src/use-armed.js";

const template = { id: "t1", name: "fetch" } as TemplateSummary;

function armWith(getTemplate: () => Promise<GetTemplateResponse>) {
  const client = { getTemplate } as unknown as PathApiClient;
  const { result } = renderHook(() => useArmed(client));
  act(() => result.current.armTemplate(template));
  return result;
}

describe("useArmed", () => {
  it("names an invalid template and the Server's reason", async () => {
    const result = armWith(
      async () =>
        ({
          valid: false,
          kind: "step",
          error: { message: 'unregistered step type "api-call"' },
        }) as unknown as GetTemplateResponse,
    );
    await waitFor(() =>
      expect(result.current.templateError).toEqual({
        key: "designer.useArmed.insertFailed",
        params: { name: "fetch", error: verbatim('unregistered step type "api-call"') },
      }),
    );
  });

  it("falls back to its own words when an invalid template carries no reason", async () => {
    const result = armWith(async () => ({ valid: false, kind: "step" }) as GetTemplateResponse);
    await waitFor(() =>
      expect(result.current.templateError).toEqual({
        key: "designer.useArmed.insertFailed",
        params: { name: "fetch", error: { key: "designer.useArmed.invalidTemplate" } },
      }),
    );
  });

  it("names a template whose read failed", async () => {
    const result = armWith(async () => {
      throw new Error("offline");
    });
    await waitFor(() =>
      expect(result.current.templateError).toEqual({
        key: "designer.useArmed.readFailed",
        params: { name: "fetch", error: verbatim("offline") },
      }),
    );
  });
});
