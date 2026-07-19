import asyncio

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from .settings import settings


async def migrate():
    pool = AsyncConnectionPool(
        conninfo=settings.postgres_url,
        kwargs={"autocommit": True, "prepare_threshold": 0, "row_factory": dict_row},
        open=False,
    )
    await pool.open()
    try:
        await AsyncPostgresSaver(pool).setup()
    finally:
        await pool.close()


if __name__ == "__main__":
    asyncio.run(migrate())
