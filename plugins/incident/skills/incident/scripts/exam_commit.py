#!/usr/bin/env python3
"""Optional commitment to an exam's prewritten private world state.

Seal a JSON file BEFORE play, disclose only SHA-256 commitment, reveal state+salt AFTER.
No files are written except explicitly specified --sealed. Standard library only.
"""
import argparse
import hashlib
import json
import os
import sys
from pathlib import Path


def canonical_json(obj):
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(salt, state):
    return hashlib.sha256((salt + "\n" + canonical_json(state)).encode("utf-8")).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    cmds = parser.add_subparsers(dest="command", required=True)
    seal = cmds.add_parser("seal", help="Create sealed commitment from a private JSON state")
    seal.add_argument("--state", required=True, type=Path)
    seal.add_argument("--sealed", required=True, type=Path)
    reveal = cmds.add_parser("reveal", help="Reveal private state and salt after exam ends")
    reveal.add_argument("--sealed", required=True, type=Path)
    verify = cmds.add_parser("verify", help="Verify commitment against a sealed file")
    verify.add_argument("--sealed", required=True, type=Path)
    verify.add_argument("--commitment", required=True)
    args = parser.parse_args()

    if args.command == "seal":
        if args.state.resolve() == args.sealed.resolve():
            parser.error("--state and --sealed must differ")
        state = json.loads(args.state.read_text(encoding="utf-8"))
        salt = os.urandom(32).hex()
        commitment = digest(salt, state)
        payload = {"schema_version": 1, "salt": salt, "state": state, "commitment": commitment}
        args.sealed.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(str(args.sealed), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2, sort_keys=True)
            stream.write("\n")
        print("commitment=" + commitment)
        print("sealed_file=" + str(args.sealed))
        return 0

    payload = json.loads(args.sealed.read_text(encoding="utf-8"))
    calculated = digest(payload["salt"], payload["state"])
    if calculated != payload["commitment"]:
        print("ERROR: sealed content failed internal hash verification", file=sys.stderr)
        return 1
    if args.command == "verify":
        if args.commitment.lower() != calculated:
            print("MISMATCH: commitment does not match original", file=sys.stderr)
            return 1
        print("VERIFIED: commitment matches sealed state")
        return 0
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
