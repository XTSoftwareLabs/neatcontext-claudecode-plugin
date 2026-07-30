# Privacy Policy

**Effective date: July 30, 2026**

This policy describes how the NeatContext host plugins for Claude Code, Kimi
Code, and Codex ("the plugins"), published by XT SOFTWARE LABS LLC, handle
information. It applies only to the open-source plugins in this repository.
The coding hosts, their model providers, the NeatContext desktop app, and
third-party services configured through NeatContext have their own terms and
privacy practices.

## Summary

- The plugins do not send telemetry, analytics, crash reports, or advertising
  data to XT SOFTWARE LABS LLC.
- The plugins do not require an XT SOFTWARE LABS LLC account and do not use
  an XT SOFTWARE LABS LLC-operated cloud service.
- Lite contexts and operational state are stored on your computer.
- Content is provided to the active coding host when you invoke plugin features
  or connect a context, so that content is handled according to the terms,
  privacy policy, and settings of that host and its configured model provider.
- The optional NeatContext desktop integration communicates with a local
  companion service on `127.0.0.1`. Extension tools configured separately in
  NeatContext may communicate with their configured services.

## Information the plugins handle

The plugins handle information only when needed to provide their features:

- **Context content:** profiles, routing descriptions, Markdown knowledge,
  context names, and portable context manifests that you create, save, or
  import.
- **Conversation captures:** selected information from the active coding
  conversation when you invoke the host's NeatContext save command, whether
  creating a context or updating one. The workflow instructs the active model
  to create a focused capture rather than storing the entire transcript.
- **Linked files:** paths and readable content from knowledge folders you
  explicitly connect to a lite context.
- **Operational state:** context identifiers and names, the selected context
  for a coding-host session, routing mode, routing descriptions, aliases,
  recent routing decisions or refusals, timestamps, and host session
  identifiers.
- **Desktop companion connection details:** the local port and bearer token
  written by the NeatContext desktop app. The active plugin reads these details
  to authenticate requests to the loopback companion service.

The plugins do not intentionally collect account credentials, payment
information, advertising identifiers, or precise location information.

## Local storage

By default, the plugins store or read data in these locations:

- `~/.neatcontext/lite/` for lite contexts, profiles, manifests, managed
  knowledge, and conversation additions saved into contexts that link external
  knowledge folders.
- `~/.neatcontext/plugin-selection.json` and
  `~/.neatcontext/plugin-sessions/` for context selections.
- `~/.neatcontext/plugin-routing.json` for routing metadata and a bounded
  history of recent routing decisions.
- `~/.neatcontext/companion.json` for discovery information written by the
  NeatContext desktop app.
- `.neatcontext-capture-*.json` in the active project as a temporary save
  scratch file.

The `NEATCONTEXT_COMPANION_FILE` environment variable can move the companion
discovery file and related plugin state to another location.

Temporary conversation-capture files are removed after a successful consumed
save. A file may remain after validation or another failure so the capture can
be repaired; you can delete it manually at any time.

## Network communication and disclosure

The plugins have no telemetry endpoint and do not transmit information
to an XT SOFTWARE LABS LLC-operated server.

The following communications can occur:

1. **Your coding host and model provider.** Plugin commands run inside Claude
   Code, Kimi Code, or Codex. Context content returned by a plugin, and content
   the active model prepares for a saved context, can be processed by the model
   provider configured for that host.
2. **NeatContext desktop.** For standard contexts, the active plugin
   communicates with the NeatContext desktop companion over HTTP on
   `127.0.0.1`. This can include context identifiers, context documents,
   connection state, and MCP requests or responses.
3. **Configured extension services.** Standard-context extension tools may
   contact services that you or your organization configured separately in
   NeatContext. Their privacy practices govern information sent to them.
4. **Installation and updates.** The coding host may contact GitHub and its
   plugin or marketplace services to install, validate, or update a plugin.
   The plugins do not control the diagnostic and account data those services
   process.

The plugins do not sell personal information or share it for cross-context
behavioral advertising.

## Retention and deletion

Local data remains until you remove it or a plugin operation removes it:

- The host's NeatContext delete workflow asks for confirmation before deleting
  a lite context.
- Deleting a lite context also deletes the generated conversation knowledge
  stored inside its local bundle.
- Deleting a context created from an external knowledge folder does not delete
  that external folder.
- Standard contexts are managed and deleted in the NeatContext desktop app.
- Selection, routing, and temporary files can be deleted manually from the
  locations listed above.

Uninstalling a plugin does not automatically remove data under
`~/.neatcontext`, because that data is stored outside the coding host's plugin
cache. Remove it manually if you no longer want to retain it.

Imported bundles are copied into local plugin storage. The source bundle is
not modified or uploaded by the import operation.

## Security

The plugins limit their desktop connection to the loopback interface and use the
desktop app's bearer token. Local state files containing operational metadata
are written with restrictive permissions where the operating system supports
them. No method of storage or processing is completely secure, so avoid saving
secrets or sensitive information that you do not want processed by your coding
host or retained in a context.

## Changes to this policy

Material changes will be published in this repository with an updated
effective date. The Git history provides a record of revisions.

## Contact

For privacy questions, open an issue at
<https://github.com/XTSoftwareLabs/neatcontext-plugins/issues>. Do not include
private context content, credentials, or other sensitive information in a
public issue.
