# Instagram Manager · бот и мини-приложение

Telegram-бот и мини-приложение для ведения Instagram: ИИ пишет посты, карусели и Reels, ты согласовываешь текст и финал в Telegram, робот публикует. Конструктор обложек, поиск кадров, аналитика, обучение на твоих правках.

Работает в паре с движком **insta-engine** (второй шаблон). Всё на бесплатных тарифах: Vercel, GitHub, Groq, Instagram API.

## Установка
Пошаговый гайд со ссылками и разбором частых ошибок: **[setup-guide.pdf](guide/setup-guide.pdf)**

Коротко:
1. Создай бота в @BotFather
2. Нажми **Use this template** → создай приватную копию `assistant-bot` (и `insta-engine` из второго шаблона)
3. Импортируй `assistant-bot` в Vercel и добавь переменные окружения из гайда
4. Открой `https://ТВОЙ-ДОМЕН.vercel.app/api/bot?install=ТВОЙ_TG_WEBHOOK_SECRET`

Ключи храни только в Vercel и GitHub Secrets. Лицензия MIT.
