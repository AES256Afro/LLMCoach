"""Simulated training run. Exercises the queue, live logs and loss charts
without needing torch or a GPU.

Config: steps (60), delay (0.2s per step), eval_every (10), fail_at (step to crash at, optional).
"""
import math
import random
import time

from .common import parse_context


def main() -> None:
    ctx = parse_context()
    steps = int(ctx.config.get("steps", 60))
    delay = float(ctx.config.get("delay", 0.2))
    eval_every = int(ctx.config.get("eval_every", 10))
    fail_at = ctx.config.get("fail_at")

    print(f"[demo] starting simulated training: {steps} steps", flush=True)
    for step in range(1, steps + 1):
        time.sleep(delay)
        if fail_at is not None and step == int(fail_at):
            raise RuntimeError(f"simulated failure at step {step}")
        loss = 2.5 * math.exp(-step / (steps / 3)) + 0.3 + random.uniform(-0.08, 0.08)
        lr = 2e-4 * min(1.0, step / 5) * (1 - step / (steps + 1))
        ctx.metric(step=step, loss=round(loss, 4), lr=lr)
        ctx.progress(step, steps)
        print(f"step {step:>4}/{steps}  loss={loss:.4f}  lr={lr:.2e}", flush=True)
        if step % eval_every == 0:
            eval_loss = loss + 0.1 + random.uniform(0, 0.05)
            ctx.metric(step=step, eval_loss=round(eval_loss, 4))
            print(f"\x1b[36m[eval] step {step}  eval_loss={eval_loss:.4f}\x1b[0m", flush=True)
    print("\x1b[32m[demo] done\x1b[0m", flush=True)


if __name__ == "__main__":
    main()
