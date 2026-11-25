from typing import Literal
from pydantic import BaseModel,ConfigDict,Field,field_validator


class Input(BaseModel):
    model_config=ConfigDict(extra='forbid')


class Credentials(Input):
    username:str=Field(min_length=3,max_length=32,pattern=r'^[A-Za-z0-9_]+$')
    password:str=Field(min_length=10,max_length=128)
    @field_validator('username')
    @classmethod
    def normalize(cls,value):return value.lower()


class StationInput(Input):
    name:str=Field(min_length=1,max_length=80)
    latitude:float=Field(ge=-90,le=90,allow_inf_nan=False)
    longitude:float=Field(ge=-180,le=180,allow_inf_nan=False)
    elevation_m:float=Field(default=0,ge=-500,le=10000,allow_inf_nan=False)
    is_default:bool=False
    @field_validator('name')
    @classmethod
    def strip_name(cls,value):
        value=value.strip()
        if not value:raise ValueError('Name required')
        return value


class FavoriteInput(Input):
    noradId:int=Field(gt=0,le=999999999)


class UserStatus(Input):
    enabled:bool


from datetime import datetime

class PredictionInput(Input):
    stationId:str=Field(min_length=36,max_length=36)
    noradId:int=Field(gt=0,le=999999999)
    start:datetime
    days:Literal[1,3,7]=1
    minElevation:float=Field(default=10,ge=0,le=90,allow_inf_nan=False)
    acceptStale:bool=False
    @field_validator('start')
    @classmethod
    def explicit_zone(cls,value):
        if value.tzinfo is None:raise ValueError('Explicit timezone required')
        return value


class GroupPredictionInput(Input):
    stationId:str=Field(min_length=36,max_length=36)
    group:str=Field(min_length=1,max_length=40)
    batch:int=Field(default=1,ge=1)
    size:int=Field(default=100,ge=1,le=500)
    start:datetime
    days:Literal[1,3,7]=1
    minElevation:float=Field(default=10,ge=0,le=90,allow_inf_nan=False)
    acceptStale:bool=False
    expectedNoradIds:list[int]|None=Field(default=None,max_length=500)
    @field_validator('start')
    @classmethod
    def explicit_zone(cls,value):
        if value.tzinfo is None:raise ValueError('Explicit timezone required')
        return value


class PlanInput(Input):
    predictionId:str=Field(min_length=36,max_length=36)
    eventId:str=Field(min_length=1,max_length=48)
    reminderMinutes:Literal[5,10,30]=10
    acceptStale:bool=False


class PlanCancel(Input):
    expectedVersion:int=Field(ge=1)
