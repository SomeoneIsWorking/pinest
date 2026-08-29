# drills

Repeatable evidence runs. They are instruments, not artifacts — they live in
git so the next session can re-run them; their output goes to `scratch/logs/`.

| Drill | Proves | Needs |
|---|---|---|
| `reload-explicit-rpc.mjs` | Editing a watched file NEVER reloads, `/pinest-reload` DOES, and the live sessions parked by that reload are adopted exactly once (I-021). | `pi` on PATH; runs a real `pi --mode rpc` host, which starts a tunnel and resumes your registry's sessions. |
| `steer-delivery.mjs` | WHEN a `deliverAs:"steer"` message actually reaches the session — measured against a text-only turn and a turn with a tool call. Answers "is my steer being ignored?" with a number. | nothing external |
| `reload-midrun.mjs` | A reload landing MID-RUN hands the in-flight run to the re-imported instance: it keeps streaming onto the new instance, finishes, and still accepts input. Uses a local fake SSE model server — no tokens spent, deterministic timing. | nothing external |

Both must be run in BOTH directions before their results are trusted:

```sh
node drills/reload-midrun.mjs              # must PASS
node drills/reload-midrun.mjs --negative   # kills the parked run — must fail the survival assertion
node drills/reload-explicit-rpc.mjs        # must PASS
```

`--negative` exists because a drill that has only ever seen the passing class
cannot tell a handed-over run from a killed one.
