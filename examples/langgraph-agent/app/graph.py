from __future__ import annotations

import json
from typing import Annotated, Any, TypedDict

from langchain_core.messages import (
    AIMessage,
    AnyMessage,
    SystemMessage,
    ToolMessage,
)
from langgraph.graph.message import add_messages
from langchain_openai import ChatOpenAI
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.graph import END, START, StateGraph
from langgraph.prebuilt import ToolNode

from .config import settings
from .tools import TOOLS


AgentState = TypedDict(
    "AgentState",
    {
        "messages": Annotated[list[AnyMessage], add_messages],
        "tools": list[dict[str, Any]],
        "copilotkit": dict[str, Any],
        "ag-ui": dict[str, Any],
    },
    total=False,
)


def chat_model() -> ChatOpenAI:
    return ChatOpenAI(model=settings.chat_model, temperature=0.2)


def repair_tool_history(messages: list[AnyMessage]) -> list[AnyMessage]:
    """Normalize checkpoint history to valid assistant/tool message groups."""
    repaired: list[AnyMessage] = []
    index = 0
    while index < len(messages):
        message = messages[index]
        if isinstance(message, ToolMessage):
            # A checkpoint/client merge can retain a result after its assistant
            # tool-call message was replaced. OpenAI rejects that orphan result.
            index += 1
            continue

        repaired.append(message)
        if not isinstance(message, AIMessage) or not message.tool_calls:
            index += 1
            continue

        calls = {call.get("id"): call for call in message.tool_calls if call.get("id")}
        answered_ids: set[str] = set()
        index += 1
        while index < len(messages) and isinstance(messages[index], ToolMessage):
            result = messages[index]
            if result.tool_call_id in calls and result.tool_call_id not in answered_ids:
                repaired.append(result)
                answered_ids.add(result.tool_call_id)
            index += 1

        for call_id in calls:
            if call_id not in answered_ids:
                repaired.append(
                    ToolMessage(
                        content="Tool execution was interrupted before completion.",
                        tool_call_id=call_id,
                    )
                )
    return repaired


def json_safe(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return json_safe(value.model_dump(mode="json"))
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    return value


async def chat_node(state: AgentState, config: RunnableConfig) -> dict[str, Any]:
    frontend_tools = state.get("tools", [])
    ag_ui_state = json_safe(state.get("ag-ui", {}))
    context = state.get("copilotkit", {}).get("context", [])
    if not context:
        context = ag_ui_state.get("context", [])
    system = SystemMessage(
        content=(
            "You are a helpful production assistant. Answer the user's request clearly. "
            "Use exactly one relevant tool at a time. Use get_weather for weather, "
            "get_demo_server_time for demo server time, and request_purchase for purchases. "
            "When available, use show_demo_profile to display a requested demo profile, "
            "set_demo_accent to change the demo accent, and confirm_demo_export before a demo export. "
            "Do not discuss internal thread storage or title generation unless asked. "
            f"Current application context: {json.dumps(context, ensure_ascii=False, default=str)}"
        )
    )
    messages = repair_tool_history(state["messages"])
    response = await chat_model().bind_tools([*TOOLS, *frontend_tools]).ainvoke(
        [system, *messages], config
    )
    return {"messages": [response], "ag-ui": ag_ui_state}


def route_after_chat(state: AgentState) -> str:
    last_message = state["messages"][-1]
    if not isinstance(last_message, AIMessage) or not last_message.tool_calls:
        return END
    backend_names = {tool.name for tool in TOOLS}
    if all(call.get("name") in backend_names for call in last_message.tool_calls):
        return "tools"
    # Frontend tools execute in CopilotKit after this graph run finishes. Their
    # result starts a follow-up run with the matching ToolMessage.
    return END


def build_graph(checkpointer: AsyncPostgresSaver):
    builder = StateGraph(AgentState)
    builder.add_node("chat", chat_node)
    builder.add_node("tools", ToolNode(TOOLS))
    builder.add_edge(START, "chat")
    builder.add_conditional_edges("chat", route_after_chat, {"tools": "tools", END: END})
    builder.add_edge("tools", "chat")
    return builder.compile(checkpointer=checkpointer)
