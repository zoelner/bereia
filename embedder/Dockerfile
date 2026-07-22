FROM python:3.12.8-slim

WORKDIR /app

COPY requirements.txt .
# torch CPU-only instalado antes, do índice próprio, para evitar a build CUDA (~5GB)
RUN pip install --no-cache-dir torch==2.6.0 --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir -r requirements.txt

COPY main.py .

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
