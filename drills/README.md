# drills

Repeatable evidence runs. They are instruments, not artifacts — they live in
git so the next session can re-run them; their output goes to `scratch/logs/`.

| Drill | Proves | Needs |
|---|---|---|
| `reload-explicit-rpc.mjs` | Editing a watched file NEVER reloads, `/pinest-reload` DOES, and the live sessions parked by that reload are adopted exactly once (I-021). | `pi` on PATH; runs a real `pi --mode rpc` host, which starts a tunnel and resumes your registry's sessions. |
| `steer-delivery.mjs` | WHEN a `deliverAs:"steer"` message actually reaches the session — measured against a text-only turn and a turn with a tool call. Answers "is my steer being ignored?" with a number. | nothing external |
| `compact-clear.mjs` | `/compact` and `/clear` do rewrite the context AND tell the client (transcript push + usage refresh + notice) — I-025. Uses a real `AgentSession` against a local fake model; `--negative` does the same operations straight on the session (the silent pre-fix path) and must fail. | nothing external |
| `reload-midrun.mjs` | A reload landing MID-RUN hands the in-flight run to the re-imported instance: it keeps streaming onto the new instance, finishes, and still accepts input. Uses a local fake SSE model server — no tokens spent, deterministic timing. | nothing external |
| `subagent-fanout.mjs` | A `subagent` tool call actually fans out: a second real `AgentSession` is opened, its own turn is what the tool waits for, the report returns to the parent as the tool result, and `running → completed` is published to the clients. The child must end up on its parent's model and thinking level, read back from the child's own session. `--negative` gives the same request to a model with no such tool and must fail; `--no-inherit` gives the parent a model that exists nowhere and must fail on the child running on the default. | nothing external |

Each must be run in BOTH directions before their results are trusted:

```sh
node drills/reload-midrun.mjs              # must PASS
node drills/reload-midrun.mjs --negative   # kills the parked run — must fail the survival assertion
node drills/reload-explicit-rpc.mjs        # must PASS
node drills/compact-clear.mjs              # must PASS
node drills/compact-clear.mjs --negative   # pre-fix silent path — must fail on the missing notice
node drills/subagent-fanout.mjs              # must PASS
node drills/subagent-fanout.mjs --negative   # a model with no subagent tool — must fail on the missing fan-out
node drills/subagent-fanout.mjs --no-inherit # a child that cannot inherit — must fail on the wrong model
```

`--negative` exists because a drill that has only ever seen the passing class
cannot tell a handed-over run from a killed one.
