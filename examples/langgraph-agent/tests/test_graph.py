from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.graph import END

from app.graph import json_safe, repair_tool_history, route_after_chat


def test_backend_tool_call_routes_to_tool_node():
    message = AIMessage(
        content="",
        tool_calls=[{"name": "get_weather", "args": {"location": "Phú Quốc"}, "id": "1"}],
    )
    assert route_after_chat({"messages": [message]}) == "tools"


def test_frontend_tool_call_finishes_for_browser_execution():
    message = AIMessage(
        content="",
        tool_calls=[{"name": "set_demo_accent", "args": {"accent": "coral"}, "id": "2"}],
    )
    assert route_after_chat({"messages": [message]}) == END


def test_orphan_frontend_tool_call_is_repaired_before_next_user_message():
    messages = [
        AIMessage(
            content="",
            tool_calls=[{"name": "set_demo_accent", "args": {}, "id": "orphan"}],
        ),
        HumanMessage(content="continue"),
    ]

    repaired = repair_tool_history(messages)

    assert isinstance(repaired[1], ToolMessage)
    assert repaired[1].tool_call_id == "orphan"
    assert repaired[2] is messages[1]


def test_answered_tool_call_is_not_duplicated():
    messages = [
        AIMessage(
            content="",
            tool_calls=[{"name": "set_demo_accent", "args": {}, "id": "answered"}],
        ),
        ToolMessage(content="done", tool_call_id="answered"),
        HumanMessage(content="continue"),
    ]

    assert repair_tool_history(messages) == messages


def test_orphan_tool_result_is_removed():
    messages = [
        HumanMessage(content="before"),
        ToolMessage(content="orphaned", tool_call_id="missing-call"),
        HumanMessage(content="continue"),
    ]

    assert repair_tool_history(messages) == [messages[0], messages[2]]


def test_context_models_are_converted_to_plain_json():
    class ContextValue:
        def model_dump(self, *, mode: str):
            assert mode == "json"
            return {"description": "Current page", "value": {"tab": "hooks"}}

    assert json_safe({"context": [ContextValue()]}) == {
        "context": [{"description": "Current page", "value": {"tab": "hooks"}}]
    }
