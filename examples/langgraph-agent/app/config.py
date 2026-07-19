from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    postgres_url: str = "postgresql://agent:agent@localhost:5432/agent_threads"
    agent_port: int = 8000
    chat_model: str = "gpt-4.1-mini"
    openai_api_key: str | None = None


settings = Settings()
