"""Run a fine-tuned LoRA adapter directly with transformers + PEFT (inside a worker process).

This is how a fine-tune is evaluated right after training, before any export to Ollama.
"""
from __future__ import annotations

import json
import re
import time

from ..config import settings

_THINK = re.compile(r"<think>.*?</think>", re.S)


def strip_thinking(text: str) -> str:
    """Drops a reasoning model's <think>...</think> block (and one cut off by max_new_tokens):
    only the answer should be scored."""
    text = _THINK.sub("", text)
    if "<think>" in text:
        text = text[:text.index("<think>")]
    return text.strip()


class LocalModel:
    def __init__(self, base_model: str, adapter_dir: str | None) -> None:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer

        self.torch = torch
        cuda = torch.cuda.is_available()
        token = settings.hf_token or None
        dtype = (torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16) if cuda else torch.float32
        self.tokenizer = AutoTokenizer.from_pretrained(adapter_dir or base_model, token=token)
        if self.tokenizer.pad_token is None:
            self.tokenizer.pad_token = self.tokenizer.eos_token
        model = AutoModelForCausalLM.from_pretrained(base_model, dtype=dtype, token=token)
        if adapter_dir:
            from peft import PeftModel
            model = PeftModel.from_pretrained(model, adapter_dir)
        self.model = model.to("cuda" if cuda else "cpu").eval()

    def generate(self, messages: list[dict], max_new_tokens: int = 256) -> dict:
        started = time.perf_counter()
        kw = dict(add_generation_prompt=True, return_tensors="pt", return_dict=True)
        try:
            # Qwen3's template thinks by default; the reasoning would be scored as part of the answer.
            inputs = self.tokenizer.apply_chat_template(messages, enable_thinking=False, **kw)
        except TypeError:  # older tokenizers without template kwargs
            inputs = self.tokenizer.apply_chat_template(messages, **kw)
        inputs = inputs.to(self.model.device)
        with self.torch.no_grad():
            out = self.model.generate(**inputs, max_new_tokens=max_new_tokens, do_sample=False,
                                      pad_token_id=self.tokenizer.pad_token_id)
        new = out[0][inputs["input_ids"].shape[1]:]
        text = strip_thinking(self.tokenizer.decode(new, skip_special_tokens=True))
        seconds = time.perf_counter() - started
        return {"content": text, "stats": {"completion_tokens": len(new), "total_ms": round(seconds * 1000),
                                           "tokens_per_sec": round(len(new) / seconds, 1) if seconds else None}}


def load_finetune(ft) -> LocalModel:
    adapter = settings.data_dir / ft.output_dir
    if not (adapter / "adapter_config.json").exists():
        raise FileNotFoundError(f"adapter files for fine-tune {ft.id} are missing")
    base = ft.base_model or json.loads((adapter / "adapter_config.json").read_text()).get("base_model_name_or_path")
    return LocalModel(base, str(adapter))
