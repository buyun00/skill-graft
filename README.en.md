# skill-graft

> **Language**: [English](./README.en.md) · [简体中文](./README.md)

![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)
![Status](https://img.shields.io/badge/status-local_experiment-orange.svg)
![Platform](https://img.shields.io/badge/platform-windows-lightgrey.svg)

The hub is a Skill **version library**. Each worktree pins the Skill versions it uses; updates are **copied** (automatically or by hand). Different trees may pin different versions. Live “change once, every attached tree updates instantly” is not a goal.

What lives on GitHub is the **runtime** (CLI, adapters, panel, overlay). Your local Skill content stays in `skills/` and is, by default, neither committed nor uploaded.

**Dual-host implementation plan, real-environment acceptance, and current progress:** [`docs/双宿主独立核心改造实施计划.md`](./docs/双宿主独立核心改造实施计划.md). The status summary is in [`docs/现状与DSH插件化转移.md`](./docs/现状与DSH插件化转移.md).

---

## The problem it solves

Many repos materialize a full assistant directory (Skill, agent, rules) inside every worktree. The consequences:

1. **A fresh checkout re-materializes the whole set.** It is large, noisy, and often out of sync with what you actually use.
2. **Different trees may pin different versions.** The hub changing does not have to update every claimed tree at once; alignment is pin + copy, not a live link.
3. **Upstream updates should not be triaged on a feature branch.** A business-coding conversation should not stop to decide whether an official Skill ought to be absorbed.

skill-graft puts the "authority for the local workflow" in **a separate repository**. What lands on a tree is a claimed result (copy to that tree's pin), not a live mount; official updates go to an inbox for a human to decide; the first switch off the official tree goes through a background conversation, not a silent script. The current implementation still uses Junction / HardLink; the next step is copy + pin — see [`docs/现状与DSH插件化转移.md`](./docs/现状与DSH插件化转移.md).

The idea is not bound to one kind of project. The current "do we recognize this tree?" check still hard-codes: root must have both `AGENTS.md` and `baloot_client` (the rule it was first validated against on the game-client repo). It will later collapse into a configurable rule.

---

## What it can do now

| Capability | Entry point | Notes |
|---|---|---|
| One-shot install | `setup.cmd` / `sg setup` | Sets up the environment, puts `sg` on PATH, silent daemon, login-autostart |
| Inventory | `sg status` / `GET /api/state` | Resident / adopted / inbox, counts, associated repos |
| Scan worktrees | `sg list-worktrees` / `GET /api/worktrees` | Whether attached, whether override is linked, whether the official tree is still on disk |
| List Skills | `sg list-skills` | Three node kinds; `attached` tells whether the game-tree link points at the hub |
| First graft | `sg attach --worktree <path>` | **Background Codex conversation** (default `gpt-5.6-luna` + max), not a CLI script |
| Re-link a broken tree | `sg repair-links --worktree <path>` | Idempotent relink; errors out if on-tree content differs from the hub, so nothing is silently overwritten |
| Enqueue official updates | hook → `sg ingest` | `fetch`/`pull` only ingests into the hub inbox; no semantic triage on the feature tree |
| Decide inbox | `sg decide --id … --action adopt\|merge\|reject` | Adopt / merge-in / reject |
| Edit Skill / chat / detach | `sg edit` / `chat` / `detach` / `resume` | Also enqueued as Codex sessions |
| Keep-alive | `sg daemon status` / `GET /api/daemon` | Windowless daemon guarding the local HTTP API (:18765), restarts if killed |
| HTTP / web | Started by the daemon; or `npm run api` | `:18765` API plus the current glass panel; transport is still CLI-oriented and will move to the shared Application |

Current pre-migration funnel:

```text
Human / HTTP / Git hook
        │
        ▼
   sg / ozdqp-hub (CLI)   ← current local entry point
        ▼
      core
        ▼
     adapters (paths / fs / links / git)
```

The target is not to make DSH call this external CLI. The single business contract will be shared `HubApplication.execute(command)`: the complete local distribution calls it through CLI/HTTP/web adapters, while the complete DSH distribution composes it in-process. Only host adapters, lifecycle, UI, and packaging differ; neither distribution is a runtime prerequisite for the other.

The first graft is driven by a conversation: recon → `manage-skill-visibility -Mode Disable` → `attach-library -ConfigureGit -PreferLibrary` → acceptance. After the CLI process exits the conversation keeps running (on Windows it is launched via WMI so it is not killed off together with the Job Object).

---

## How to use it

### One-shot setup

You need Node.js and Git locally. To run an `attach` conversation you also need a signed-in [Codex CLI](https://github.com/openai/codex).

```text
git clone https://github.com/buyun00/skill-graft.git
cd skill-graft
setup.cmd
```

You can also: `npm run setup`, or after building from source, `node dist/control/cli.js setup`.

This step will:

1. Install dependencies and build the CLI (if not already present)
2. Lay out `skills/`, `overlay/`, `skill-review/`
3. Write `sg` (and the legacy alias `ozdqp-hub`) into `%LOCALAPPDATA%\skill-graft\bin` and add it to the current user's PATH; if `%APPDATA%\npm` exists locally, drop a copy there too so already-open terminals can often use it immediately
4. Register a login-autostart scheduled task `SkillGraft` (hidden window)
5. Start the silent daemon that keeps `http://127.0.0.1:18765/api/health` alive

Then **open a new terminal**:

```text
sg status
sg doctor
sg --help
```

If a terminal already open inside your editor can't find `sg`, restart the editor. Uninstall: `sg uninstall` (removes only the command, PATH entry, daemon and autostart — it does not delete this repo and does not touch `skills/`).

Put your Skills in the local `skills/` directory (it is gitignored). Typical layout:

```text
skills/
  <resident-a>/SKILL.md
  <resident-b>/SKILL.md
  inbox/                 # ingest writes here
  adopted/
AGENTS.override.md       # the one grafted onto the worktree root
overlay/scan-roots.txt   # scan roots, one directory per line
```

### Querying

```text
sg status
sg list-worktrees
sg list-skills
sg --help
```

On success stdout is UTF-8 JSON. You can also set `HUB_ROOT` to point at another hub data root. Before `sg` is installed you can use `npm run hub -- status`.

### Re-graft a tree onto the hub

```text
sg attach --worktree D:\your-checkout
```

The CLI returns a session immediately (`status: running`, with a pid); Codex does the detachment and claim in the background (today: creating links). Options:

```text
--intent "…"           extra intent
--model gpt-5.6-luna   this is the default
--effort max           the default
--no-spawn             enqueue only, do not start a conversation (for testing)
```

**Current implementation:** once grafted, the tree should have: resident Skill directories → Junctions into the hub; `AGENTS.override.md` → a HardLink (or symlink) into the hub; the official `.claude/skills` / `.codex/skills` absent from disk. Use `list-worktrees` to read `attached` / `overrideLinked` / `officialPresent`.

**Product next:** copy those same paths to a per-tree pin; live hardlinks are not required. See the transfer doc.

If links on an already-grafted tree are broken, do **not** run a first-time attach again:

```text
sg repair-links --worktree D:\your-checkout
```

If someone has edited the on-tree override and it differs from the hub, this command will fail and explain why — it will neither silently overwrite with the hub nor pollute the authority in reverse.

### Inbox

If a worktree has the hub hooks installed, `fetch`/`pull` of official Skills only `ingest`s them into the hub inbox. A human then decides:

```text
sg decide --id <id> --action adopt
sg decide --id <id> --action merge --merge-target skills/ozdqp-development
sg decide --id <id> --action reject
```

### HTTP (no web UI)

The installer hands the API over to the daemon for keep-alive. You can also run it in the foreground:

```text
npm run api
```

`GET http://127.0.0.1:18765/api/health`, `/api/state`, `/api/worktrees`, `/api/daemon`. The management page has been removed and will be redone later.

```text
sg daemon status
sg daemon stop
sg daemon start
```

### Tests

```text
npm test              # tsc + layered tests
npm run test:cli      # CLI only
npm run test:http     # HTTP forwarding and field parity
```

---

## Intentionally not on GitHub

| Path | Why |
|---|---|
| `skills/**` (except `skills/README.md`) | Local workflow and project details |
| `skill-review/sessions.json`, conversation logs / prompts | Local sessions |
| `dist/`, `node_modules/` | Build artifacts |

The public repo only holds the graft runtime. Moving to another machine: clone skill-graft, then copy your `skills/` over or sync it separately.

---

## Roadmap

What has stabilized is the query surface and "the CLI is the only control plane". What comes next, in rough dependency order:

1. **Configurable tree-recognition rules.** Drop the hard-coded `AGENTS.md` + `baloot_client`; use a list or probe rule to graft any Git worktree.
2. **Fold disk-writing commands back into core.** `repair-links` / `ingest` / `decide` still shell out to `.ps1`; fold them into the Node ports so Windows / macOS / Linux share one set of verbs.
3. **Observable sessions.** Have Codex write back to `sessions.json` when it finishes (a detached process exiting can currently leave the state stuck on running); optional `hub attach --wait` that blocks until the conversation ends and prints acceptance.
4. **detach / edit on par with attach.** Detaching and editing a single Skill are both background conversations, with acceptance fields aligned to the query JSON.
5. **A fuller inbox.** Suggestions (adopt / merge / reject) filled in by the analysis conversation; the panel only renders the shape the CLI gives.
6. **Multi-machine / small team.** Runtime on GitHub, corpus via a separate private sync (or a future team service) — never push someone else's project details into the public repo.
7. **A new management page.** Consumes only CLI/HTTP JSON and no longer computes "is it attached" in the frontend.

For finer layer boundaries see section 9 of `docs/系统设计与理念.md`; the query spec for this stage is in `docs/三层本阶段规格.md`.

---

## License and scope

This repository is released under the **Apache License 2.0**; see [LICENSE](./LICENSE).

This repo is a local-experiment graft runtime. Do not commit files from this repo into business repositories.
