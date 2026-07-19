from __future__ import annotations

from langchain_core.tools import tool
from langgraph.types import interrupt


_WEATHER = {
    "hà nội": {
        "condition": "Có mây",
        "temperatureC": 27,
        "humidityPercent": 78,
        "windKph": 11,
    },
    "đà nẵng": {
        "condition": "Nắng nhẹ",
        "temperatureC": 30,
        "humidityPercent": 70,
        "windKph": 14,
    },
    "phú quốc": {
        "condition": "Mưa rào",
        "temperatureC": 29,
        "humidityPercent": 84,
        "windKph": 18,
    },
    "hồ chí minh": {
        "condition": "Nhiều mây",
        "temperatureC": 31,
        "humidityPercent": 74,
        "windKph": 9,
    },
}


@tool
def get_weather(location: str) -> dict[str, str | int | bool]:
    """Get demo weather for a location. This tool returns hard-coded test data."""
    normalized = " ".join(location.casefold().strip().split())
    weather = _WEATHER.get(normalized, {
        "condition": "Trời quang",
        "temperatureC": 28,
        "humidityPercent": 72,
        "windKph": 10,
    })
    return {
        "location": location.strip(),
        **weather,
        "isDemo": True,
    }


@tool
def request_purchase(item: str, amount_usd: float) -> dict[str, str | float | bool]:
    """Request human approval before purchasing an item. Always use this before a purchase."""
    decision = interrupt({
        "kind": "purchase_approval",
        "message": f"Approve purchasing {item} for ${amount_usd:.2f}?",
        "item": item,
        "amountUsd": amount_usd,
    })
    approved = isinstance(decision, dict) and decision.get("approved") is True
    return {
        "item": item,
        "amountUsd": amount_usd,
        "approved": approved,
        "status": "approved" if approved else "rejected",
    }


TOOLS = [get_weather, request_purchase]
