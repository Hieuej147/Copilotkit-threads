from langchain_core.messages import SystemMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import START, MessagesState, StateGraph

from .settings import settings


async def chat(state: MessagesState):
    model = ChatOpenAI(model=settings.chat_model, temperature=0.2)
    message = await model.ainvoke([
        SystemMessage(content="You are a concise assistant."),
        *state["messages"],
    ])
    return {"messages": [message]}


def build_graph(checkpointer):
    graph = StateGraph(MessagesState)
    graph.add_node("chat", chat)
    graph.add_edge(START, "chat")
    return graph.compile(checkpointer=checkpointer)
