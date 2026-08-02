let data = "";
process.stdin.on("data", (chunk) => {
  data += chunk;
});
process.stdin.on("end", () => {
  const { refs = "", issues = [] } = JSON.parse(data);

  const numbers = refs
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map(Number);

  const byNumber = new Map(issues.map((issue) => [issue.number, issue]));

  const cited = [];
  const unresolved = [];
  for (const number of numbers) {
    const issue = byNumber.get(number);
    if (!issue) {
      // The listing is a window (`since` + `per_page`), so a reference older than the window or
      // pointing at another repository simply is not in it. Named, never dropped and never invented.
      unresolved.push(number);
      continue;
    }
    cited.push({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      is_pr: Boolean(issue.pull_request),
      url: issue.html_url,
    });
  }

  process.stdout.write(JSON.stringify({ cited, unresolved }));
});
