from __future__ import annotations

from langchain_core.messages import BaseMessage, SystemMessage
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.graph import START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode, tools_condition

from .config import settings
from .tools import TOOLS


class AgentState(MessagesState):
    pass


def chat_model() -> ChatOpenAI:
    return ChatOpenAI(model=settings.chat_model, temperature=0.2)


async def chat_node(state: AgentState) -> dict[str, list[BaseMessage]]:
    system = SystemMessage(
        content=(
            "You are a helpful production assistant. Answer the user's request clearly. "
            "Use request_purchase whenever the user asks to buy or purchase something. "
            "Do not discuss internal thread storage or title generation unless asked."
        )
    )
    response = await chat_model().bind_tools(TOOLS).ainvoke([system, *state["messages"]])
    return {"messages": [response]}


def build_graph(checkpointer: AsyncPostgresSaver):
    builder = StateGraph(AgentState)
    builder.add_node("chat", chat_node)
    builder.add_node("tools", ToolNode(TOOLS))
    builder.add_edge(START, "chat")
    builder.add_conditional_edges("chat", tools_condition)
    builder.add_edge("tools", "chat")
    return builder.compile(checkpointer=checkpointer)
