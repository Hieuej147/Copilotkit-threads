FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY examples/langgraph-agent/pyproject.toml examples/langgraph-agent/uv.lock ./
RUN pip install --no-cache-dir uv && uv sync --locked --no-dev
COPY examples/langgraph-agent/app ./app
CMD ["/app/.venv/bin/uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
