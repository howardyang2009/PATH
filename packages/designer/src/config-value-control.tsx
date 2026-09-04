import { isEnvWrapper, isSecretWrapper, type ConfigValue, type EnvWrapper } from "@path/schema";
import {
  configModeOf,
  isEditableScalar,
  referenceLabel,
  renderConfigValue,
  setConfigMode,
  setSecretSource,
  type ConfigMode,
} from "./config-value.js";

/**
 * The properties pane's **UI adapter** over the config-value algebra (#370, designer-spec § `$env` /
 * `$secret` authoring, map decision 9). `config-value.ts` owns the value-shape reads and the mode
 * transitions; this module renders the controls that drive them — the mode selector and the three
 * mode-specific sub-controls — so the algebra has a real adapter it can be tested against, and the pane
 * calls one control rather than carrying the whole tree inline.
 */

/** The props the config-value control and its three mode sub-controls share (§ `$env` / `$secret` authoring). */
interface ConfigControlProps {
  value: ConfigValue;
  onChange: (v: ConfigValue) => void;
  label: string;
}

/**
 * A typed control for a config value with its `Literal` / `$env` / `$secret` mode selector (map decision 9).
 * The composed `{"$secret": {"$env": …}}` is expressible through the `$secret` source sub-selector. A nested
 * array/object that is not a wrapper stays read-only — that authoring is out of this affordance's scope.
 */
export function ConfigValueControl({ value, onChange, label }: ConfigControlProps): JSX.Element {
  if (!isEditableScalar(value) && referenceLabel(value) === null) {
    return <code className="pane-config-value">{renderConfigValue(value)}</code>;
  }
  const mode = configModeOf(value);
  const setMode = (next: ConfigMode): void => {
    if (next === mode) return;
    onChange(setConfigMode(value, next));
  };
  return (
    <div className="pane-config-control">
      <select
        className="pane-input pane-config-mode"
        aria-label={`${label} mode`}
        value={mode}
        onChange={(e) => setMode(e.target.value as ConfigMode)}
      >
        <option value="literal">Literal</option>
        <option value="env">$env</option>
        <option value="secret">$secret</option>
      </select>
      {mode === "literal" ? <LiteralControl value={value} onChange={onChange} label={label} /> : null}
      {mode === "env" ? <EnvControl value={value} onChange={onChange} label={label} /> : null}
      {mode === "secret" ? <SecretControl value={value} onChange={onChange} label={label} /> : null}
    </div>
  );
}

/** The literal-mode control: a typed input matching the scalar's own type (boolean / number / string). */
function LiteralControl({ value, onChange, label }: ConfigControlProps): JSX.Element {
  if (typeof value === "boolean") {
    return <input type="checkbox" aria-label={label} checked={value} onChange={(e) => onChange(e.target.checked)} />;
  }
  if (typeof value === "number") {
    return <input className="pane-input" type="number" aria-label={label} value={value} onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))} />;
  }
  return <input className="pane-input" type="text" aria-label={label} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />;
}

/** The `$env`-mode control: an env-var-name input plus the reference-only chip (`$env · NAME`). */
function EnvControl({ value, onChange, label }: ConfigControlProps): JSX.Element {
  const name = isEnvWrapper(value) ? value.$env : "";
  return (
    <div className="pane-ref-control">
      <input
        className="pane-input"
        type="text"
        aria-label={`${label} $env variable`}
        placeholder="ENV_VAR_NAME"
        value={name}
        onChange={(e) => onChange({ $env: e.target.value })}
      />
      <code className="pane-ref-token" data-ref="env">
        {referenceLabel({ $env: name })}
      </code>
    </div>
  );
}

/**
 * The `$secret`-mode control: a source sub-selector (a literal secret, or one sourced from `$env`) and the
 * matching input, plus the masked, named token. A literal secret edits through a password field so the
 * pane never renders the value; the composed `{"$secret": {"$env": …}}` is the env-sourced source.
 */
function SecretControl({ value, onChange, label }: ConfigControlProps): JSX.Element {
  const inner: string | EnvWrapper = isSecretWrapper(value) ? value.$secret : "";
  const setSource = (source: "literal" | "env"): void => onChange(setSecretSource(value, source));
  return (
    <div className="pane-ref-control">
      <select
        className="pane-input pane-secret-source"
        aria-label={`${label} $secret source`}
        value={isEnvWrapper(inner) ? "env" : "literal"}
        onChange={(e) => setSource(e.target.value as "literal" | "env")}
      >
        <option value="literal">Literal secret</option>
        <option value="env">From $env</option>
      </select>
      {isEnvWrapper(inner) ? (
        <input
          className="pane-input"
          type="text"
          aria-label={`${label} $secret $env variable`}
          placeholder="ENV_VAR_NAME"
          value={inner.$env}
          onChange={(e) => onChange({ $secret: { $env: e.target.value } })}
        />
      ) : (
        <input
          className="pane-input"
          type="password"
          aria-label={`${label} $secret value`}
          placeholder="secret"
          value={inner}
          onChange={(e) => onChange({ $secret: e.target.value })}
        />
      )}
      <code className="pane-ref-token" data-ref="secret">
        {referenceLabel({ $secret: inner })}
      </code>
    </div>
  );
}
