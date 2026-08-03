# Conversation evidence architecture

Status: Claude Code first implementation. The shared projector is packaged for
the other NeatContext hosts but their transcript adapters are not connected yet.

## Why this exists

A long coding conversation is structured data, not plain prose. User requests,
assistant conclusions, tool calls, tool outcomes, compaction, and host-injected
records have different value and different privacy risks. A save workflow that
relies only on the currently visible window can miss earlier work after
compaction; one that dumps a raw transcript into the model exposes too much and
encourages transcript-shaped knowledge.

This design was informed by the compiler and view concepts described in the
[VCC paper](https://arxiv.org/abs/2603.29678) and the public descriptions of
[VCC](https://github.com/lllyasviel/VCC) and
[pi-vcc](https://github.com/sting8k/pi-vcc). It is a clean-room NeatContext
implementation: no source code from either project is copied or adapted.

The paper's main useful separation is:

1. Parse a host-specific trace into a host-independent representation.
2. Give that representation one stable coordinate system.
3. Lower it into task-specific views instead of asking a model to understand
   raw JSONL.

The paper reports better reflector outcomes and lower reflector token use in
its AppWorld experiment. That is encouraging evidence, not a guarantee that
the same gains transfer to NeatContext saves, so this implementation keeps the
mechanism testable and the relevance policy replaceable.

## NeatContext's adaptation

```text
Claude Stop / PreCompact hook
          |
          | stores only the host-supplied transcript path
          v
explicit /neatcontext:save
          |
          v
Claude JSONL adapter --> privacy-filtered evidence IR
                                  |
             +--------------------+-------------------+
             |                    |                   |
          overview         literal search       exact block detail
             |                    |                   |
             +--------------------+-------------------+
                                  |
                         active session model
                                  |
                         capture coverage review
                                  |
                         normal preview/save flow
```

NeatContext does not implement VCC's lossless full view. A raw transcript is
the wrong canonical artifact for a reusable context and would weaken the
plugin's privacy posture. Instead, the stable coordinate system begins after
host records have been filtered and sanitized. The resulting `B0001`, `B0002`,
and later ids are stable for a given transcript prefix and are meaningful only
inside the current evidence compilation.

NeatContext also uses literal in-memory search for the first version. It is
predictable, dependency-free, needs no embedding service or second model, and
is adequate for names, paths, ticket ids, failures, and verification terms.
BM25, embeddings, or an LLM relevance predicate can be added behind the same
projection interface if measurements show that literal retrieval misses useful
evidence.

## Shared evidence IR

The host-neutral implementation lives in
`shared/core/conversation-evidence.mjs`. A host adapter emits semantic blocks
with these fields:

- `kind`: user, assistant, tool call, tool result, or compaction.
- `turn`: the host-independent conversational turn number.
- `title` and `text`: bounded, sanitized evidence.
- `category`: conversation, mutation, read, search, verification, commit,
  shell, delegation, or other.
- `outcome`: success, error, or unknown.
- `anchors`: safe exact handles such as repository-relative paths and ticket
  ids.
- `hints`: structural signals such as turn close, resolution, or mutation.

The shared compiler validates the vocabulary, redacts secret-shaped values,
assigns block ids, and scores durable signals. The score is a selection aid,
not a truth score. Recent blocks, user requests, mutations, errors,
verifications, commits, decisions, and turn-closing conclusions receive more
weight.

Four projections currently share this IR:

- `overview`: a bounded high-signal trajectory, preserving source order and
  showing gaps where lower-signal blocks were omitted.
- `search`: literal term retrieval ranked by term coverage, occurrences,
  phrase match, and the block's durable-signal score.
- `show`: full sanitized content for explicitly requested block ids, with
  neighboring ids for navigation.
- `coverage`: an advisory comparison between a completed capture draft and
  high-signal evidence. It reports candidates; it never blocks a save or treats
  lexical absence as proof.

## Claude adapter and privacy boundary

Claude's `Stop` and `PreCompact` hooks already receive `session_id` and
`transcript_path`. They retain the path as opaque, bounded session metadata in
`plugin-routing.json`. They do not compile or retain message content.

Only an explicit `/neatcontext:save` invokes the evidence reader. It opens the
recorded path directly and never discovers transcripts by searching user
directories. The streaming Claude adapter then:

- discards system and unknown records;
- excludes thinking and redacted-thinking blocks;
- removes known Claude harness wrappers from conversational text;
- omits edit payloads, file bodies, raw shell commands, internal task-list
  operations, and successful read/search result bodies;
- reduces shell calls to a safe command family such as `npm test` or
  `git commit`;
- keeps bounded error, verification, commit, mutation, and delegated findings
  when they can support a durable conclusion;
- normalizes structured and common embedded in-project paths to
  repository-relative paths and replaces the directories of outside-project
  paths with `[outside-project]`;
- applies best-effort redaction for common credentials, tokens, private keys,
  authenticated URLs, and secret-like assignments;
- bounds individual records, retained semantic text, projection sizes, and the
  number of routing sessions that can hold transcript pointers.

The IR remains in process memory and projections are returned through stdout.
No plugin-owned compiled evidence file, index, or cache is created. Like other
tool output, a coding host may retain a rendered projection in its own session
transcript under that host's settings. The Claude adapter recognizes
NeatContext's own CLI calls and excludes their results from later compilations,
preventing recursive evidence. The only project scratch file is the existing
model-authored `.neatcontext-capture-*.json`, which is validated and removed
after a successful create or confirmed update. The saved lite context continues
to contain the active model's focused abstraction, never a transcript or
evidence dump.

Redaction is defense in depth, not a promise that arbitrary sensitive prose can
always be recognized. The save instructions still require the active model not
to retain credentials, private material, unnecessary personal information, or
raw logs.

## Cross-host packaging

Installed host plugins cannot import files outside their own package. The
canonical shared source is therefore copied into each package by:

```bash
npm run sync:evidence
```

`npm run check` fails when a packaged copy differs from the canonical source.
The copies currently ship under the Claude, Kimi, pi, and Codex plugin
`src/core/` directories. Only Claude has a host adapter and save-flow
integration in this phase.

To add another host:

1. Map its native trace records to semantic blocks; keep host parsing outside
   `src/core/`.
2. Document and test which host records and payloads are dropped before the
   shared IR.
3. Obtain the active session's trace location from an official hook or API;
   do not scan transcript directories.
4. Expose overview, search, show, and coverage through that host's save
   workflow without persisting a compiled view.
5. Test secret redaction, raw-payload exclusion, stable ids, compaction, malformed
   records, size bounds, and unavailable traces.
6. Measure save completeness, unsupported-claim rate, latency, and token use
   before choosing a richer relevance predicate.

## Deliberate non-goals

- Replaying, exporting, or resuming a conversation.
- Preserving chain-of-thought or host system prompts.
- Treating tool success as proof that a broader conclusion is true.
- Automatically saving without the existing user-controlled flow.
- Sharing one host's trace schema or transcript path with another host.
- Adding embeddings, a vector database, or another model before retrieval
  quality demonstrates a need.
