# Conversation evidence

## What it is

When you run `/neatcontext:save`, NeatContext compiles the host's current
session transcript into an ephemeral, privacy-filtered view of the
conversation so that earlier work can still be recovered after compaction.

The model does not receive a raw transcript. It sees a bounded overview of the
conversation, can run literal searches over it, and can open only the specific
sanitized blocks it needs. Secrets and raw payloads are filtered out, nothing
is written to disk, and the saved context contains the model's own summary —
never a transcript dump.

This is only for Claude Code now.

## Attribution

The design was informed by the compiler-and-view concepts described in:

- The VCC paper, [arXiv:2603.29678](https://arxiv.org/abs/2603.29678)
- [lllyasviel/VCC](https://github.com/lllyasviel/VCC)
- [sting8k/pi-vcc](https://github.com/sting8k/pi-vcc)

The borrowed idea is the general separation of parsing a host trace into a stable intermediate representation
and lowering it into task-specific views. NeatContext is MIT licensed (see [LICENSE](../LICENSE)).
