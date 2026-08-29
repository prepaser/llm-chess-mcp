type Request = {
  id: number;
  modelPath: string;
};

function send(value: unknown): void {
  process.send?.(value);
}

process.on("disconnect", () => process.exit(0));
process.on("message", ({ id, modelPath }: Request) => {
  switch (modelPath) {
    case "hang":
      return;
    case "slow":
      setTimeout(() => send({ id, ok: true, logits: new Float32Array([1]) }), 700);
      return;
    case "null":
      send(null);
      return;
    case "bad-error":
      send({ id, ok: false });
      return;
    case "crash":
      process.exit(7);
      return;
    case "env":
      send({
        id,
        ok: true,
        logits: new Float32Array([process.env.LICHESS_TOKEN === undefined ? 1 : -1]),
      });
      return;
    default:
      send({ id, ok: true, logits: new Float32Array([7]) });
  }
});
