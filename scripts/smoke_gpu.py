"""Phase 0 hardware smoke test for BigBox (NVIDIA CUDA, AMD ROCm, or CPU).

Run inside the backend container:
    python scripts/smoke_gpu.py            # device check + tiny matmul
    python scripts/smoke_gpu.py --lora     # also runs 10 LoRA steps on a 0.5B model
    python scripts/smoke_gpu.py --require-gpu   # fail if no GPU is visible

Exits non-zero on the first failure so it can be used in CI / healthchecks.
"""
import argparse
import sys
import time


def step(msg: str) -> None:
    print(f"==> {msg}", flush=True)


def check_torch(require_gpu: bool) -> bool:
    """Returns True if a GPU is usable."""
    import torch

    step(f"torch {torch.__version__}  (cuda={torch.version.cuda}, hip={getattr(torch.version, 'hip', None)})")
    if not torch.cuda.is_available():
        if require_gpu:
            sys.exit("FAIL: no GPU visible to torch (check driver / NVIDIA Container Toolkit)")
        print("    no GPU visible: running on CPU (RAG works; training only for tiny models)")
        return False
    name = torch.cuda.get_device_name(0)
    total = torch.cuda.get_device_properties(0).total_memory / 1024**3
    print(f"    device: {name}  ({total:.1f} GB)")
    print(f"    bf16 supported: {torch.cuda.is_bf16_supported()}")

    step("matmul benchmark (4096x4096 bf16)")
    a = torch.randn(4096, 4096, device="cuda", dtype=torch.bfloat16)
    b = torch.randn(4096, 4096, device="cuda", dtype=torch.bfloat16)
    torch.cuda.synchronize()
    t = time.perf_counter()
    for _ in range(20):
        a @ b
    torch.cuda.synchronize()
    dt = time.perf_counter() - t
    tflops = 20 * 2 * 4096**3 / dt / 1e12
    print(f"    {tflops:.1f} TFLOPS")
    return True


def check_lora(model_id: str, gpu: bool) -> None:
    import torch
    from datasets import Dataset
    from peft import LoraConfig
    from trl import SFTConfig, SFTTrainer

    step(f"LoRA 10 steps on {model_id}")
    ds = Dataset.from_list(
        [{"messages": [{"role": "user", "content": f"What is {i}+{i}?"},
                       {"role": "assistant", "content": str(i + i)}]} for i in range(64)]
    )
    cfg = SFTConfig(
        output_dir="/tmp/smoke_lora",
        max_steps=10,
        per_device_train_batch_size=4,
        learning_rate=2e-4,
        bf16=gpu and torch.cuda.is_bf16_supported(),
        use_cpu=not gpu,
        logging_steps=1,
        report_to=[],
        save_strategy="no",
        gradient_checkpointing=True,
    )
    trainer = SFTTrainer(
        model=model_id,
        args=cfg,
        train_dataset=ds,
        peft_config=LoraConfig(r=8, lora_alpha=16, target_modules="all-linear", task_type="CAUSAL_LM"),
    )
    trainer.train()
    if gpu:
        peak = torch.cuda.max_memory_allocated() / 1024**3
        print(f"    peak VRAM: {peak:.2f} GB")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--lora", action="store_true", help="also run a tiny LoRA training")
    p.add_argument("--require-gpu", action="store_true")
    p.add_argument("--model", default="Qwen/Qwen2.5-0.5B-Instruct")
    args = p.parse_args()

    gpu = check_torch(args.require_gpu)
    if args.lora:
        check_lora(args.model, gpu)
    step("PASS")


if __name__ == "__main__":
    main()
