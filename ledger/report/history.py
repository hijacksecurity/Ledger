"""All-time history — the open-ended view.

Nothing here is bounded to a year range. Years appear as rows the moment a
session lands in them, and the day series is returned as one run-length of
counts from the first ever entry to today, so 2027 costs no code change.

Payload size: one small integer per day. Ten years is ~3,650 numbers, which is
a few kilobytes — cheap enough that the client never needs to paginate.
"""

from __future__ import annotations

import sqlite3
from datetime import date, timedelta
from typing import Any

from ledger.core.windows import ema_series, to_date
from ledger.db import queries as q
from ledger.report import timeframe
from ledger.report.average import activities_per_week


def build_history(conn: sqlite3.Connection, today: date | None = None) -> dict[str, Any]:
    today = today or date.today()
    first = q.first_session_date(conn)
    if not first:
        return {"start": None, "end": today.isoformat(), "counts": [], "years": [],
                "bodyweight": [], "weeks": 0,
                "average": activities_per_week(conn).as_dict()}

    # Run to the end of the current week so the grid never ends mid-column.
    start = to_date(first)
    end = max(today, to_date(q.last_session_date(conn) or first))
    end += timedelta(days=6 - end.weekday())

    counts = q.daily_counts(conn, start.isoformat(), end.isoformat())
    series: list[int] = []
    cursor = start
    while cursor <= end:
        series.append(counts.get(cursor.isoformat(), 0))
        cursor += timedelta(days=1)

    by_kind = q.year_kind_totals(conn)
    years = []
    for r in q.year_totals(conn):
        span_days = (to_date(r["last"]) - to_date(r["first"])).days + 1
        years.append(
            {
                "year": r["year"],
                "activities": int(r["activities"]),
                "active_days": int(r["active_days"]),
                "distance_km": round(float(r["distance_km"]), 1),
                "load": round(float(r["load"])),
                "first": r["first"],
                "last": r["last"],
                "avg_per_week": round(int(r["activities"]) / (span_days / 7), 2),
                "by_kind": by_kind.get(r["year"], {}),
            }
        )

    raw = q.bodyweight_series(conn, start.isoformat(), end.isoformat())
    bodyweight = [
        {"date": d, "kg": round(v, 2), "ema": round(e, 2)}
        for (d, v), (_, e) in zip(raw, ema_series(raw, span=7), strict=True)
    ]

    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "today": today.isoformat(),
        "counts": series,
        "years": years,
        "bodyweight": bodyweight,
        "weeks": len(series) // 7,
        "total": sum(series),
        "timeframe": timeframe.all_time(
            start.isoformat(), end.isoformat(), "day"
        ).as_dict(),
        # The lifetime figure, from the same function the week hero uses, so
        # "now" cannot mean two different numbers on two screens.
        "average": activities_per_week(conn).as_dict(),
    }
