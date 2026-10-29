"""Safe Telegram approval protocol tests. No real network or Instagram writes."""
import copy
import os
import unittest
from unittest.mock import patch

from assistant_bot.telegram_control import (
    TelegramReviewError, apply_action, edit_card, handle_update,
    is_authorized, safe_review_item, format_card, menu_keyboard,
)


def item(kind="reply", status="pending", username="viewer_42"):
    return {
        "id": "R0001",
        "kind": kind,
        "status": status,
        "target_username": username,
        "topic": "cinema",
        "situation": "question",
        "original_comment": "Что посмотреть вечером?",
        "proposed_text": "Посмотри драму с сильным финалом. Какой жанр нравится?",
        "media_id": "100",
        "comment_id": "200"
    }


def state(items=None):
    return {"schema_version": 1, "last_update_id": 0, "items": items or [], "decisions": []}


def update(uid="1234", text="/pending", private=True):
    return {
        "update_id": 1,
        "message": {
            "text": text,
            "from": {"id": int(uid)},
            "chat": {"id": int(uid), "type": "private" if private else "group"},
        },
    }


def cb(uid="1234", value="review:R0001:approve"):
    return {
        "update_id": 2,
        "callback_query": {
            "id": "callbackid",
            "data": value,
            "from": {"id": int(uid)},
            "message": {"chat": {"id": int(uid), "type": "private"}},
        },
    }


class TelegramReviewTests(unittest.TestCase):
    def test_cover_studio_button_follows_verified_https_webapp_config(self):
        with patch.dict("os.environ", {"WEBAPP_URL": "https://your-app.vercel.app"}):
            buttons = menu_keyboard()
            covers = [b for row in buttons for b in row if b.get("text") == "🎨 Конструктор обложек"]
            self.assertEqual(covers[0]["web_app"]["url"], "https://your-app.vercel.app/cover-studio/")
        with patch.dict("os.environ", {"WEBAPP_URL": "http://insecure.example"}):
            buttons = menu_keyboard()
            self.assertFalse(any(b.get("web_app") for row in buttons for b in row))

    def test_whitelist_owner_and_require_private_chat(self):
        self.assertTrue(is_authorized(update(), "1234"))
        self.assertFalse(is_authorized(update("4321"), "1234"))
        self.assertFalse(is_authorized(update(private=False), "1234"))
        self.assertFalse(is_authorized(cb("4321"), "1234"))
        self.assertFalse(is_authorized(update(), ""))

    def test_denied_username_remains_denied(self):
        blocked = item(username="@AiKa_St")
        self.assertFalse(safe_review_item(blocked))
        with self.assertRaisesRegex(TelegramReviewError, "prohibited"):
            apply_action(state([blocked]), "R0001", "approve", "1234")

    def test_approval_is_only_recorded_not_executed(self):
        data = state([item()])
        out = handle_update(cb(), data, "1234")
        self.assertEqual(data["items"][0]["status"], "approved")
        self.assertEqual(data["items"][0]["owner_review"]["owner_id"], "1234")
        self.assertEqual(data["decisions"][0]["decision"], "approve")
        self.assertTrue(any(x[0] == "send" for x in out))
        self.assertEqual(len(data["decisions"]), 1)
        self.assertFalse(any(x[0] == "instagram" for x in out))

    def test_duplicate_callback_never_reapproves(self):
        data = state([item()])
        handle_update(cb(), data, "1234")
        response = handle_update(cb(), data, "1234")
        self.assertEqual(len(data["decisions"]), 1)
        self.assertEqual(response[0][0], "ack")

    def test_owner_edit_saves_before_and_after(self):
        data = state([item()])
        handle_update(cb(value="review:R0001:revise"), data, "1234")
        self.assertEqual(data["items"][0]["status"], "needs_revision")
        out = handle_update(update(text="/edit R0001 Другой, более точный ответ"), data, "1234")
        self.assertEqual(data["items"][0]["status"], "pending")
        self.assertEqual(data["items"][0]["proposed_text"], "Другой, более точный ответ")
        self.assertEqual(data["decisions"][-1]["decision"], "edit")
        self.assertEqual(out[0][0], "send")

    def test_unauthorized_actor_cannot_edit(self):
        data = state([item()])
        before = copy.deepcopy(data)
        self.assertEqual(handle_update(update("4321", "/edit R0001 changed"), data, "1234"), [])
        self.assertEqual(data, before)

    def test_no_external_comment_publishing(self):
        data = state([item(kind="external_comment")])
        result = handle_update(cb(), data, "1234")
        self.assertEqual(data["items"][0]["status"], "approved")
        self.assertNotIn("published", str(result))

    def test_status_and_pending_drafts(self):
        data = state([item()])
        self.assertEqual(handle_update(update(text="/pending"), data, "1234")[0][0], "send")
        status = handle_update(update(text="/status"), data, "1234")
        self.assertIn("pending", status[0][2])

    def test_prohibited_callback_is_ignored_for_other_owner(self):
        data = state([item()])
        self.assertEqual(handle_update(cb(uid="4321"), data, "1234"), [])
        self.assertEqual(data["items"][0]["status"], "pending")

    def test_invalid_or_empty_card_fails_closed(self):
        invalid = item()
        invalid["proposed_text"] = ""
        self.assertFalse(safe_review_item(invalid))
        with self.assertRaises(TelegramReviewError):
            apply_action(state([invalid]), "R0001", "approve", "1234")


if __name__ == "__main__":
    unittest.main()


class MiniAppButtonTests(unittest.TestCase):
    def test_menu_has_webapp_button_only_for_https(self):
        from assistant_bot import telegram_control as tc
        old = os.environ.get("WEBAPP_URL")
        try:
            os.environ["WEBAPP_URL"] = "https://your-app.vercel.app/"
            first = tc.menu_keyboard()[0][0]
            self.assertEqual(first["web_app"]["url"], "https://your-app.vercel.app/?section=ig")
            self.assertEqual(tc.menu_keyboard()[0][1]["web_app"]["url"], "https://your-app.vercel.app/?section=tasks")
            os.environ["WEBAPP_URL"] = "http://evil.example"
            self.assertNotIn("web_app", tc.menu_keyboard()[0][0])
            os.environ.pop("WEBAPP_URL")
            self.assertNotIn("web_app", tc.menu_keyboard()[0][0])
        finally:
            if old is None:
                os.environ.pop("WEBAPP_URL", None)
            else:
                os.environ["WEBAPP_URL"] = old


class WebhookModeTests(unittest.TestCase):
    def test_poll_skips_get_updates_when_webhook_set(self):
        from assistant_bot import telegram_control as tc

        class Bot:
            def __init__(self):
                self.calls, self.sent = [], []

            def call(self, method, payload):
                self.calls.append(method)
                return {"url": "https://x.vercel.app/api/bot"} if method == "getWebhookInfo" else []

            def send(self, chat_id, text, keyboard=None):
                self.sent.append(text)

        class Store:
            def __init__(self):
                self.state = {"schema_version": 1, "last_update_id": 5, "decisions": [], "items": [
                    {"id": "R0001", "kind": "post", "status": "pending", "proposed_text": "x"}]}

            def load(self):
                return self.state, "sha"

            def save(self, state, sha):
                return "sha2"

        bot = Bot()
        out = tc.run_poll(bot=bot, store=Store(), owner_id="42")
        self.assertNotIn("getUpdates", bot.calls)
        self.assertEqual(len(bot.sent), 1)
        self.assertIn("webhook mode", out)
