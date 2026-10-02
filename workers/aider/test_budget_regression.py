import unittest

from bridge import CallGuard, StopExecution


class _Usage:
    def model_dump(self):
        return {
            "prompt_tokens": 100,
            "completion_tokens": 20,
            "cost": 0.00012,
        }


class _Response:
    usage = _Usage()


class AiderBudgetRegressionTests(unittest.TestCase):
    def request(self, **overrides):
        request = {
            "model": "openrouter/mock/model",
            "maxSteps": 2,
            "deadline": 9_999_999_999_999,
            "promptPricePerMillion": 1.0,
            "completionPricePerMillion": 1.0,
            "maxTokens": 10_000,
            "maxOutputTokens": 4_096,
            "budgetUsd": 1.0,
            "contextLength": 128_000,
            "baseUrl": "https://openrouter.ai/api/v1",
            "requestTimeoutMs": 5_000,
        }
        request.update(overrides)
        return request

    def ledger(self):
        return {
            "costUsd": 0,
            "tokens": 0,
            "inputTokens": 0,
            "outputTokens": 0,
            "steps": 0,
        }

    def test_pre_dispatch_token_exhaustion_is_koda_budget_failure(self):
        calls = []
        ledger = self.ledger()
        guard = CallGuard(
            self.request(maxTokens=100),
            ledger,
            lambda: None,
            lambda **kwargs: calls.append(kwargs),
            token_counter=lambda **kwargs: 150,
        )

        with self.assertRaises(StopExecution) as raised:
            guard(
                model="openrouter/mock/model",
                messages=[{"role": "user", "content": "edit the file"}],
                max_tokens=4_096,
            )

        self.assertEqual(raised.exception.kind, "budget_exhausted")
        self.assertEqual(calls, [])
        self.assertEqual(ledger["steps"], 0)
        self.assertEqual(ledger["tokens"], 0)

    def test_headroom_allows_provider_dispatch_and_preserves_output(self):
        calls = []
        ledger = self.ledger()

        def completion(**kwargs):
            calls.append(kwargs)
            return _Response()

        guard = CallGuard(
            self.request(maxTokens=6_000),
            ledger,
            lambda: None,
            completion,
            token_counter=lambda **kwargs: 1_000,
        )

        response = guard(
            model="openrouter/mock/model",
            messages=[{"role": "user", "content": "edit the file"}],
            max_tokens=4_096,
        )

        self.assertIsInstance(response, _Response)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["max_tokens"], 4_096)
        self.assertEqual(ledger["inputTokens"], 100)
        self.assertEqual(ledger["outputTokens"], 20)


if __name__ == "__main__":
    unittest.main()
