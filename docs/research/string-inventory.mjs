// Inventory user-visible strings in PATH packages. Usage: node inventory.mjs <repo>
import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const repo = process.argv[2];
const require = createRequire(join(repo, "package.json"));
const { parse } = require(join(repo, "node_modules/.pnpm/@babel+parser@7.29.9/node_modules/@babel/parser"));

const PKGS = ["viewer", "designer", "client-core", "server", "engine", "schema"];
const ATTRS = new Set(["aria-label", "title", "placeholder", "alt", "label", "aria-description", "description", "emptyText", "confirmLabel", "cancelLabel", "heading", "hint"]);

function files(dir) {
  const out = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) {
      if (n === "acceptance" || n === "__tests__" || n === "fixtures") continue;
      out.push(...files(p));
    } else if (/\.(ts|tsx)$/.test(n) && !/\.test\.|\.spec\.|\.d\.ts$/.test(n)) out.push(p);
  }
  return out;
}

// Prose: starts with a letter, has a space-separated word pair, not a CSS class list, path or key.
function prose(s) {
  const t = s.trim();
  if (t.length < 3 || !/[A-Za-z]/.test(t)) return false;
  if (/^[a-z0-9_\-./:@#$%*]+$/.test(t)) return false;
  if (/^(https?:|\/|\.\/|#|--|[a-z-]+:)/.test(t)) return false;
  if (/^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)*$/.test(t) && !/\b(the|a|is|to|of|no|not|and|or|in|on|for|with|this)\b/.test(t)) return false;
  return /^[A-Z`'"(…]/.test(t) || /\b(the|a|is|to|of|no|not|and|or|in|on|for|with|this|cannot|must)\b/.test(t);
}

function tplText(node) {
  return node.quasis.map((q) => q.value.cooked).join("{x}");
}

function walk(node, parent, key, visit) {
  if (!node || typeof node.type !== "string") return;
  Object.defineProperty(node, "__parent", { value: parent, enumerable: false });
  visit(node, parent, key);
  for (const k of Object.keys(node)) {
    if (k === "loc" || k === "start" || k === "end" || k === "leadingComments" || k === "trailingComments") continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => walk(c, node, k, visit));
    else if (v && typeof v.type === "string") walk(v, node, k, visit);
  }
}

const rows = [];
for (const pkg of PKGS) {
  for (const f of files(join(repo, "packages", pkg, "src"))) {
    const src = readFileSync(f, "utf8");
    let ast;
    try {
      ast = parse(src, { sourceType: "module", plugins: ["typescript", ...(f.endsWith(".tsx") ? ["jsx"] : [])] });
    } catch (e) {
      console.error("parse fail", f, e.message);
      continue;
    }
    const rel = relative(repo, f);
    const seen = new Set();
    const add = (node, kind, text, flags = {}) => {
      if (seen.has(node.start)) return;
      seen.add(node.start);
      rows.push({ pkg, file: rel, line: node.loc.start.line, kind, text: text.replace(/\s+/g, " ").trim(), ...flags });
    };
    walk(ast.program, null, null, (node, parent, key) => {
      if (node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration") return;
      if (node.type === "JSXText") {
        const t = node.value.replace(/\s+/g, " ").trim();
        if (/[A-Za-z]{2}/.test(t)) add(node, "jsx-text", t);
        return;
      }
      if (node.type === "JSXAttribute" && node.value) {
        const name = typeof node.name.name === "string" ? node.name.name : node.name.name.name;
        if (!ATTRS.has(name)) return;
        let v = node.value;
        if (v.type === "JSXExpressionContainer") v = v.expression;
        if (v.type === "StringLiteral" && /[A-Za-z]{2}/.test(v.value)) add(v, "jsx-attr", `${name}="${v.value}"`);
        if (v.type === "TemplateLiteral") add(v, "jsx-attr", `${name}=\`${tplText(v)}\``, { interp: v.expressions.length > 0 });
        return;
      }
      const inError = (n) => {
        for (let p = n; p; p = p.__parent) if (p.type === "NewExpression" && /Error$/.test(p.callee?.name ?? "")) return true;
        return false;
      };
      if (node.type === "StringLiteral" || node.type === "TemplateLiteral") {
        if (parent && (parent.type === "TSLiteralType" || (parent.type === "ObjectProperty" && key === "key") || parent.type === "TSEnumMember")) return;
        if (parent?.type === "JSXAttribute") return;
        if (parent?.type === "CallExpression" && /^(querySelector|getElementById|addEventListener|startsWith|endsWith|includes|split|join|replace|get|set|has|fetch|matchMedia|createElement|setAttribute|getAttribute|removeAttribute)$/.test(parent.callee?.property?.name ?? parent.callee?.name ?? "")) return;
        const text = node.type === "StringLiteral" ? node.value : tplText(node);
        if (!prose(text) || !/ /.test(text.trim()) || /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|PRAGMA|WITH|BEGIN)\b/i.test(text)) return;
        let kind = "built";
        for (let p = parent; p; p = p.__parent) {
          if (p.type === "NewExpression" && /Error$/.test(p.callee?.name ?? "")) { kind = "thrown"; break; }
          if (p.type === "CallExpression") {
            const c = p.callee;
            const name = c?.name ?? c?.property?.name ?? "";
            const obj = c?.object?.name ?? c?.object?.property?.name ?? "";
            if (/^(replyError|sendError)$/.test(name)) { kind = "api-error"; break; }
            if (obj === "console" || /^(stderr|stdout)$/.test(obj) || /^(log|warn|info|debug)$/.test(name)) { kind = "log"; break; }
          }
        }
        if (/\/(bin|cli)\//.test(rel) || /(^|\/)(launch|cli[a-z-]*)\.ts$/.test(rel)) kind = kind === "built" ? "log" : kind;
        add(node, kind, text, { interp: node.type === "TemplateLiteral" && node.expressions.length > 0 });
      }
      if (node.type === "ConditionalExpression") {
        const t = node.test;
        const isOne = t.type === "BinaryExpression" && /^[!=]==?$/.test(t.operator) && (t.right?.value === 1 || t.left?.value === 1);
        const strs = [node.consequent, node.alternate].every((b) => b.type === "StringLiteral" || b.type === "TemplateLiteral");
        if (isOne && strs) add(node, "plural", src.slice(node.start, node.end), {});
      }
    });
  }
}

// Errors also include strings passed as the first argument of an *Error class factory such as fail("...").
const byPkg = {};
for (const r of rows) {
  const k = `${r.pkg}|${r.kind}`;
  byPkg[k] ??= { n: 0, interp: 0, ex: r.text };
  byPkg[k].n++;
  if (r.interp) byPkg[k].interp++;
}
writeFileSync(process.argv[3], JSON.stringify(rows, null, 1));
for (const [k, v] of Object.entries(byPkg).sort()) console.log(k, v.n, "interp", v.interp, "|", v.ex.slice(0, 70));
console.log("total", rows.length);
