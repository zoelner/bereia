/** Marcador explícito de esqueleto da Fase 0 — implementação real chega na Fase 1. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} ainda não implementado — Fase 1 (ingestão)`);
    this.name = "NotImplementedError";
  }
}
