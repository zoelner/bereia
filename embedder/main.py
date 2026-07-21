"""Sidecar de embedding BGE-M3.

Determinismo por build (ADR-005): os vetores sao reprodutiveis para a
combinacao pinada de modelo + revisao HF + dependencias deste container.
A revisao e obrigatoria via env HF_REVISION -- sem ela o processo nao sobe.
"""

import os
from contextlib import asynccontextmanager

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer

MODEL_NAME = os.environ.get("MODEL_NAME", "BAAI/bge-m3")
HF_REVISION = os.environ["HF_REVISION"]  # falha cedo se a revisao nao estiver pinada
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "16"))
TORCH_NUM_THREADS = int(os.environ.get("TORCH_NUM_THREADS", "8"))

torch.set_num_threads(TORCH_NUM_THREADS)

model: SentenceTransformer | None = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    global model
    model = SentenceTransformer(MODEL_NAME, revision=HF_REVISION, device="cpu")
    yield


app = FastAPI(title="bereia-embedder", lifespan=lifespan)


class EmbedRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=512)


class EmbedResponse(BaseModel):
    vectors: list[list[float]]
    model: str
    revision: str
    dimensions: int


@app.post("/embed", response_model=EmbedResponse)
def embed(req: EmbedRequest) -> EmbedResponse:
    if model is None:
        raise HTTPException(status_code=503, detail="model still loading")
    vectors = model.encode(
        req.texts,
        batch_size=BATCH_SIZE,
        normalize_embeddings=True,
        convert_to_numpy=True,
    )
    return EmbedResponse(
        vectors=vectors.tolist(),
        model=MODEL_NAME,
        revision=HF_REVISION,
        dimensions=int(vectors.shape[1]),
    )


@app.get("/health")
def health() -> dict[str, str]:
    return {
        "status": "ok" if model is not None else "loading",
        "model": MODEL_NAME,
        "revision": HF_REVISION,
    }
