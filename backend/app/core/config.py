from functools import lru_cache
from pathlib import Path
from pydantic import SecretStr, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT=Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config=SettingsConfigDict(env_file=ROOT/'.env',env_prefix='STAR_',extra='ignore')
    database_url:str=Field(repr=False)
    redis_url:str=Field(repr=False)
    jwt_secret:SecretStr=Field(min_length=32)
    token_hours:int=8
    secure_cookies:bool=False
    allowed_origins:str='http://127.0.0.1:5174,http://localhost:5174,http://testserver'
    map_provider:str='auto'
    tianditu_key:SecretStr|None=None
    arcgis_token:SecretStr|None=None


@lru_cache
def settings():return Settings()
