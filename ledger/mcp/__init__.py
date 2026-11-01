"""The read API as MCP tools, for a Claude session on the same machine.

A separate process from the app, with its own dependency (`mcp`, the `[mcp]`
extra), talking to the app over loopback HTTP. See `server.py` for the tools
and the rules they follow; `python -m ledger.mcp` runs it.
"""
