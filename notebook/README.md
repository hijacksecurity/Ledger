# Notebook source material

Raw photos/screenshots of the paper notebook. Source material for the import,
not documentation and not application data — hence its own top-level folder.

**Drop screenshots here:** `notebook/` (this folder)

This is the input for designing the bulk-entry format (`ledger/entry.py`). The
grammar there is provisional and should be bent to match how the pages are
actually written, not the other way round.

Naming that keeps 80+ weeks navigable:

    2024-W12.jpg            one page = one week
    2024-W12_a.jpg          multiple pages for one week
    2024-W12_legend.jpg     anything explaining your own shorthand

If the dates aren't legible on the page itself, the filename is the only record
of them.

Photos are gitignored by default — large and personal. Drop the ignore rule in
`.gitignore` if you decide you want them versioned.

Once transcribed into the database, the photos stay here as the original
record. Nothing in the app reads this folder.
