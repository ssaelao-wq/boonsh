Search information:





Your syntax:



┌────────────────────────────────────┬──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐

│               Filter               │                                                 What it matches                                                  │

├────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤

│ filename:<regex>                   │ Name matches a regular expression (case doesn't matter), e.g. filename:^inv.\*\\.pdf$                              │

├────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤

│ filesize:0-1M, 250K-1.2M, 800M-1G  │ Size range, both ends included. Units B, K, M, G, T, with 1K = 1024 bytes (same as Explorer). Decimals are fine. │

├────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤

│ filesize:1G+                       │ At least 1 GB                                                                                                    │

├────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤

│ filetype:exe                       │ That extension (.exe and \*.exe also work)                                                                        │

├────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤

│ filedate:2026, 2026-07, 2026-07-06 │ Modified in that year, month or day                                                                              │

├────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤

│ filedate:-07-06, -07-, --06        │ Blank parts mean "any": July 6 of any year, any July, the 6th of any month                                       │

├────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤

│ filesize: (no value yet)           │ Ignored, so the folder keeps showing while you type                                                              │

└────────────────────────────────────┴──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘



Extras I added, since you asked for ideas:

\- Combine terms with spaces. All of them must match, e.g. report filetype:pdf filedate:2026. Plain words still search the name, including \*.md-style wildcards. Quotes keep spaces together: "my file".

\- ! excludes. For example !filetype:tmp or !backup.

\- More size forms: filesize:-10K (at most), >1M, <100K, and filesize:0 for empty files.

\- Several types at once, and groups. filetype:jpg,png matches either. The groups are image, video, audio, doc, archive and code, plus folder and file.

\- Date ranges and relative dates: filedate:2026-01..2026-03, filedate:2026-07-01.. (from that day on), filedate:7d (last 7 days), today, yesterday.

\- Short forms: name:, size:, type:, ext:, date:.

\- A ? button next to the search box opens a cheat sheet, and clicking any example adds it to your search.

\- Errors in plain words. A query that can't be read gets a red border and a message underneath, for example filesize: unknown unit "Q". Use B, K, M, G or T, instead of silently finding nothing.

\-search folder: type:folder size:>1K



