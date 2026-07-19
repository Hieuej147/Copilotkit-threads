from __future__ import annotations

import logging
from typing import Any


class HealthCheckAccessFilter(logging.Filter):
    """Keep Kubernetes health probes out of the Uvicorn access log."""

    def filter(self, record: logging.LogRecord) -> bool:
        args: Any = record.args
        return not (
            isinstance(args, tuple)
            and len(args) >= 3
            and args[1] == "GET"
            and str(args[2]).split("?", maxsplit=1)[0] == "/health"
        )


def configure_access_log() -> None:
    logging.getLogger("uvicorn.access").addFilter(HealthCheckAccessFilter())
