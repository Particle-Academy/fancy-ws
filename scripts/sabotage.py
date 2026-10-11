"""Prove the fancy-ws suite has teeth.

A new package's suite is the one place where "all green" proves least: nothing
has ever failed, so a test that asserts nothing is indistinguishable from one
that does. Each entry below breaks ONE invariant and names the test that must
go red. A sabotage the suite does not notice is a test to rewrite.

Run with:  python -I scripts/sabotage.py

It EDITS src/ in place and restores it in a `finally`. Do not run it on a dirty
tree, and do not run it in CI -- a check that mutates the source it checks is
not a check you want wired to a push.
"""
import io
import pathlib
import subprocess
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent

SABOTAGES = [
    (
        "accept an unmasked client frame",
        "src/frame.ts",
        "if (options.mask === 'required' && !masked) {",
        "if (false && options.mask === 'required' && !masked) {",
        "unmasked",
    ),
    (
        "drop the per-MESSAGE payload limit (keep the per-frame one)",
        "src/connection.ts",
        "if (this.#fragmentBytes > this.#options.maxPayload) {\n                this.#fail(1009, 'Reassembled message exceeds maxPayload');\n                return false;\n            }\n            this.#fragments.push(payload);",
        "this.#fragments.push(payload);",
        "FRAGMENTS add up",
    ),
    (
        "check maxPayload only after the body has been buffered",
        "src/frame.ts",
        "    if (length > options.maxPayload) {\n        throw new ProtocolError(1009, `Frame payload of ${length} bytes exceeds maxPayload`);\n    }\n",
        "",
        "HEADER ALONE",
    ),
    (
        "emit 'error' unconditionally, with no listener-count guard",
        "src/connection.ts",
        "if (this.listenerCount('error') > 0) {\n            this.emit('error', error);\n        }",
        "this.emit('error', error);",
        "no error listener",
    ),
    (
        # Two separate paths, and the distinction was found BY this probe: the
        # same-segment test kept passing with the `data` collection deleted,
        # because Node had already handed those bytes over in `head`. One
        # sabotage per path, or one of them is unguarded and the suite agrees.
        "drop the pipelined bytes Node hands over in `head` (same TCP segment)",
        "src/server.ts",
        "            head,\n        );",
        "            Buffer.alloc(0),\n        );",
        "pipelined meanwhile",
    ),
    (
        "parse the buffered frame in the constructor, before `connection` listeners exist",
        "src/server.ts",
        "        this.emit('connection', connection, req, verified);\n        // Only now",
        "        connection.start();\n        this.emit('connection', connection, req, verified);\n        // Only now",
        "pipelined meanwhile",
    ),
    (
        # The first version of this sabotage targeted the CONTINUATION branch's
        # `!fin` path -- which the test never reaches, because its second
        # fragment has FIN set. It reported MISSED and the test was fine. A
        # sabotage aimed at dead code is a false alarm, and the only thing that
        # distinguishes it from a real one is reading which branch runs.
        "validate UTF-8 on the FIRST fragment instead of the whole message",
        "src/connection.ts",
        "        this.#fragmentOpcode = opcode;\n        this.#fragments = [payload];",
        "        if (opcode === OPCODE.text) {\n            decodeUtf8(payload);\n        }\n        this.#fragmentOpcode = opcode;\n        this.#fragments = [payload];",
        "whole reassembled message",
    ),
    (
        "echo a subprotocol the client never offered",
        "src/handshake.ts",
        "    return supported.find((candidate) => offered.includes(candidate)) ?? null;",
        "    return supported[0] ?? null;",
        "did not offer",
    ),
    (
        "answer the handshake without hashing the client's key",
        "src/handshake.ts",
        "        .update(key + WEBSOCKET_GUID)",
        "        .update(key)",
        "RFC 6455 section 1.3",
    ),
]


def run(test_name_filter):
    """Run the suite narrowed to one test name.

    Returns (exit_code, selected_count, output). The COUNT is the half that
    matters and the reason this does not just read the exit code: `vitest -t`
    with a pattern that matches nothing skips every test and exits 0, which is
    indistinguishable from "the sabotage ran and the suite did not notice".
    Two sabotages in this file were reported MISSED for exactly that -- a
    mis-typed filter -- and the probe sounded confident about both.
    """
    result = subprocess.run(
        ["npx", "vitest", "run", "-t", test_name_filter],
        cwd=REPO,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        shell=True,
    )
    output = (result.stdout or "") + (result.stderr or "")
    selected = 0
    for line in output.splitlines():
        stripped = line.strip()
        if stripped.startswith("Tests "):
            # "Tests  1 failed | 98 skipped (99)" -- count everything that is
            # not skipped.
            body = stripped[len("Tests ") :].split("(")[0]
            for part in body.split("|"):
                words = part.strip().split()
                if len(words) == 2 and words[0].isdigit() and words[1] != "skipped":
                    selected += int(words[0])
    return result.returncode, selected, output


failures = []
for label, rel, before, after, test_filter in SABOTAGES:
    path = REPO / rel
    original = io.open(path, encoding="utf-8", newline="").read()
    if before not in original:
        print(f"SKIP  {label}\n      anchor not found in {rel} -- the sabotage is stale, not the code")
        failures.append(label)
        continue

    io.open(path, "w", encoding="utf-8", newline="").write(original.replace(before, after, 1))
    try:
        code, selected, output = run(test_filter)
    finally:
        io.open(path, "w", encoding="utf-8", newline="").write(original)

    if selected == 0:
        print(f"NO-TEST {label}")
        print(f'        filter "{test_filter}" selected 0 tests -- it matches no test NAME.')
        print("        This is a broken probe, NOT a verdict about the suite.")
        failures.append(label)
        continue

    caught = code != 0
    print(f"{'CAUGHT' if caught else 'MISSED'}  {label}")
    print(f'        test: "{test_filter}"  selected={selected}  exit={code}')
    if not caught:
        failures.append(label)
        tail = [line for line in output.splitlines() if "Tests" in line]
        print("        " + " | ".join(tail[-2:]))

print()
if failures:
    print(f"{len(failures)} sabotage(s) went unnoticed:")
    for label in failures:
        print(f"  - {label}")
    sys.exit(1)
print(f"All {len(SABOTAGES)} sabotages were caught by the suite.")
