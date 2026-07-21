let data = "";
process.stdin.on("data", (chunk) => {
  data += chunk;
});
process.stdin.on("end", () => {
  const { features = "", fixes = "", other = "" } = JSON.parse(data);

  const section = (title, body) => {
    const lines = body
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const items = lines.length ? lines.map((l) => `- ${l}`).join("\n") : "_None_";
    return `### ${title}\n\n${items}\n`;
  };

  const out =
    "# Changelog\n\n## Unreleased\n\n" +
    section("Features", features) +
    "\n" +
    section("Fixes", fixes) +
    "\n" +
    section("Other", other) +
    "\n";

  process.stdout.write(out);
});
