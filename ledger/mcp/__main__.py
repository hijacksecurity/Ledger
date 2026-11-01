"""`python -m ledger.mcp` — run the server over stdio, or HTTP with --transport."""

import sys

from ledger.mcp.server import main

sys.exit(main())
