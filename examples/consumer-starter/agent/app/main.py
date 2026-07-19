from contextlib import asynccontextmanager

from ag_ui_langgraph import LangGraphAgent, add_langgraph_fastapi_endpoint
from fastapi import FastAPI
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from .graph import build_graph
from .settings import settings

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
    agent = LangGraphAgent(name="default", graph=build_graph(AsyncPostgresSaver(pool)))
    add_langgraph_fastapi_endpoint(app, agent, "/agent")
    yield
    await pool.close()


app = FastAPI(lifespan=lifespan)


@app.get("/health")
async def health():
    async with pool.connection() as connection:
        await connection.execute("SELECT 1")
    return {"status": "ok"}
