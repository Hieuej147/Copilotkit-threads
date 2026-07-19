import asyncio

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from .config import settings


async def main() -> None:
    pool = AsyncConnectionPool(
        conninfo=settings.postgres_url,
        kwargs={"autocommit": True, "prepare_threshold": 0, "row_factory": dict_row},
        open=False,
    )
    await pool.open()
    try:
        await AsyncPostgresSaver(pool).setup()
        print("Applied LangGraph checkpoint migrations")
    finally:
        await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
