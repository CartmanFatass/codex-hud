"""JSONL transport for the installed jev_ultrafast.Agent, not a browser engine.

API source: browser-use/jev-ultrafast@1231850a0bf1a0c0341fe408ef1668dbbfdfac46.
One bridge owns one Agent. EOF/errors never call close; only explicit close does.
"""

import contextlib
import json
import sys


def main():
    output = sys.stdout
    agent = None
    for line in sys.stdin:
        request = {}
        error_origin = None
        try:
            request = json.loads(line)
            method, args = request["method"], request.get("args", {})
            # Native logging must not corrupt JSONL replies.
            with contextlib.redirect_stdout(sys.stderr):
                if method == "create":
                    if agent is not None:
                        raise ValueError("jev_instance_already_created")
                    from jev_ultrafast import Agent

                    agent = Agent(
                        args["url"], args["goals"],
                        record_dir=args.get("record_dir"),
                        screenshots=args.get("screenshots", False),
                    )
                    # These are actual Browser CDP fields, never guessed from page content.
                    value = {"targetId": agent.browser.target, "sessionId": agent.browser.session}
                elif method == "close" and agent is None:
                    value = None
                elif agent is None:
                    raise ValueError("jev_instance_not_created")
                elif method == "run":
                    # Forward actual yields while the synchronous Agent is running.
                    # Other Agent calls remain serial; this does not interleave commands.
                    value = []
                    encoding_error = None
                    streaming = True
                    for snapshot in agent.run():
                        # Freeze the JSON value at the yield: upstream snapshots can
                        # contain mutable history lists reused by subsequent steps.
                        try:
                            snapshot = json.loads(json.dumps(snapshot, allow_nan=False))
                            event = json.dumps({"id": request["id"], "event": "run_yield",
                                                "value": snapshot}, allow_nan=False) + "\n"
                        except (TypeError, ValueError, OverflowError, RecursionError) as error:
                            # Display encoding cannot stop the native generator early.
                            # Like final-response encoding, report this after consumption.
                            if encoding_error is None:
                                encoding_error = error
                            continue
                        if streaming:
                            try:
                                output.write(event)
                                output.flush()
                            except OSError:
                                # A lost observer is not permission to stop native work.
                                streaming = False
                        value.append(snapshot)
                    if encoding_error is not None:
                        error_origin = "observation_encoding"
                        raise encoding_error
                elif method == "snapshot":
                    value = agent.snapshot()
                elif method == "command":
                    value = agent.command(args["name"], args.get("body"))
                elif method == "close":
                    value = agent.close()
                else:
                    raise ValueError("unknown_jev_method")
            reply = {"id": request["id"], "ok": True, "value": value}
            # No default=str: unsupported upstream values must not be silently rewritten.
            encoded = json.dumps(reply, allow_nan=False)
        except Exception as error:
            details = {"type": type(error).__name__, "message": str(error)}
            if error_origin is not None:
                details["origin"] = error_origin
            encoded = json.dumps({"id": request.get("id"), "ok": False, "error": details})
        output.write(encoded + "\n")
        output.flush()


if __name__ == "__main__":
    main()
