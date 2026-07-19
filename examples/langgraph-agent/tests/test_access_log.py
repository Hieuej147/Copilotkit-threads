import logging

from app.access_log import HealthCheckAccessFilter


def access_record(method: str, path: str) -> logging.LogRecord:
    return logging.LogRecord(
        name="uvicorn.access",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg='%s - "%s %s HTTP/%s" %d',
        args=("10.42.0.1:12345", method, path, "1.1", 200),
        exc_info=None,
    )


def test_health_probe_is_filtered() -> None:
    assert not HealthCheckAccessFilter().filter(access_record("GET", "/health"))


def test_agent_request_is_preserved() -> None:
    assert HealthCheckAccessFilter().filter(access_record("POST", "/agent"))


def test_other_health_methods_are_preserved() -> None:
    assert HealthCheckAccessFilter().filter(access_record("POST", "/health"))
