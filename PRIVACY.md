# Privacy Policy

**Effective date: August 5, 2026**

This policy describes how the NeatContext host plugins for Claude Code,
GitHub Copilot, Kimi Code, Codex, and pi ("the plugins"), published by XT
SOFTWARE LABS LLC, handle information. It applies only to the open-source
plugins in this repository. Coding hosts and their model providers have their
own terms and privacy practices.

## Summary

- The plugins do not send telemetry, analytics, crash reports, or advertising
  data to XT SOFTWARE LABS LLC.
- The plugins do not require an XT SOFTWARE LABS LLC account or use an XT
  SOFTWARE LABS LLC-operated cloud service.
- Contexts and operational state are stored on your computer.
- Context content is provided to the active coding host when you invoke plugin
  features or connect a context, so it is handled according to that host's and
  model provider's terms, privacy policy, and settings.
- There is no NeatContext Desktop connection right now.

## Information the plugins handle

The plugins handle information only when needed to provide their features:

- **Context content:** profiles, routing descriptions, Markdown knowledge,
  names, and portable manifests that you create, save, or import.
- **Conversation captures:** selected information from the active conversation
  when you explicitly invoke the save workflow. The active model creates a
  focused capture rather than storing the entire transcript. In Claude Code,
  the workflow can create temporary, bounded evidence projections from the
  current host transcript. The reader drops system records, thinking blocks,
  raw shell commands, edit and file bodies, internal task-list operations, and
  routine successful read/search results; it also applies best-effort redaction
  to common secret patterns. The plugin does not create a compiled transcript
  file, index, or cache. Claude Code may retain the projection as ordinary tool
  output under its own settings.
- **Linked files:** paths and readable content from knowledge folders you
  explicitly connect to a context.
- **Operational state:** context identifiers and names, the selected context
  for a coding-host session, routing mode, routing descriptions, aliases,
  recent routing decisions or refusals, timestamps, and host session
  identifiers. For Claude Code, this also includes the current transcript path
  supplied by the host, retained as opaque session metadata so an explicit save
  can open that exact transcript without searching user directories.

Earlier versions of the Claude Code plugin kept save-nudge counters derived
from the host transcript. That feature has been removed. Saving happens only
when the user explicitly invokes save, and old counters are discarded when the
session state is next written.

The plugins do not intentionally collect account credentials, payment
information, advertising identifiers, or precise location information.

## Local storage

By default, the plugins store or read data in these locations:

- `~/.neatcontext/contexts/` for context profiles, manifests, managed
  knowledge, and conversation additions saved into contexts that link external
  knowledge folders. Earlier schema data under `~/.neatcontext/lite/` is read
  for compatible local migration.
- `~/.neatcontext/plugin-selection.json` and
  `~/.neatcontext/plugin-sessions/` for context selections.
- `~/.neatcontext/plugin-routing.json` for routing metadata and a bounded
  history of recent routing decisions. In Claude Code this file also holds the
  host-provided transcript path for a bounded set of recent sessions; it does
  not hold transcript message content.
- `.neatcontext-capture-*.json` in the active project as a temporary save
  scratch file.

`NEATCONTEXT_HOME` can place the NeatContext storage directory somewhere else.

Temporary conversation-capture files are removed after a successful create or
confirmed update. A file may remain after a preview, validation error, or other
failure so the capture can be repaired; you can delete it manually at any time.

## Network communication and disclosure

The plugins have no telemetry endpoint and do not transmit information to an
XT SOFTWARE LABS LLC-operated server. The following communications can occur:

1. **Your coding host and model provider.** Plugin commands run inside the
   coding host. Context content returned by a plugin, and content the active
   model prepares for a saved context, can be processed by the model provider
   configured for that host. In Claude Code, this includes ephemeral,
   privacy-filtered evidence projections requested during an explicit save.
2. **Installation and updates.** The coding host may contact GitHub, npm, and
   its plugin or marketplace services to install, validate, or update a plugin.
   The plugins do not control the diagnostic and account data those services
   process.

The plugins do not sell personal information or share it for cross-context
behavioral advertising.

## Retention and deletion

Local data remains until you remove it or a plugin operation removes it:

- The delete workflow asks for confirmation before deleting a context.
- Deleting a context also deletes generated conversation knowledge stored
  inside its local bundle.
- Deleting a context created from an external knowledge folder does not delete
  that external folder.
- Selection, routing, and temporary files can be deleted manually from the
  locations listed above.
- Claude transcript pointers age out with the bounded recent-session routing
  state or can be removed by deleting `plugin-routing.json`. Deleting that
  pointer does not delete the host's transcript; host transcript retention is
  controlled by the coding host.

Uninstalling a plugin does not automatically remove data under
`~/.neatcontext`, because that data is stored outside the coding host's plugin
cache. Remove it manually if you no longer want to retain it.

Imported bundles are copied into local plugin storage. The source bundle is not
modified or uploaded by the import operation.

## Security

Local state files containing operational metadata are written with restrictive
permissions where the operating system supports them. Conversation-evidence
redaction recognizes common secret shapes but cannot identify every sensitive
value or every form of personal information. No method of storage or processing
is completely secure, so avoid saving secrets or sensitive information that you
do not want processed by your coding host or retained in a context.

## Changes to this policy

Material changes will be published in this repository with an updated effective
date. The Git history provides a record of revisions.

## Contact

For privacy questions, open an issue at
<https://github.com/XTSoftwareLabs/neatcontext-plugins/issues>. Do not include
private context content, credentials, or other sensitive information in a
public issue.
