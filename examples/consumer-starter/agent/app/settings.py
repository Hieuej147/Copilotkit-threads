from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    postgres_url: str
    openai_api_key: str = ""
    chat_model: str = "gpt-4.1-mini"


settings = Settings()
