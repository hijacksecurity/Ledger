"""Garmin Connect auth, token persistence and rate limiting (BRIEF §5).

The unofficial API will throttle and can temporarily block the account if
hammered. The throttling in this module is not optional and must not be tuned
down to make a backfill finish sooner.

Auth model:
  * Log in ONCE interactively with email + password (`ledger garmin-login`).
    If MFA is on, the library prompts for a code — this cannot be automated.
  * garth persists OAuth1/OAuth2 tokens to `GARMINTOKENS`. Mount it as a volume.
  * Every later run resumes from those tokens. Repeated password logins are the
    fastest way to get an account flagged.
  * On refresh failure: log, exit non-zero, let cron surface it. Never silently
    fall back to the password.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

#: Backoff schedule for 429 / 5xx, in seconds. After the last one, give up.
BACKOFF_SCHEDULE = (30, 60, 120)


class GarminAuthError(RuntimeError):
    """Token resume failed. Requires an interactive re-login by the user."""


class GarminRateLimited(RuntimeError):
    """Throttled past the backoff schedule. Abort the run and try tomorrow."""


class GarminMFARequired(GarminAuthError):
    """The account needs a one-time code. Not a wrong password."""


def _is_rate_limit(exc: BaseException) -> bool:
    status = getattr(getattr(exc, "response", None), "status_code", None)
    if status == 429 or (isinstance(status, int) and 500 <= status < 600):
        return True
    text = str(exc).lower()
    return "429" in text or "too many requests" in text or "rate limit" in text


class GarminClient:
    """Thin wrapper over `garminconnect` that enforces pacing and logging.

    Every outbound call goes through `.call()`. Nothing in the codebase should
    touch the underlying client directly — that is how an unpaced loop gets
    written by accident six months from now.
    """

    def __init__(
        self,
        token_dir: Path,
        call_delay_s: float = 2.5,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.token_dir = Path(token_dir)
        self.call_delay_s = call_delay_s
        self._sleep = sleep
        self._api: Any = None
        self._last_call_at: float | None = None
        self.calls_made = 0

    # --- connection -------------------------------------------------------

    def resume(self) -> None:
        """Restore a session from stored tokens. Never uses the password."""
        from garminconnect import Garmin  # imported lazily: keeps tests offline

        # An empty directory is the normal case on a fresh volume, and it is not
        # the same as a missing one. Without this check garth falls through to a
        # password login and reports "Username and password are required",
        # which sends you looking at your credentials when the real answer is
        # that the one-time login has never been run.
        if not self.token_dir.exists() or not any(self.token_dir.iterdir()):
            raise GarminAuthError(
                f"no Garmin tokens in {self.token_dir} — the one-time login has "
                "never been completed. Run `ledger garmin-login` from a terminal "
                "(it is interactive and may ask for an MFA code)."
            )
        api = Garmin()
        try:
            api.login(str(self.token_dir))
        except Exception as exc:
            raise GarminAuthError(f"token resume failed: {exc}") from exc
        self._api = api
        log.info("resumed Garmin session from %s", self.token_dir)

    def login_interactive(self, email: str, password: str, mfa_code: str | None = None) -> None:
        """First-run only. Mints tokens from a password.

        Uses `return_on_mfa=True` so an MFA requirement comes back as a value
        rather than a blocking stdin prompt. That distinction matters: without
        it, an account with MFA fails as a bare 401 that is indistinguishable
        from a wrong password, and you burn login attempts finding out.
        """
        from garminconnect import Garmin

        # `return_on_mfa` only exists on newer releases; the pinned 0.2.x line
        # prompts on stdin instead. Try the non-blocking path, fall back.
        try:
            api = Garmin(email=email, password=password, return_on_mfa=True)
        except TypeError:
            api = Garmin(email=email, password=password)
        result = api.login()

        # Older versions return just the client; newer ones a (state, payload).
        state, payload = result if isinstance(result, tuple) else (None, None)

        if state == "needs_mfa":
            if not mfa_code:
                raise GarminMFARequired(
                    "this account has MFA enabled — a one-time code is required"
                )
            api.resume_login(payload, str(mfa_code).strip())

        self.token_dir.mkdir(parents=True, exist_ok=True)
        api.garth.dump(str(self.token_dir))
        self._api = api
        log.info("login succeeded; tokens written to %s", self.token_dir)

    # --- paced calls ------------------------------------------------------

    def _pace(self) -> None:
        if self._last_call_at is None:
            return
        elapsed = time.monotonic() - self._last_call_at
        remaining = self.call_delay_s - elapsed
        if remaining > 0:
            self._sleep(remaining)

    def call(self, method: str, *args: Any, **kwargs: Any) -> Any:
        """Invoke a `garminconnect` method with pacing and backoff.

        Raises GarminRateLimited after the backoff schedule is exhausted. All
        other exceptions propagate — the caller decides whether one bad
        endpoint should abort the whole sync (it should not; see sync.py).
        """
        if self._api is None:
            raise GarminAuthError("not connected; call resume() first")

        fn = getattr(self._api, method, None)
        if fn is None:
            raise AttributeError(f"garminconnect has no method {method!r}")

        attempt = 0
        while True:
            self._pace()
            try:
                result = fn(*args, **kwargs)
            except Exception as exc:
                if _is_rate_limit(exc) and attempt < len(BACKOFF_SCHEDULE):
                    wait = BACKOFF_SCHEDULE[attempt]
                    log.warning(
                        "throttled on %s (attempt %d); backing off %ds",
                        method,
                        attempt + 1,
                        wait,
                    )
                    self._sleep(wait)
                    attempt += 1
                    continue
                self._last_call_at = time.monotonic()
                if _is_rate_limit(exc):
                    raise GarminRateLimited(
                        f"{method}: still throttled after {len(BACKOFF_SCHEDULE)} retries"
                    ) from exc
                raise
            else:
                self._last_call_at = time.monotonic()
                self.calls_made += 1
                return result
