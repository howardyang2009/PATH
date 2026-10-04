# Each request sees its own view, and only the creator writes a shared item

**Status:** accepted. Extends [ADR 0084](0084-authored-files-live-in-shipped-shared-and-per-user-folders.md),
[ADR 0085](0085-discovery-lists-only-the-authored-workflow-roots.md) and
[ADR 0087](0087-the-authored-layout-decides-where-a-file-lives-and-who-may-write-it.md).

## Context

Hosted mode signs users in with Clerk, and the user id is the verified `sub`. The access rule was
settled when the website effort was charted: a user reads shipped, shared and own files, never another
user's private files or runs. Anyone adds to shared, and only the creator edits or deletes a shared
item. There is no admin role. Nothing on disk records who created a file, the authored layout takes
one user id at boot, and the loader follows a ref to any path in the project.

## Decision

1. **The requester's view.** Every door works on the union of shipped, shared and the requester's own
   root. The authored layout takes the user id per request. Uniqueness of ids, first root wins
   (ADR 0084 §4) and the template id-index are computed over this view only, never across all users.
   So a shared template can make a user's private copy with the same id list as invalid in that
   user's view only.
2. **Another user's path answers `404`** on every workflow door: read, write, delete, launch, resume
   and complete. The template doors cannot reach it, because the id-index holds only the view.
3. **The Server records the creator.** A host-level table maps a shared item's project path and kind
   to its creator `sub`. The create door stamps the row; an update keeps it; a delete removes it. The
   file carries no creator field, so a client cannot forge one. In local mode the creator is `local`,
   so the same check always passes.
4. **Only the creator writes a shared item.** A write or delete by anyone else answers `403`. A shared
   file with no creator row (placed by hand, or made before this change) is read-only for everyone,
   as a shipped file is. The operator fixes it on disk.
5. **A non-creator runs a shared workflow in place.** A run does not write the file. Discovery and the
   template list carry a Server-decided `read_only` for each row; `action` stays `open`. A client
   offers save-as-copy for a read-only shared row.
6. **In hosted mode, refs stay inside the view.** The tree load refuses a ref outside shipped, shared
   and the launcher's own root, and names the ref. It checks the launcher's view, not the creator's.
   Local mode keeps following refs anywhere in the project (ADR 0085 §3).

## Considered options

- **A `created_by` field in the file.** It changes two schemas, a hand edit or a crafted `PUT` can
  forge it, and a copy carries a stale creator.
- **A creator folder, `shared/<sub>/`.** It breaks "folders only organize" and shows the id in every
  path.
- **Global id uniqueness across all users.** It tells a user that another user's private id exists,
  and every scan walks every user's folder.
- **`403` for another user's path.** It confirms that the file exists.

## Consequences

- Removing an abusive shared item, and moving `local` data to a real user, need their own decision.
- A shared workflow that refs a creator's private file fails to load for every other user. The
  creator must move the target into `shared/` first.
