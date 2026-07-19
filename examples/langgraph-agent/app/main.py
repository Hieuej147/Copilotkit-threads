from __future__ import annotations

from contextlib import asynccontextmanager

from ag_ui_langgraph import LangGraphAgent, add_langgraph_fastapi_endpoint
from fastapi import FastAPI
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from .access_log import configure_access_log
from .config import settings
from .graph import build_graph


configure_access_log()

pool = AsyncConnectionPool(
    conninfo=settings.postgres_url,
    kwargs={"autocommit": True, "prepare_threshold": 0, "row_factory": dict_row},
    min_size=1,
    max_size=20,
    open=False,
)
@asynccontextmanager
async def lifespan(app: FastAPI):
    await pool.open()
    checkpointer = AsyncPostgresSaver(pool)
    graph = build_graph(checkpointer)
    agent = LangGraphAgent(name="default", graph=graph, description="Self-hosted LangGraph agent")
    add_langgraph_fastapi_endpoint(app, agent, "/agent")
    yield
    await pool.close()


app = FastAPI(title="CopilotKit Threads Agent", version="0.1.0", lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, str]:
    async with pool.connection() as connection:
        await connection.execute("SELECT 1")
    return {"status": "ok"}
