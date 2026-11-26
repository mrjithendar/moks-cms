"""Thin clients for LLM providers other than Anthropic (no LiteLLM, no vendor SDKs: httpx only).

An adapter talks to one API shape and nothing else: it does not know the budget, prices, usage rows or tracing. It
returns what the provider said (text, token counts, request id) and the caller books it. Nothing in the service
calls these yet; they are wired in behind the budget guard in a later change.
"""

from .openai_compat import Answer, BadOutput, Endpoint, OpenAICompat, ProviderError

__all__ = ["Answer", "BadOutput", "Endpoint", "OpenAICompat", "ProviderError"]
