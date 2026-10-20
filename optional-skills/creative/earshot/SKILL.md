---
name: earshot
description: Hear and score audio files locally, upstream-kept.
version: 0.3.0
author: Leon Lin (Leonxlnx)
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [audio, sound, sfx, sound-design, video, loudness, clap, mcp, cpu]
    category: creative
    related_skills: [songsee, hyperframes, audiocraft-audio-generation]
    upstream:
      repo: Leonxlnx/earshot
      path: skills/earshot
---

# earshot (upstream-maintained)

> **Catalog stub.** This entry is maintained upstream at
> [Leonxlnx/earshot](https://github.com/Leonxlnx/earshot). `hermes skills
> install official/creative/earshot` pulls the current `skills/earshot/`
> SKILL.md live from that repo (quarantined and scanned like any hub install).
> This directory holds only the catalog metadata and the Hermes notes below,
> so the copy can't go stale while upstream ships several releases a week.

earshot gives an agent "ears". It reads a sound or a video's audio track and
returns evidence: a plain-language description with calibrated z-scores, how
well a text description fits ("strong match, z +3.7"), the best moments inside
a long recording as trims, real-recording vs code-synthesized, a second-by-
second listening timeline synced to picture cuts, an annotated PNG sheet, and
a scorecard against professional launch films. It also renders sound effects
from a bank of 201 code-defined sounds (`earshot sfx`) and can make new ones in
code, improving them by listening (`earshot forge`). Everything runs locally on
CPU. Audio never leaves the machine, except through the opt-in `llm` command.

## When to use it

Use it whenever the task needs a judgement about sound you can't hear. That
covers picking an SFX or music bed from candidates, trimming the clean take,
checking a rendered video's mix and sync (hyperframes, manim and ffmpeg
pipelines), A/B-ing a mix change, or confirming that generated audio matches
its prompt. Quote the number when you report ("strong match z +3.9; -14.2
LUFS"). Never say how audio sounds without a reading behind it.

## Hermes notes (read before the upstream body)

**Install the CLI.** It's not on PyPI under this name: the PyPI `earshot`
package is an unrelated project, so `pip install earshot` installs the wrong
thing. Install from the repo with CPU-only torch. This needs `uv`; Hermes ships one
at `~/.hermes/bin/uv` if `uv` isn't on PATH, and uv warns when its tool bin dir
isn't on PATH yet:

```bash
uv tool install -p 3.11 --index-strategy unsafe-best-match \
  --extra-index-url https://download.pytorch.org/whl/cpu \
  "earshot[mcp] @ git+https://github.com/Leonxlnx/earshot"
earshot doctor
```

The venv comes to about 1.4 GB (CPU torch + transformers). The first
model-using command downloads two pinned Hugging Face models (CLAP
`laion/larger_clap_general` and the AudioSet AST) into earshot's own cache,
about 1 GB. Set `EARSHOT_HOME` to choose where that cache lives. `measure`,
`sfx` and `kit` load no models and answer in a second or two. `HF_TOKEN` is
not needed (expect an unauthenticated-Hub warning on stderr).

**Shared machine.** Set `EARSHOT_THREADS=2` or `3` so one call doesn't take
every core.

**Prefer the CLI or one Python script over the MCP server.** The upstream body
suggests `earshot mcp` for repeated calls. Under Hermes that server exposes 16
tools, about 6.4k tokens of schema, in every turn of every session it's
enabled for. For a handful of calls use the CLI (each call reloads the models
in about 20-40 s). For more, write one script with
`from earshot import api` and run it once with the tool's interpreter:
`"$(uv tool dir)/earshot/bin/python" script.py` (after the first load, repeat
calls take well under a second). Add the MCP server only when a long audio
session justifies it:

```bash
hermes mcp add earshot --command earshot --args mcp
```

**Looking at sheets.** `earshot sheet FILE -o out.png` draws frames, labelled
events, spectrogram and loudness. Read it with `vision_analyze` and ask
specific questions ("does the hit at 0:01.2 land on the cut?").

**Long jobs.** `critique` and `timeline` on a full film, and `forge` loops,
can take minutes. Run them with `terminal(background=true, notify=true)`.

**The optional `llm` command** sends audio to Gemini only with an explicit
`--yes-upload` and your own `GEMINI_API_KEY`. Don't run it without the user's
consent.

## Verification

```bash
earshot sfx render click/double -o "$PWD/click.wav"   # no models, < 1 s
earshot measure "$PWD/click.wav"                      # LUFS / true peak / attack
earshot match "$PWD/click.wav" "a snare hit" --alts "thunder" "a dog barking"
```

The first two print a one-line summary. `match` loads the models (the first
run downloads them) and prints a verdict with a z-score and a forced-choice
split over the alternatives. Expect `strong` here: the bank's `click/double`
reads closest to a snare hit. A z below about 2 is a `no match` verdict about the
sound, not an install failure.
