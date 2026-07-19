from app import tools
from app.tools import get_weather, request_purchase


def test_weather_tool_returns_hard_coded_phu_quoc_data():
    result = get_weather.invoke({"location": "Phú Quốc"})
    assert result == {
        "location": "Phú Quốc",
        "condition": "Mưa rào",
        "temperatureC": 29,
        "humidityPercent": 84,
        "windKph": 18,
        "isDemo": True,
    }


def test_purchase_tool_resumes_with_human_approval(monkeypatch):
    monkeypatch.setattr(tools, "interrupt", lambda _payload: {"approved": True})
    result = request_purchase.invoke({"item": "Pro plan", "amount_usd": 99})
    assert result == {
        "item": "Pro plan",
        "amountUsd": 99,
        "approved": True,
        "status": "approved",
    }
