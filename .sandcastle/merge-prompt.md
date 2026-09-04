# TASK

Merge the following branches into the current branch:

{{BRANCHES}}

For each branch:

1. Run `git merge <branch> --no-edit`
2. If there are merge conflicts, resolve them intelligently by reading both sides and choosing the correct resolution
3. After resolving conflicts, verify the merge in a scratch copy:

   ```
   rm -rf /tmp/verify && mkdir -p /tmp/verify && git archive HEAD | tar -x -C /tmp/verify && cd /tmp/verify && pnpm install && pnpm typecheck && pnpm test; cd /home/agent/workspace
   ```

4. If tests fail, fix the issues in the workspace (then re-verify through the scratch copy) before proceeding to the next branch

# IMPORTANT CONSTRAINT

The workspace is bind-mounted from the host and its `node_modules` belongs to the host platform (macOS). NEVER run `pnpm install`, `pnpm test`, or anything that reads or writes `node_modules` directly in `/home/agent/workspace` — always use the `/tmp/verify` scratch copy for installs, typechecks, and tests.

After all branches are merged, make a single commit summarizing the merge.

# CLOSE ISSUES

For each branch that was merged, close its issue using the following command:

`gh issue close <ID> --comment "Completed by Sandcastle"`

Here are all the issues:

{{ISSUES}}

Once you've merged everything you can, output <promise>COMPLETE</promise>.
