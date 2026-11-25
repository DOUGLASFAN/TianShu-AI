FROM python:3.12-slim
WORKDIR /workspace
COPY backend/requirements.lock.txt /workspace/requirements.lock.txt
RUN pip install --no-cache-dir -r requirements.lock.txt
COPY backend /workspace/backend
COPY scripts /workspace/scripts
COPY assets/data /workspace/assets/data
COPY alembic.ini /workspace/alembic.ini
EXPOSE 8001
