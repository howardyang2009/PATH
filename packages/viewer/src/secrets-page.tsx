import type { PathApiClient, WireSecretSummary } from "@path/client-core";
import { type FormEvent, useState } from "react";
import { formatTimestamp } from "./format-time.js";
import { errorMessage } from "./load-state.js";
import { PaneError, PaneLoading } from "./pane-note.js";
import { useResource } from "./use-resource.js";

/**
 * The hosted user's User secrets (ADR 0089): names and when each was set, a write-only form to set
 * one, and a delete with a confirm step. No door returns a value, so the page never holds one after
 * a set lands.
 */
export function SecretsPage({ client }: { client: PathApiClient }) {
  const { load, refetch } = useResource(() => client.listSecrets(), [client]);
  return (
    <section className="secrets" aria-labelledby="secrets-title">
      <h1 className="secrets-title" id="secrets-title">
        Secrets
      </h1>
      <p className="secrets-intro">
        A run you launch reads these through <code>$env</code>. A value cannot be read back.
      </p>
      <SetSecretForm client={client} onSet={refetch} />
      {load.phase === "loading" && <PaneLoading what="secrets" />}
      {load.phase === "error" && <PaneError what="secrets" message={load.message} />}
      {load.phase === "ready" &&
        (load.value.length === 0 ? (
          <p className="pane-note">No secrets yet.</p>
        ) : (
          <ul className="secret-list">
            {load.value.map((secret) => (
              <SecretRow key={secret.name} client={client} secret={secret} onDeleted={refetch} />
            ))}
          </ul>
        ))}
    </section>
  );
}

/** Set or replace one User secret. A refused set keeps both fields, so the user can fix the name. */
function SetSecretForm({ client, onSet }: { client: PathApiClient; onSet: () => void }) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setSending(true);
    client.putSecret(name.trim(), value).then(
      (summary) => {
        setSending(false);
        setName("");
        setValue("");
        setNotice(`Set ${summary.name}.`);
        onSet();
      },
      (thrown: unknown) => {
        setSending(false);
        setError(errorMessage(thrown));
      },
    );
  };

  return (
    <form className="secret-form" onSubmit={submit}>
      <label className="secret-field">
        Name
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="API_KEY"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <label className="secret-field">
        Value
        <input
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          autoComplete="off"
        />
      </label>
      <button
        type="submit"
        className="launch-submit"
        disabled={sending || name.trim() === "" || value === ""}
      >
        Set
      </button>
      <p className="secret-hint">Setting a name that exists replaces its value.</p>
      {error !== null && (
        <p className="pane-note pane-error secret-message" role="alert">
          {error}
        </p>
      )}
      {notice !== null && <p className="pane-note secret-message">{notice}</p>}
    </form>
  );
}

type DeletePhase = "idle" | "confirming" | "sending";

/** One listed User secret, with the two-step delete the runs rail uses. */
function SecretRow({
  client,
  secret,
  onDeleted,
}: {
  client: PathApiClient;
  secret: WireSecretSummary;
  onDeleted: () => void;
}) {
  const [phase, setPhase] = useState<DeletePhase>("idle");
  const [error, setError] = useState<string | null>(null);

  const send = (): void => {
    setError(null);
    setPhase("sending");
    client.deleteSecret(secret.name).then(onDeleted, (thrown: unknown) => {
      setPhase("confirming");
      setError(errorMessage(thrown));
    });
  };

  return (
    <li className="secret-row" data-testid={`secret-row-${secret.name}`}>
      <span className="secret-name">{secret.name}</span>
      <span className="secret-updated">{formatTimestamp(secret.updated_at)}</span>
      {phase === "idle" ? (
        <button type="button" className="delete-arm" onClick={() => setPhase("confirming")}>
          Delete…
        </button>
      ) : (
        <div className="secret-confirm">
          <span className="delete-warning">
            Delete {secret.name}? A run that reads it fails until it is set again.
          </span>
          <button
            type="button"
            className="delete-cancel"
            disabled={phase === "sending"}
            onClick={() => {
              setError(null);
              setPhase("idle");
            }}
          >
            Keep
          </button>
          <button
            type="button"
            className="delete-confirm"
            disabled={phase === "sending"}
            onClick={send}
          >
            {phase === "sending" ? "Deleting…" : "Confirm delete"}
          </button>
        </div>
      )}
      {error !== null && (
        <p className="pane-note pane-error secret-message" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
